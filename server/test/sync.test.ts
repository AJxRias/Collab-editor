import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { MemoryStore } from "../src/store/memory.js";
import { cleanupClients, connect, newClient, sleep, startServer, waitFor, type TestServer } from "./helpers.js";

const servers: TestServer[] = [];
const start = async (...args: Parameters<typeof startServer>) => {
  const s = await startServer(...args);
  servers.push(s);
  return s;
};

afterEach(async () => {
  await cleanupClients();
  await Promise.all(servers.splice(0).map((s) => s.app.close()));
});

describe("sync", () => {
  it("converges when two clients edit concurrently", async () => {
    const server = await start();
    const a = await connect(server, "doc1");
    const b = await connect(server, "doc1");

    a.doc.getText("t").insert(0, "hello ");
    b.doc.getText("t").insert(0, "world");

    await waitFor(
      () => a.doc.getText("t").toString() === b.doc.getText("t").toString() && a.doc.getText("t").length === 11,
      3000,
      "convergence",
    );
    expect(a.doc.getText("t").toString()).toBe(b.doc.getText("t").toString());
    expect(a.doc.getText("t").toString()).toContain("hello");
    expect(a.doc.getText("t").toString()).toContain("world");
  });

  it("gives a late joiner the existing state", async () => {
    const server = await start();
    const a = await connect(server, "doc2");
    a.doc.getText("t").insert(0, "already here");
    await waitFor(() => server.app.metrics.messagesIn > 2, 3000, "server to receive edit");

    const late = await connect(server, "doc2");
    expect(late.doc.getText("t").toString()).toBe("already here");
  });

  it("keeps documents isolated from one another", async () => {
    const server = await start();
    const a = await connect(server, "docA");
    const b = await connect(server, "docB");
    a.doc.getText("t").insert(0, "only in A");
    await sleep(100);
    expect(b.doc.getText("t").toString()).toBe("");
  });

  it("merges edits made while offline when the client reconnects", async () => {
    const server = await start();
    const online = await connect(server, "doc3");
    const offline = await connect(server, "doc3");
    online.doc.getText("t").insert(0, "base");
    await waitFor(() => offline.doc.getText("t").toString() === "base", 3000, "initial sync");

    await offline.disconnect();
    // Both sides edit while disconnected from each other.
    offline.doc.getText("t").insert(4, " +offline");
    online.doc.getText("t").insert(0, "online+ ");
    await sleep(50);

    await offline.connect();
    await waitFor(
      () => online.doc.getText("t").toString() === offline.doc.getText("t").toString(),
      3000,
      "post-reconnect convergence",
    );
    const merged = online.doc.getText("t").toString();
    expect(merged).toContain("online+");
    expect(merged).toContain("+offline");
    expect(merged).toContain("base");
  });

  it("survives a malformed message without dropping other clients", async () => {
    const server = await start();
    const good = await connect(server, "doc4");
    const { WebSocket } = await import("ws");
    const bad = new WebSocket(`${server.url}/ws/doc4`);
    await new Promise((r) => bad.once("open", r));
    bad.send(Buffer.from([0, 99, 1, 2, 3]));
    await new Promise((r) => bad.once("close", r));

    good.doc.getText("t").insert(0, "still works");
    const other = await connect(server, "doc4");
    await waitFor(() => other.doc.getText("t").toString() === "still works", 3000, "edit after bad client");
  });

  it("rejects websocket paths that are not /ws/<id>", async () => {
    const server = await start();
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`${server.url}/nope`);
    const result = await new Promise<string>((resolve) => {
      ws.once("error", () => resolve("error"));
      ws.once("open", () => resolve("open"));
    });
    expect(result).toBe("error");
  });
});

describe("presence", () => {
  it("shares awareness state and clears it when a client leaves", async () => {
    const server = await start();
    const a = await connect(server, "p1");
    const b = await connect(server, "p1");
    a.awareness.setLocalStateField("user", { name: "Ada" });

    await waitFor(() => b.awareness.getStates().get(a.doc.clientID)?.user, 3000, "presence to arrive");
    expect(b.awareness.getStates().get(a.doc.clientID)?.user).toEqual({ name: "Ada" });

    await a.disconnect();
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID), 3000, "presence to clear");
  });
});

describe("persistence", () => {
  it("persists edits and restores them after a server restart", async () => {
    const store = new MemoryStore();
    const first = await start({ store });
    const a = await connect(first, "persist1");
    a.doc.getText("t").insert(0, "durable");
    await waitFor(() => store.countUpdates("persist1") > 0, 3000, "edit to be persisted");
    await a.destroy();
    await first.app.close();

    const second = await start({ store });
    const b = await connect(second, "persist1");
    expect(b.doc.getText("t").toString()).toBe("durable");
  });

  it("flushes unsaved edits when the last client leaves", async () => {
    const store = new MemoryStore();
    // Debounce far longer than the test: only the close-time flush can save this.
    const server = await start({ store, config: { persistDebounceMs: 60_000, persistMaxWaitMs: 60_000, roomIdleMs: 20 } });
    const a = await connect(server, "persist2");
    a.doc.getText("t").insert(0, "saved on close");
    await waitFor(() => server.app.metrics.messagesIn >= 3, 3000, "server to receive edit");
    expect(store.countUpdates("persist2")).toBe(0);

    await a.disconnect();
    await waitFor(() => store.countUpdates("persist2") > 0, 3000, "close-time flush");

    const check = new Y.Doc();
    for (const u of await store.loadUpdates("persist2")) Y.applyUpdate(check, u);
    expect(check.getText("t").toString()).toBe("saved on close");
  });

  it("batches rapid edits into far fewer writes than keystrokes", async () => {
    const store = new MemoryStore();
    const server = await start({ store, config: { persistDebounceMs: 100, persistMaxWaitMs: 1000 } });
    const a = await connect(server, "persist3");
    for (let i = 0; i < 50; i++) a.doc.getText("t").insert(i, "x");
    await waitFor(() => store.countUpdates("persist3") > 0, 3000, "flush");
    await sleep(200);
    expect(store.countUpdates("persist3")).toBeLessThanOrEqual(3);
  });

  it("compacts the update log without losing content", async () => {
    const store = new MemoryStore();
    const server = await start({ store, config: { compactEvery: 4, persistDebounceMs: 5, persistMaxWaitMs: 20 } });
    const a = await connect(server, "persist4");
    for (let i = 0; i < 12; i++) {
      a.doc.getText("t").insert(a.doc.getText("t").length, `line${i};`);
      await sleep(40); // let each edit flush separately
    }
    await waitFor(() => server.app.metrics.compactions > 0, 3000, "compaction");
    await sleep(60);
    expect(store.countUpdates("persist4")).toBeLessThan(12);

    const check = new Y.Doc();
    for (const u of await store.loadUpdates("persist4")) Y.applyUpdate(check, u);
    const expected = Array.from({ length: 12 }, (_, i) => `line${i};`).join("");
    expect(check.getText("t").toString()).toBe(expected);
  });

  it("evicts idle rooms from memory", async () => {
    const server = await start({ config: { roomIdleMs: 30 } });
    const a = await connect(server, "evict1");
    expect(server.app.rooms.openRooms).toBe(1);
    await a.destroy();
    await waitFor(() => server.app.rooms.openRooms === 0, 3000, "room eviction");
  });

  it("reopens a room cleanly right after it was evicted", async () => {
    const store = new MemoryStore();
    const server = await start({ store, config: { roomIdleMs: 10, persistDebounceMs: 60_000, persistMaxWaitMs: 60_000 } });
    for (let i = 0; i < 5; i++) {
      const c = await connect(server, "churn");
      c.doc.getText("t").insert(c.doc.getText("t").length, `${i}`);
      await sleep(30);
      await c.destroy();
      await sleep(40);
    }
    const last = await connect(server, "churn");
    expect(last.doc.getText("t").toString()).toBe("01234");
  });
});

describe("misc", () => {
  it("handles many clients on one document", async () => {
    const server = await start();
    const clients = await Promise.all(Array.from({ length: 25 }, () => connect(server, "crowd")));
    clients.forEach((c, i) => c.doc.getArray<string>("a").push([`c${i}`]));
    await waitFor(() => clients.every((c) => c.doc.getArray("a").length === 25), 5000, "all edits to reach everyone");
  });

  it("exposes health and metrics", async () => {
    const server = await start();
    const health = await fetch(`${server.http}/api/health`).then((r) => r.json());
    expect(health).toMatchObject({ ok: true });
    await connect(server, "m1");
    const metrics = await fetch(`${server.http}/api/metrics`).then((r) => r.json());
    expect(metrics).toMatchObject({ connections: 1, openRooms: 1 });
  });
});

// newClient is exported for ad-hoc tests; referenced to keep the import used.
void newClient;

describe("hardening", () => {
  it("refuses sockets for documents that do not exist", async () => {
    const server = await start();
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`${server.url}/ws/never-created`);
    const code = await new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
    expect(code).toBe(4404);
    expect(await server.store.getDoc("never-created")).toBeNull();
  });

  it("closes a socket that floods messages, without affecting others", async () => {
    const server = await start({ config: { wsMessagesPerSec: 10, wsMessageBurst: 20 } });
    const calm = await connect(server, "flood");
    const noisy = await connect(server, "flood");
    for (let i = 0; i < 100; i++) noisy.doc.getArray("a").push([i]);
    await waitFor(() => !noisy.connected, 3000, "noisy client to be dropped");
    expect(server.app.metrics.rateLimited).toBeGreaterThan(0);
    expect(calm.connected).toBe(true);
  });

  it("rate-limits document creation per IP", async () => {
    const server = await start({ config: { apiWritesPerMin: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${server.http}/api/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses).toContain(429);
  });

  it("can turn off the document listing", async () => {
    const server = await start({ config: { listDocs: false } });
    expect((await fetch(`${server.http}/api/docs`)).status).toBe(404);
  });
});

describe("titles", () => {
  it("syncs a title change live and mirrors it to the documents table", async () => {
    const server = await start();
    const a = await connect(server, "titled");
    const b = await connect(server, "titled");
    a.doc.getMap("meta").set("title", "Launch plan");
    await waitFor(() => b.doc.getMap("meta").get("title") === "Launch plan", 3000, "live title");
    await waitFor(async () => (await server.store.getDoc("titled"))?.title === "Launch plan", 3000, "stored title");
  });

  it("pushes a rename made through the API into open editors", async () => {
    const server = await start();
    const a = await connect(server, "renamed");
    const res = await fetch(`${server.http}/api/docs/renamed`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "From the API" }),
    });
    expect(res.status).toBe(200);
    await waitFor(() => a.doc.getMap("meta").get("title") === "From the API", 3000, "title in editor");
  });
});
