import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { LocalBus } from "../src/bus/local.js";
import { RedisBus, decodeBusMessage, encodeBusMessage } from "../src/bus/redis.js";
import type { Bus, BusMessage } from "../src/bus/types.js";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import type { Store } from "../src/store/types.js";
import { sleep, waitFor } from "./helpers.js";

/**
 * The same behavioural tests run against every implementation. The Postgres and Redis
 * variants run only when DATABASE_URL / REDIS_URL are set (see README).
 */

const makeUpdate = (text: string): Uint8Array => {
  const d = new Y.Doc();
  d.getText("t").insert(0, text);
  return Y.encodeStateAsUpdate(d);
};

const textOf = (updates: Uint8Array[]): string => {
  const d = new Y.Doc();
  for (const u of updates) Y.applyUpdate(d, u);
  return d.getText("t").toString();
};

const stores: [string, (() => Store) | null][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["PostgresStore", process.env.DATABASE_URL ? () => new PostgresStore(process.env.DATABASE_URL!) : null],
];

for (const [name, make] of stores) {
  describe.skipIf(!make)(`Store contract: ${name}`, () => {
    let store: Store;
    const id = () => `t${randomBytes(5).toString("hex")}`;

    beforeAll(async () => {
      store = make!();
      await store.init();
    });
    afterAll(async () => {
      await store.close();
    });

    it("creates documents idempotently", async () => {
      const docId = id();
      const a = await store.createDoc(docId, "First");
      const b = await store.ensureDoc(docId, "Ignored");
      expect(b.title).toBe(a.title);
      expect((await store.getDoc(docId))?.title).toBe("First");
      expect(await store.getDoc(id())).toBeNull();
    });

    it("appends and loads updates in order", async () => {
      const docId = id();
      await store.createDoc(docId, "x");
      const d = new Y.Doc();
      const updates: Uint8Array[] = [];
      d.on("update", (u: Uint8Array) => updates.push(u));
      d.getText("t").insert(0, "ab");
      d.getText("t").insert(2, "cd");
      for (const u of updates) await store.appendUpdate(docId, u);
      expect(textOf(await store.loadUpdates(docId))).toBe("abcd");
    });

    it("compacts to a single row with identical content", async () => {
      const docId = id();
      await store.createDoc(docId, "x");
      const d = new Y.Doc();
      d.on("update", (u: Uint8Array) => void store.appendUpdate(docId, u));
      for (let i = 0; i < 6; i++) d.getText("t").insert(d.getText("t").length, `${i}`);
      await waitFor(async () => (await store.loadUpdates(docId)).length === 6, 3000, "appends");
      await store.compact(docId);
      const after = await store.loadUpdates(docId);
      expect(after).toHaveLength(1);
      expect(textOf(after)).toBe("012345");
    });

    it("keeps rows appended while compaction is running", async () => {
      const docId = id();
      await store.createDoc(docId, "x");
      for (let i = 0; i < 5; i++) await store.appendUpdate(docId, makeUpdate(`${i}`));
      const compaction = store.compact(docId);
      const extra = makeUpdate("late");
      await store.appendUpdate(docId, extra);
      await compaction;
      const text = textOf(await store.loadUpdates(docId));
      expect(text).toContain("late");
      for (let i = 0; i < 5; i++) expect(text).toContain(`${i}`);
    });

    it("saves, lists and fetches versions newest first", async () => {
      const docId = id();
      await store.createDoc(docId, "x");
      const v1 = await store.saveVersion(docId, "one", makeUpdate("1"));
      const v2 = await store.saveVersion(docId, "two", makeUpdate("2"));
      const list = await store.listVersions(docId);
      expect(list.map((v) => v.label)).toEqual(["two", "one"]);
      expect(v2.id).toBeGreaterThan(v1.id);
      const got = await store.getVersion(docId, v1.id);
      expect(textOf([got!.snapshot])).toBe("1");
      expect(got!.meta.sizeBytes).toBeGreaterThan(0);
      expect(await store.getVersion(docId, 987654321)).toBeNull();
      expect(await store.getVersion(id(), v1.id)).toBeNull();
    });

    it("renames and lists documents", async () => {
      const docId = id();
      await store.createDoc(docId, "Old");
      expect((await store.renameDoc(docId, "New"))?.title).toBe("New");
      expect(await store.renameDoc(id(), "nope")).toBeNull();
      expect((await store.listDocs()).some((d) => d.id === docId)).toBe(true);
    });
  });
}

const buses: [string, (() => Bus) | null][] = [
  ["LocalBus", () => new LocalBus()],
  ["RedisBus", process.env.REDIS_URL ? () => new RedisBus(process.env.REDIS_URL!) : null],
];

for (const [name, make] of buses) {
  describe.skipIf(!make)(`Bus contract: ${name}`, () => {
    // Redis delivers across separate connections; LocalBus shares one object.
    const shared = name === "LocalBus" ? new LocalBus() : null;
    const open = () => shared ?? make!();
    const closeAll: Bus[] = [];
    const track = (b: Bus) => (closeAll.push(b), b);
    afterAll(async () => {
      await Promise.all(closeAll.map((b) => b.close()));
    });

    const msg = (from: string, kind: BusMessage["kind"], bytes: number[]): BusMessage => ({
      from,
      kind,
      data: new Uint8Array(bytes),
    });

    it("delivers published messages to subscribers on other connections", async () => {
      const a = track(open());
      const b = track(open());
      const doc = `d${randomBytes(4).toString("hex")}`;
      const received: BusMessage[] = [];
      await b.subscribe(doc, (m) => received.push(m));
      await a.publish(doc, msg("A", "update", [1, 2, 3]));
      await waitFor(() => received.length === 1, 3000, "delivery");
      expect(received[0]).toMatchObject({ from: "A", kind: "update" });
      expect([...received[0]!.data]).toEqual([1, 2, 3]);
    });

    it("isolates documents and stops delivery after unsubscribe", async () => {
      const a = track(open());
      const b = track(open());
      const doc1 = `d${randomBytes(4).toString("hex")}`;
      const doc2 = `d${randomBytes(4).toString("hex")}`;
      const got: string[] = [];
      const unsub = await b.subscribe(doc1, (m) => got.push(`1:${m.kind}`));
      await a.publish(doc2, msg("A", "update", [1]));
      await a.publish(doc1, msg("A", "awareness", [1]));
      await waitFor(() => got.length === 1, 3000, "doc1 delivery");
      expect(got).toEqual(["1:awareness"]);

      await unsub();
      await a.publish(doc1, msg("A", "update", [1]));
      await sleep(100);
      expect(got).toHaveLength(1);
    });

    it("keeps a subscription alive until the last handler leaves", async () => {
      const a = track(open());
      const b = track(open());
      const doc = `d${randomBytes(4).toString("hex")}`;
      let one = 0;
      let two = 0;
      const unsub1 = await b.subscribe(doc, () => one++);
      await b.subscribe(doc, () => two++);
      await unsub1();
      await a.publish(doc, msg("A", "update", [9]));
      await waitFor(() => two === 1, 3000, "second handler");
      expect(one).toBe(0);
    });
  });
}

describe("Redis wire format", () => {
  it("round-trips every message kind", () => {
    for (const kind of ["update", "awareness", "sync1", "sync2"] as const) {
      const original: BusMessage = { from: "host-1-abc", kind, data: new Uint8Array([0, 255, 7]) };
      const decoded = decodeBusMessage(encodeBusMessage(original));
      expect(decoded).toMatchObject({ from: "host-1-abc", kind });
      expect([...decoded!.data]).toEqual([0, 255, 7]);
    }
  });

  it("rejects garbage", () => {
    expect(decodeBusMessage(Buffer.from([]))).toBeNull();
    expect(decodeBusMessage(Buffer.from([3, 1, 2, 3, 99]))).toBeNull();
  });
});
