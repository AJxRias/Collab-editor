import { createApp } from "./app.js";
import { LocalBus } from "./bus/local.js";
import { RedisBus } from "./bus/redis.js";
import type { Bus } from "./bus/types.js";
import { loadConfig } from "./config.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import type { Store } from "./store/types.js";

async function main() {
  const config = loadConfig();

  let store: Store;
  if (config.databaseUrl) {
    store = new PostgresStore(config.databaseUrl);
  } else {
    console.warn("DATABASE_URL not set: using the in-memory store. Documents are lost on restart.");
    store = new MemoryStore();
  }
  await store.init();

  let bus: Bus;
  if (config.redisUrl) {
    bus = new RedisBus(config.redisUrl);
  } else {
    console.warn("REDIS_URL not set: running as a single instance (no cross-instance sync).");
    bus = new LocalBus();
  }

  const app = createApp({ store, bus, config });
  const port = await app.listen(config.port);
  console.log(`[${config.instanceId}] listening on :${port}`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, flushing and shutting down...`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
      await bus.close();
      await store.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
