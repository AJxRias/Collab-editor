import { createApp, type App } from "../src/app.js";
import type { Bus } from "../src/bus/types.js";
import { LocalBus } from "../src/bus/local.js";
import { loadConfig, type Config } from "../src/config.js";
import { MemoryStore } from "../src/store/memory.js";
import type { Store } from "../src/store/types.js";
import { SyncClient } from "../src/sync-client.js";

export interface TestServer {
  app: App;
  port: number;
  url: string;
  http: string;
  config: Config;
  store: Store;
}

let counter = 0;

export async function startServer(
  opts: { store?: Store; bus?: Bus; config?: Partial<Config> } = {},
): Promise<TestServer> {
  const config: Config = {
    ...loadConfig({}),
    instanceId: `test-${++counter}`,
    persistDebounceMs: 20,
    persistMaxWaitMs: 100,
    roomIdleMs: 50,
    heartbeatMs: 60_000,
    apiWritesPerMin: 10_000,
    ...opts.config,
  };
  const store = opts.store ?? new MemoryStore();
  const app = createApp({ store, bus: opts.bus ?? new LocalBus(), config });
  const port = await app.listen(0);
  return { app, port, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}`, config, store };
}

const clients: SyncClient[] = [];

/** Connect a client, creating the document first (sockets can't create documents). */
export async function connect(server: TestServer, docId: string): Promise<SyncClient> {
  await server.store.ensureDoc(docId);
  const client = new SyncClient(server.url, docId);
  clients.push(client);
  await client.connect();
  return client;
}

export function newClient(server: TestServer, docId: string): SyncClient {
  const client = new SyncClient(server.url, docId);
  clients.push(client);
  return client;
}

export async function cleanupClients(): Promise<void> {
  await Promise.all(clients.splice(0).map((c) => c.destroy()));
}

/** Poll until `fn` returns a truthy value or time runs out. */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 3000, label = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function api<T = unknown>(
  server: TestServer,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: T }> {
  const res = await fetch(server.http + path, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}
