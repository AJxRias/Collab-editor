import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  /** Unique per process; used to ignore our own messages on the bus. Max 255 bytes. */
  instanceId: string;
  /** Wait this long after the last edit before writing to the store. */
  persistDebounceMs: number;
  /** ...but never hold unsaved edits longer than this. */
  persistMaxWaitMs: number;
  /** Merge the update log into a single row once it has this many rows. */
  compactEvery: number;
  /** Keep an empty room in memory this long before flushing and freeing it. */
  roomIdleMs: number;
  heartbeatMs: number;
  /** Largest single WebSocket message accepted, in bytes. */
  maxMessageBytes: number;
  /** Per-connection message budget: sustained rate and burst size. Exceeding it closes the socket. */
  wsMessagesPerSec: number;
  wsMessageBurst: number;
  /** Per-IP budget for write endpoints (create document, save/restore version). */
  apiWritesPerMin: number;
  /** Whether GET /api/docs lists every document. Off for public deployments. */
  listDocs: boolean;
  /** Express "trust proxy" setting, needed behind a load balancer for per-IP limits. */
  trustProxy: boolean | number;
  /** Serve the built client from this directory (single-service deployments). */
  staticDir?: string;
  databaseUrl?: string;
  redisUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
    return n;
  };
  const bool = (key: string, fallback: boolean) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  };
  const trustRaw = env.TRUST_PROXY;
  const trustProxy =
    trustRaw === undefined || trustRaw === "" ? false : /^\d+$/.test(trustRaw) ? Number(trustRaw) : bool("TRUST_PROXY", false);

  return {
    port: num("PORT", 4000),
    instanceId: env.INSTANCE_ID || `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`,
    persistDebounceMs: num("PERSIST_DEBOUNCE_MS", 400),
    persistMaxWaitMs: num("PERSIST_MAX_WAIT_MS", 2000),
    compactEvery: num("COMPACT_EVERY", 100),
    roomIdleMs: num("ROOM_IDLE_MS", 10_000),
    heartbeatMs: num("HEARTBEAT_MS", 30_000),
    maxMessageBytes: num("MAX_MESSAGE_BYTES", 1024 * 1024),
    wsMessagesPerSec: num("WS_MESSAGES_PER_SEC", 100),
    wsMessageBurst: num("WS_MESSAGE_BURST", 400),
    apiWritesPerMin: num("API_WRITES_PER_MIN", 60),
    listDocs: bool("LIST_DOCS", env.NODE_ENV !== "production"),
    trustProxy,
    staticDir: env.STATIC_DIR || undefined,
    databaseUrl: env.DATABASE_URL || undefined,
    redisUrl: env.REDIS_URL || undefined,
  };
}
