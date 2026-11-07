/**
 * Load test: N headless clients spread over D documents and one or more server instances.
 * One client per document writes at a fixed rate; every other client measures how long each
 * edit takes to reach it (writer -> server [-> Redis -> other server] -> reader).
 *
 *   npm run loadtest -- --urls ws://localhost:4001,ws://localhost:4002 --clients 500 --docs 25 --duration 30
 *
 * Everything runs in this one process and on this machine's clock, so keep an eye on the
 * generator's own CPU: if it saturates, the latencies it reports include its own queueing.
 */
import { performance } from "node:perf_hooks";
import { SyncClient } from "./sync-client.js";

interface Options {
  urls: string[];
  clients: number;
  docs: number;
  durationSec: number;
  editsPerSec: number;
  rampPerSec: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    urls: ["ws://localhost:4000"],
    clients: 200,
    docs: 20,
    durationSec: 20,
    editsPerSec: 5,
    rampPerSec: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i++;
      return value;
    };
    switch (flag) {
      case "--urls":
        opts.urls = need().split(",").map((s) => s.trim().replace(/\/$/, ""));
        break;
      case "--clients":
        opts.clients = Number(need());
        break;
      case "--docs":
        opts.docs = Number(need());
        break;
      case "--duration":
        opts.durationSec = Number(need());
        break;
      case "--rate":
        opts.editsPerSec = Number(need());
        break;
      case "--ramp":
        opts.rampPerSec = Number(need());
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  if (opts.clients < opts.docs * 2) {
    throw new Error("need at least 2 clients per document (one writer, one reader)");
  }
  return opts;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Sockets can't create documents, so create them through the API first. The server's
  // per-IP write limit applies: run it with API_WRITES_PER_MIN raised (see README).
  const httpBase = opts.urls[0]!.replace(/^ws/, "http");
  const docIds: string[] = [];
  for (let d = 0; d < opts.docs; d++) {
    const res = await fetch(`${httpBase}/api/docs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `load test ${d}` }),
    });
    if (!res.ok) throw new Error(`creating document failed (${res.status}): raise API_WRITES_PER_MIN on the server`);
    docIds.push(((await res.json()) as { id: string }).id);
  }
  console.log(
    `Load test: ${opts.clients} clients, ${opts.docs} docs, ${opts.urls.length} instance(s), ` +
      `${opts.editsPerSec} edits/s per doc, ${opts.durationSec}s`,
  );

  // ---- connect ------------------------------------------------------------------------
  const clients: { client: SyncClient; isWriter: boolean; docIndex: number }[] = [];
  const seenFirst = new Set<number>();
  for (let i = 0; i < opts.clients; i++) {
    const docIndex = i % opts.docs;
    const url = opts.urls[i % opts.urls.length]!;
    const client = new SyncClient(url, docIds[docIndex]!);
    client.awareness.setLocalStateField("user", { name: `bot${i}` });
    const isWriter = !seenFirst.has(docIndex);
    seenFirst.add(docIndex);
    clients.push({ client, isWriter, docIndex });
  }

  const latencies: number[] = [];
  let deliveries = 0;
  let connectFailures = 0;
  const connectTimes: number[] = [];

  const delayMs = 1000 / opts.rampPerSec;
  await Promise.all(
    clients.map(async ({ client, isWriter }, i) => {
      await sleep(i * delayMs);
      const started = performance.now();
      try {
        await client.connect(15_000);
        connectTimes.push(performance.now() - started);
      } catch {
        connectFailures++;
        return;
      }
      if (!isWriter) {
        client.doc.getMap("ping").observe((event) => {
          if (event.transaction.origin !== client) return;
          const sentAt = (client.doc.getMap("ping").get("sentAt") as number | undefined) ?? NaN;
          if (Number.isFinite(sentAt)) {
            latencies.push(performance.now() - sentAt);
            deliveries++;
          }
        });
      }
    }),
  );
  const connected = clients.filter((c) => c.client.connected).length;
  console.log(`Connected ${connected}/${opts.clients} (${connectFailures} failures)`);

  // ---- measure ------------------------------------------------------------------------
  latencies.length = 0;
  deliveries = 0;
  const writers = clients.filter((c) => c.isWriter && c.client.connected);
  const sentByDoc = new Map<number, number>();
  const timers = writers.map(({ client, docIndex }) =>
    setInterval(() => {
      sentByDoc.set(docIndex, (sentByDoc.get(docIndex) ?? 0) + 1);
      client.doc.transact(() => {
        const m = client.doc.getMap("ping");
        m.set("sentAt", performance.now());
      });
    }, 1000 / opts.editsPerSec),
  );
  const t0 = performance.now();
  await sleep(opts.durationSec * 1000);
  timers.forEach(clearInterval);
  await sleep(500); // let in-flight edits land
  const elapsed = (performance.now() - t0) / 1000;

  // ---- report -------------------------------------------------------------------------
  const sorted = [...latencies].sort((a, b) => a - b);
  const sortedConnect = [...connectTimes].sort((a, b) => a - b);
  const expected = writers.reduce((sum, w) => {
    const readers = clients.filter((c) => !c.isWriter && c.docIndex === w.docIndex && c.client.connected).length;
    return sum + readers * (sentByDoc.get(w.docIndex) ?? 0);
  }, 0);

  const metrics = await Promise.all(
    opts.urls.map(async (u) => {
      try {
        const http = u.replace(/^ws/, "http");
        return await fetch(`${http}/api/metrics`).then((r) => r.json());
      } catch {
        return null;
      }
    }),
  );

  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "n/a");
  console.log("\n=== Results ===");
  console.log(`connected clients      ${connected} / ${opts.clients}`);
  console.log(`connect time p50/p95   ${fmt(percentile(sortedConnect, 50))} / ${fmt(percentile(sortedConnect, 95))} ms`);
  console.log(`edit deliveries        ${deliveries} (expected ${expected} from edits actually sent, ${((deliveries / Math.max(1, expected)) * 100).toFixed(1)}%)`);
  console.log(`delivery rate          ${(deliveries / elapsed).toFixed(0)} /s`);
  console.log(`latency p50            ${fmt(percentile(sorted, 50))} ms`);
  console.log(`latency p95            ${fmt(percentile(sorted, 95))} ms`);
  console.log(`latency p99            ${fmt(percentile(sorted, 99))} ms`);
  console.log(`latency max            ${fmt(sorted[sorted.length - 1] ?? NaN)} ms`);
  console.log("server metrics         " + JSON.stringify(metrics));

  const lagging = percentile(sorted, 99) > 200;
  console.log(lagging ? "\nNote: p99 is above 200 ms." : "\np99 is within 200 ms.");

  await Promise.all(clients.map(({ client }) => client.destroy()));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
