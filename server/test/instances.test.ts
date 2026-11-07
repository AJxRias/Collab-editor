import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { LocalBus } from "../src/bus/local.js";
import { MemoryStore } from "../src/store/memory.js";
import { cleanupClients, connect, sleep, startServer, waitFor, type TestServer } from "./helpers.js";

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

/** Two server instances sharing one store and one bus, like two pods behind a load balancer. */
async function pair(config = {}) {
  const store = new MemoryStore();
  const bus = new LocalBus();
  const a = await start({ store, bus, config });
  const b = await start({ store, bus, config });
  return { store, bus, a, b };
}

describe("multi-instance", () => {
  it("delivers edits between clients connected to different instances", async () => {
    const { a, b } = await pair();
    const ca = await connect(a, "shared");
    const cb = await connect(b, "shared");

    ca.doc.getText("t").insert(0, "from A");
    await waitFor(() => cb.doc.getText("t").toString() === "from A", 3000, "A -> B");

    cb.doc.getText("t").insert(0, ">> ");
    await waitFor(() => ca.doc.getText("t").toString() === ">> from A", 3000, "B -> A");
  });

  it("persists an edit exactly once, on the instance that received it", async () => {
    const { store, a, b } = await pair();
    const ca = await connect(a, "once");
    await connect(b, "once");

    ca.doc.getText("t").insert(0, "x");
    await waitFor(() => store.countUpdates("once") > 0, 3000, "persist");
    await sleep(150);

    expect(a.app.metrics.updatesPersisted).toBe(1);
    expect(b.app.metrics.updatesPersisted).toBe(0);
  });

  it("shares presence across instances", async () => {
    const { a, b } = await pair();
    const ca = await connect(a, "presence");
    const cb = await connect(b, "presence");
    ca.awareness.setLocalStateField("user", { name: "Ada" });
    await waitFor(() => cb.awareness.getStates().get(ca.doc.clientID)?.user, 3000, "presence A -> B");

    await ca.disconnect();
    await waitFor(() => !cb.awareness.getStates().has(ca.doc.clientID), 3000, "presence cleared on B");
  });

  it("shows presence to someone who joins a second instance later", async () => {
    const { a, b } = await pair();
    const ca = await connect(a, "late-presence");
    ca.awareness.setLocalStateField("user", { name: "Grace" });
    await sleep(50);
    const cb = await connect(b, "late-presence");
    await waitFor(() => cb.awareness.getStates().get(ca.doc.clientID)?.user, 3000, "presence for late joiner");
  });

  it("brings a newly opened instance up to date with edits that are not flushed yet", async () => {
    // Instance A will not write to the store for a minute, so only the bus can supply the edit.
    const { store, a, b } = await pair({ persistDebounceMs: 60_000, persistMaxWaitMs: 60_000 });
    const ca = await connect(a, "unflushed");
    ca.doc.getText("t").insert(0, "only in A's memory");
    await waitFor(() => a.app.metrics.messagesIn >= 3, 3000, "A to receive the edit");
    expect(store.countUpdates("unflushed")).toBe(0);

    const cb = await connect(b, "unflushed");
    await waitFor(() => cb.doc.getText("t").toString() === "only in A's memory", 3000, "B to catch up via sync1/sync2");
  });

  it("does not lose a concurrent edit when one instance compacts", async () => {
    const { store, a, b } = await pair({ compactEvery: 3, persistDebounceMs: 5, persistMaxWaitMs: 20 });
    const ca = await connect(a, "compact-race");
    const cb = await connect(b, "compact-race");
    for (let i = 0; i < 10; i++) {
      ca.doc.getArray<string>("a").push([`a${i}`]);
      cb.doc.getArray<string>("a").push([`b${i}`]);
      await sleep(15);
    }
    await waitFor(() => ca.doc.getArray("a").length === 20 && cb.doc.getArray("a").length === 20, 5000, "convergence");
    await sleep(150);

    const check = new Y.Doc();
    for (const u of await store.loadUpdates("compact-race")) Y.applyUpdate(check, u);
    expect(check.getArray("a").length).toBe(20);
  });
});

describe("durability across instances", () => {
  it("saves edits that only reached this instance over the bus, when the other instance failed to write them", async () => {
    const store = new MemoryStore();
    const bus = new LocalBus();
    // Instance A can read the store but every write fails, as if it crashed before flushing.
    const brokenStore = Object.create(store) as MemoryStore;
    brokenStore.appendUpdate = async () => {
      throw new Error("simulated crash");
    };
    const a = await start({ store: brokenStore, bus });
    const b = await start({ store, bus, config: { roomIdleMs: 20 } });

    const ca = await connect(a, "rescue");
    const cb = await connect(b, "rescue");
    ca.doc.getText("t").insert(0, "would be lost");
    await waitFor(() => cb.doc.getText("t").toString() === "would be lost", 3000, "edit reaches B");
    expect(store.countUpdates("rescue")).toBe(0);

    // The last client leaves B; B reconciles with the store before freeing the room.
    await cb.disconnect();
    await waitFor(() => b.app.metrics.recovered > 0, 3000, "B to persist the missing edit");

    const check = new Y.Doc();
    for (const u of await store.loadUpdates("rescue")) Y.applyUpdate(check, u);
    expect(check.getText("t").toString()).toBe("would be lost");
  });
});
