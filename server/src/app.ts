import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import * as Y from "yjs";
import { WebSocketServer, type WebSocket } from "ws";
import type { Bus } from "./bus/types.js";
import type { Config } from "./config.js";
import { META, TITLE_KEY, replaceContent, snapshotToText } from "./content.js";
import { Metrics } from "./metrics.js";
import { KeyedRateLimiter } from "./rate-limit.js";
import { RoomManager } from "./rooms.js";
import type { Store } from "./store/types.js";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

function docId(req: Request): string {
  const id = req.params.id;
  if (!id || !ID_RE.test(id)) throw new HttpError(400, "invalid document id");
  return id;
}

function versionId(req: Request): number {
  const n = Number(req.params.vid);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, "invalid version id");
  return n;
}

function text(value: unknown, field: string, max: number, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${field} is required`);
  if (value.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return value.trim();
}

export interface AppOptions {
  store: Store;
  bus: Bus;
  config: Config;
}

export interface App {
  server: Server;
  rooms: RoomManager;
  metrics: Metrics;
  /** Start listening; resolves with the bound port (useful with port 0). */
  listen(port?: number): Promise<number>;
  close(): Promise<void>;
}

export function createApp({ store, bus, config }: AppOptions): App {
  const metrics = new Metrics();
  const rooms = new RoomManager(store, bus, config, metrics);

  const writeLimiter = new KeyedRateLimiter(config.apiWritesPerMin / 60, Math.max(1, config.apiWritesPerMin));

  const api = express();
  api.disable("x-powered-by");
  api.set("trust proxy", config.trustProxy);
  api.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  api.use("/api", cors());
  api.use(express.json({ limit: "100kb" }));

  /** Throttle endpoints that write to the database, per client IP. */
  const limitWrites = (req: Request, res: Response, next: NextFunction) => {
    if (writeLimiter.take(req.ip ?? "unknown")) return next();
    metrics.rateLimited++;
    res.setHeader("Retry-After", "10");
    res.status(429).json({ error: "too many requests, slow down" });
  };

  api.get("/api/health", (_req, res) => {
    res.json({ ok: true, instance: config.instanceId });
  });

  api.get("/api/metrics", (_req, res) => {
    res.json(metrics.snapshot({ instance: config.instanceId, openRooms: rooms.openRooms }));
  });

  api.get(
    "/api/docs",
    wrap(async (_req, res) => {
      // On a public deployment, listing would expose everyone's documents to everyone.
      if (!config.listDocs) throw new HttpError(404, "document listing is disabled");
      res.json(await store.listDocs());
    }),
  );

  api.post(
    "/api/docs",
    limitWrites,
    wrap(async (req, res) => {
      const title = text(req.body?.title, "title", 200, "Untitled");
      const id = randomBytes(6).toString("base64url");
      res.status(201).json(await store.createDoc(id, title));
    }),
  );

  api.get(
    "/api/docs/:id",
    wrap(async (req, res) => {
      const doc = await store.getDoc(docId(req));
      if (!doc) throw new HttpError(404, "document not found");
      res.json(doc);
    }),
  );

  api.patch(
    "/api/docs/:id",
    wrap(async (req, res) => {
      const id = docId(req);
      const title = text(req.body?.title, "title", 200);
      const doc = await store.renameDoc(id, title);
      if (!doc) throw new HttpError(404, "document not found");
      // Also write it into the live doc, so open editors show the new title immediately.
      await rooms.use(id, (room) => room.doc.getMap(META).set(TITLE_KEY, title));
      res.json(doc);
    }),
  );

  api.get(
    "/api/docs/:id/versions",
    wrap(async (req, res) => {
      const id = docId(req);
      if (!(await store.getDoc(id))) throw new HttpError(404, "document not found");
      res.json(await store.listVersions(id));
    }),
  );

  api.post(
    "/api/docs/:id/versions",
    limitWrites,
    wrap(async (req, res) => {
      const id = docId(req);
      if (!(await store.getDoc(id))) throw new HttpError(404, "document not found");
      const label = text(req.body?.label, "label", 100, `Saved ${new Date().toISOString()}`);
      // Snapshot the live state, which includes edits that have not reached the store yet.
      const snapshot = await rooms.use(id, (room) => Y.encodeStateAsUpdate(room.doc));
      res.status(201).json(await store.saveVersion(id, label, snapshot));
    }),
  );

  api.get(
    "/api/docs/:id/versions/:vid/preview",
    wrap(async (req, res) => {
      const version = await store.getVersion(docId(req), versionId(req));
      if (!version) throw new HttpError(404, "version not found");
      res.json({ ...version.meta, text: snapshotToText(version.snapshot) });
    }),
  );

  api.post(
    "/api/docs/:id/versions/:vid/restore",
    limitWrites,
    wrap(async (req, res) => {
      const id = docId(req);
      const version = await store.getVersion(id, versionId(req));
      if (!version) throw new HttpError(404, "version not found");
      // Applied to the live doc, so every connected client (on any instance) sees it at once.
      await rooms.use(id, (room) => replaceContent(room.doc, version.snapshot));
      res.json({ restored: version.meta });
    }),
  );

  api.use("/api", (_req, _res, next) => next(new HttpError(404, "not found")));

  // Single-service deployments: serve the built client and fall back to index.html.
  if (config.staticDir) {
    const dir = resolve(config.staticDir);
    if (!existsSync(resolve(dir, "index.html"))) throw new Error(`STATIC_DIR ${dir} has no index.html`);
    api.use(express.static(dir, { index: false, maxAge: "1h" }));
    api.get("*", (_req, res) => res.sendFile(resolve(dir, "index.html"), { maxAge: 0 }));
  }

  api.use((_req, _res, next) => next(new HttpError(404, "not found")));
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof SyntaxError) {
      res.status(400).json({ error: "invalid JSON" });
    } else {
      console.error("[http]", err);
      res.status(500).json({ error: "internal error" });
    }
  });

  const server = createServer(api);
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/ws\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      void rooms.attach(match[1]!, ws);
    });
  });

  // Drop connections that stop answering pings (laptop lid closed, NAT timeout, ...).
  const alive = new WeakSet<WebSocket>();
  wss.on("connection", (ws: WebSocket) => {
    metrics.connections++;
    metrics.totalConnections++;
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    ws.on("close", () => {
      metrics.connections--;
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  return {
    server,
    rooms,
    metrics,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => resolve((server.address() as AddressInfo).port));
      });
    },
    async close() {
      clearInterval(heartbeat);
      writeLimiter.close();
      for (const ws of wss.clients) ws.close(1001, "server shutting down");
      await rooms.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
