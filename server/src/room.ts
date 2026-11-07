import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WebSocket } from "ws";
import type { Bus, BusMessage } from "./bus/types.js";
import type { Config } from "./config.js";
import type { Metrics } from "./metrics.js";
import type { Store } from "./store/types.js";
import { TokenBucket } from "./rate-limit.js";
import { META, TITLE_KEY } from "./content.js";

export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;

/** Transaction origin for updates that arrived from another instance over the bus. */
export const ORIGIN_BUS = Symbol("bus");

export interface RoomDeps {
  docId: string;
  store: Store;
  bus: Bus;
  config: Config;
  metrics: Metrics;
  /** Called when the last local connection leaves. */
  onEmpty: (room: Room) => void;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

/**
 * One open document on this instance: the live Y.Doc, its connected sockets, and the
 * machinery that persists changes and mirrors them to other instances.
 *
 * Update flow:
 *   client -> applied to doc -> broadcast to other local clients
 *                            -> published on the bus (other instances apply and broadcast)
 *                            -> queued for a debounced write to the store
 *   bus    -> applied to doc -> broadcast to local clients (not re-published, not persisted:
 *                               the instance that received it from a client owns persistence)
 */
export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Map<WebSocket, Set<number>>();
  destroyed = false;

  private pending: Uint8Array[] = [];
  private debounceTimer?: NodeJS.Timeout;
  private maxWaitTimer?: NodeJS.Timeout;
  private flushChain: Promise<void> = Promise.resolve();
  private unsubscribe?: () => Promise<void>;
  private updateCount = 0;
  private budgets = new WeakMap<WebSocket, TokenBucket>();
  /** Last title written to the documents table, so we only rename when it changes. */
  private persistedTitle: string | undefined;

  private constructor(private deps: RoomDeps) {
    // The server is not a participant, so it must not appear in presence.
    this.awareness.setLocalState(null);
  }

  get docId(): string {
    return this.deps.docId;
  }

  static async open(deps: RoomDeps): Promise<Room> {
    const room = new Room(deps);
    try {
      const updates = await deps.store.loadUpdates(deps.docId);
      room.updateCount = updates.length;
      // Handlers are attached after loading, so replaying history is never re-persisted.
      room.doc.transact(() => {
        for (const u of updates) Y.applyUpdate(room.doc, u);
      });
      room.persistedTitle = room.title();
      room.attachHandlers();
      room.unsubscribe = await deps.bus.subscribe(deps.docId, (m) => room.onBus(m));
      // Ask peers for edits they have not flushed yet, and tell them about our presence.
      room.publish("sync1", Y.encodeStateVector(room.doc));
      if (room.updateCount >= deps.config.compactEvery) void room.compact();
      return room;
    } catch (err) {
      room.doc.destroy();
      room.awareness.destroy();
      throw err;
    }
  }

  // ---- connections -------------------------------------------------------------------

  addConn(ws: WebSocket): void {
    this.conns.set(ws, new Set());
    const { wsMessagesPerSec, wsMessageBurst } = this.deps.config;
    this.budgets.set(ws, new TokenBucket(wsMessagesPerSec, wsMessageBurst));

    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.send(ws, encoding.toUint8Array(enc));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aEnc = encoding.createEncoder();
      encoding.writeVarUint(aEnc, MSG_AWARENESS);
      encoding.writeVarUint8Array(aEnc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      this.send(ws, encoding.toUint8Array(aEnc));
    }
  }

  removeConn(ws: WebSocket): void {
    const ids = this.conns.get(ws);
    if (!ids) return;
    this.conns.delete(ws);
    // Removes this client's cursors for everyone, here and (via the bus) elsewhere.
    awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
    if (this.conns.size === 0 && !this.destroyed) this.deps.onEmpty(this);
  }

  handleMessage(ws: WebSocket, data: Uint8Array): void {
    if (this.destroyed || !this.conns.has(ws)) return;
    if (this.budgets.get(ws)?.take() === false) {
      // A real editor sends a handful of messages per second; this is a runaway or hostile client.
      this.deps.metrics.rateLimited++;
      ws.close(1008, "rate limit exceeded");
      return;
    }
    this.deps.metrics.messagesIn++;
    this.deps.metrics.bytesIn += data.byteLength;
    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        // Applies step 2 / update messages to the doc with `ws` as origin.
        syncProtocol.readSyncMessage(decoder, enc, this.doc, ws);
        if (encoding.length(enc) > 1) this.send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
      }
    } catch (err) {
      // A malformed message from one client must never take the room down.
      console.error(`[room ${this.docId}] bad message:`, (err as Error).message);
      ws.close(1003, "malformed message");
    }
  }

  // ---- doc + awareness events --------------------------------------------------------

  private attachHandlers(): void {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) if (ws !== origin) this.send(ws, msg);

      if (origin !== ORIGIN_BUS) {
        this.publish("update", update);
        this.pending.push(update);
        this.scheduleFlush();
      }
    });

    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      if (origin instanceof WebSocket || this.conns.has(origin as WebSocket)) {
        const ids = this.conns.get(origin as WebSocket);
        if (ids) {
          for (const id of added) ids.add(id);
          for (const id of removed) ids.delete(id);
        }
      }
      const changed = added.concat(updated, removed);
      const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, payload);
      const msg = encoding.toUint8Array(enc);
      for (const ws of this.conns.keys()) this.send(ws, msg);
      if (origin !== ORIGIN_BUS) this.publish("awareness", payload);
    });
  }

  // ---- bus ---------------------------------------------------------------------------

  private publish(kind: BusMessage["kind"], data: Uint8Array): void {
    this.deps.metrics.busOut++;
    this.deps.bus
      .publish(this.docId, { from: this.deps.config.instanceId, kind, data })
      .catch((err: Error) => console.error(`[room ${this.docId}] bus publish failed:`, err.message));
  }

  private onBus(msg: BusMessage): void {
    if (this.destroyed || msg.from === this.deps.config.instanceId) return;
    this.deps.metrics.busIn++;
    try {
      switch (msg.kind) {
        case "update":
        case "sync2":
          Y.applyUpdate(this.doc, msg.data, ORIGIN_BUS);
          break;
        case "awareness":
          awarenessProtocol.applyAwarenessUpdate(this.awareness, msg.data, ORIGIN_BUS);
          break;
        case "sync1": {
          // A peer just opened this document. Send what it is missing, plus current presence.
          const diff = Y.encodeStateAsUpdate(this.doc, msg.data);
          if (diff.byteLength > 2) this.publish("sync2", diff);
          const ids = [...this.awareness.getStates().keys()];
          if (ids.length > 0) this.publish("awareness", awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids));
          break;
        }
      }
    } catch (err) {
      console.error(`[room ${this.docId}] bad bus message:`, (err as Error).message);
    }
  }

  // ---- persistence -------------------------------------------------------------------

  private scheduleFlush(): void {
    const { persistDebounceMs, persistMaxWaitMs } = this.deps.config;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), persistDebounceMs);
    this.maxWaitTimer ??= setTimeout(() => void this.flush(), persistMaxWaitMs);
  }

  /** Write queued edits to the store. Calls are serialised; failures are retried. */
  flush(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = this.maxWaitTimer = undefined;

    this.flushChain = this.flushChain.then(async () => {
      if (this.pending.length === 0) return;
      const batch = this.pending;
      this.pending = [];
      const merged = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
      try {
        await this.deps.store.appendUpdate(this.docId, merged);
        this.deps.metrics.updatesPersisted++;
        this.updateCount++;
        await this.persistTitle();
      } catch (err) {
        this.deps.metrics.flushErrors++;
        console.error(`[room ${this.docId}] persist failed, will retry:`, (err as Error).message);
        this.pending = [merged, ...this.pending];
        if (!this.destroyed) {
          this.debounceTimer = setTimeout(() => void this.flush(), 1000);
        }
        return;
      }
      if (this.updateCount >= this.deps.config.compactEvery) await this.compact();
    });
    return this.flushChain;
  }

  /** The title lives in the Y.Doc so renames sync live; mirror it to the documents table. */
  private title(): string | undefined {
    const value = this.doc.getMap(META).get(TITLE_KEY);
    return typeof value === "string" ? value.trim().slice(0, 200) || "Untitled" : undefined;
  }

  private async persistTitle(): Promise<void> {
    const title = this.title();
    if (title === undefined || title === this.persistedTitle) return;
    await this.deps.store.renameDoc(this.docId, title);
    this.persistedTitle = title;
  }

  /**
   * Write anything held in memory that the store does not have.
   *
   * Edits that arrive over the bus are persisted by the instance that received them from a
   * client. If that instance dies before its debounced write, the edit survives only here (and
   * in the clients' local copies). Before this room lets go of its memory, compare against the
   * store and append the difference. CRDT updates are idempotent, so writing something twice
   * is harmless; writing it zero times is not.
   */
  private async persistMissing(): Promise<void> {
    try {
      const stored = new Y.Doc();
      for (const u of await this.deps.store.loadUpdates(this.docId)) Y.applyUpdate(stored, u);
      let changed = false;
      stored.on("update", () => (changed = true));
      const diff = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(stored));
      Y.applyUpdate(stored, diff);
      stored.destroy();
      if (changed) {
        await this.deps.store.appendUpdate(this.docId, diff);
        this.deps.metrics.recovered++;
        this.updateCount++;
      }
      await this.persistTitle();
    } catch (err) {
      console.error(`[room ${this.docId}] reconcile with store failed:`, (err as Error).message);
    }
  }

  private async compact(): Promise<void> {
    try {
      await this.deps.store.compact(this.docId);
      this.deps.metrics.compactions++;
      this.updateCount = 1;
    } catch (err) {
      console.error(`[room ${this.docId}] compaction failed:`, (err as Error).message);
    }
  }

  /** Flush, compact, leave the bus and free memory. Safe to call once the room is empty. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const ws of this.conns.keys()) ws.close(1001, "server shutting down");
    this.conns.clear();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = this.maxWaitTimer = undefined;
    // One last attempt; if the store is down the edits are lost, which is logged above.
    await this.flush();
    await this.persistMissing();
    if (this.updateCount > 1) await this.compact();
    await this.unsubscribe?.().catch(() => {});
    this.awareness.destroy();
    this.doc.destroy();
  }

  // ---- helpers -----------------------------------------------------------------------

  private send(ws: WebSocket, data: Uint8Array): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    this.deps.metrics.messagesOut++;
    this.deps.metrics.bytesOut += data.byteLength;
    ws.send(data, (err) => {
      if (err) ws.terminate();
    });
  }
}
