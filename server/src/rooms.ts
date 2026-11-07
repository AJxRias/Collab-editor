import type { RawData, WebSocket } from "ws";
import type { Bus } from "./bus/types.js";
import type { Config } from "./config.js";
import type { Metrics } from "./metrics.js";
import { Room } from "./room.js";
import type { Store } from "./store/types.js";

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Owns every open Room on this instance: lazy load, idle eviction, orderly shutdown. */
export class RoomManager {
  private rooms = new Map<string, Promise<Room>>();
  private closing = new Map<string, Promise<void>>();
  private idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private store: Store,
    private bus: Bus,
    private config: Config,
    private metrics: Metrics,
  ) {}

  get openRooms(): number {
    return this.rooms.size;
  }

  /** Get (loading if needed) the room for a document. Cancels any pending idle eviction. */
  async get(docId: string): Promise<Room> {
    // If the room is mid-teardown, wait so we read what it flushed.
    while (this.closing.has(docId)) await this.closing.get(docId);

    let pending = this.rooms.get(docId);
    if (!pending) {
      pending = Room.open({
        docId,
        store: this.store,
        bus: this.bus,
        config: this.config,
        metrics: this.metrics,
        onEmpty: (room) => this.scheduleClose(docId, room),
      });
      this.rooms.set(docId, pending);
      pending.catch(() => {
        if (this.rooms.get(docId) === pending) this.rooms.delete(docId);
      });
    }
    const room = await pending;
    this.cancelClose(docId);
    return room;
  }

  /** Run `fn` against the room, then let it go idle again if nobody is connected. */
  async use<T>(docId: string, fn: (room: Room) => T | Promise<T>): Promise<T> {
    const room = await this.get(docId);
    try {
      return await fn(room);
    } finally {
      if (room.conns.size === 0) this.scheduleClose(docId, room);
    }
  }

  /** Attach a freshly upgraded WebSocket to a document. */
  async attach(docId: string, ws: WebSocket): Promise<void> {
    let room: Room | undefined;
    let closed = false;
    // The client sends its sync step 1 immediately; buffer until the room has loaded.
    const queue: Uint8Array[] = [];

    ws.on("message", (data: RawData) => {
      const bytes = toBytes(data);
      if (room) room.handleMessage(ws, bytes);
      else queue.push(bytes);
    });
    ws.on("close", () => {
      closed = true;
      room?.removeConn(ws);
    });
    ws.on("error", () => ws.terminate());

    try {
      // Documents are created through the API only; a socket can't conjure one into existence.
      if (!(await this.store.getDoc(docId))) {
        ws.close(4404, "document not found");
        return;
      }
      room = await this.get(docId);
    } catch (err) {
      console.error(`[rooms] failed to open ${docId}:`, (err as Error).message);
      ws.close(1011, "could not open document");
      return;
    }
    if (closed || room.destroyed) {
      if (room.conns.size === 0) this.scheduleClose(docId, room);
      return;
    }
    room.addConn(ws);
    for (const bytes of queue.splice(0)) room.handleMessage(ws, bytes);
  }

  private cancelClose(docId: string): void {
    const timer = this.idleTimers.get(docId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(docId);
  }

  private scheduleClose(docId: string, room: Room): void {
    this.cancelClose(docId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(docId);
      if (room.conns.size > 0) return;
      this.close(docId);
    }, this.config.roomIdleMs);
    timer.unref();
    this.idleTimers.set(docId, timer);
  }

  private close(docId: string): void {
    const pending = this.rooms.get(docId);
    if (!pending) return;
    this.rooms.delete(docId);
    const teardown = pending
      .then((room) => room.destroy())
      .catch((err: Error) => console.error(`[rooms] closing ${docId} failed:`, err.message))
      .finally(() => this.closing.delete(docId));
    this.closing.set(docId, teardown);
  }

  /** Flush and close everything. Used on shutdown. */
  async closeAll(): Promise<void> {
    for (const docId of [...this.idleTimers.keys()]) this.cancelClose(docId);
    for (const docId of [...this.rooms.keys()]) this.close(docId);
    await Promise.all(this.closing.values());
  }
}
