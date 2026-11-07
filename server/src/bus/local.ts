import type { Bus, BusHandler, BusMessage } from "./types.js";

/**
 * In-process bus. With a single instance it is a no-op; in tests, several instances can
 * share one LocalBus to stand in for Redis.
 */
export class LocalBus implements Bus {
  private handlers = new Map<string, Set<BusHandler>>();

  async subscribe(docId: string, handler: BusHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(docId);
    if (!set) this.handlers.set(docId, (set = new Set()));
    set.add(handler);
    return async () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(docId);
    };
  }

  async publish(docId: string, msg: BusMessage): Promise<void> {
    const set = this.handlers.get(docId);
    if (!set) return;
    // Deliver asynchronously, like a real network hop, and copy so receivers can't alias.
    const copy: BusMessage = { ...msg, data: msg.data.slice() };
    for (const handler of [...set]) setImmediate(() => handler(copy));
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
