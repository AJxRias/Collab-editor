import { Redis } from "ioredis";
import type { Bus, BusHandler, BusKind, BusMessage } from "./types.js";

const KINDS: BusKind[] = ["update", "awareness", "sync1", "sync2"];
const PREFIX = "collab:doc:";

/** Wire format: [fromLen u8][from utf8][kind u8][payload...] */
export function encodeBusMessage(msg: BusMessage): Buffer {
  const from = Buffer.from(msg.from, "utf8");
  if (from.length > 255) throw new Error("instance id too long");
  return Buffer.concat([Buffer.from([from.length]), from, Buffer.from([KINDS.indexOf(msg.kind)]), Buffer.from(msg.data)]);
}

export function decodeBusMessage(buf: Buffer): BusMessage | null {
  if (buf.length < 2) return null;
  const fromLen = buf[0]!;
  const kind = KINDS[buf[1 + fromLen] ?? -1];
  if (!kind) return null;
  return {
    from: buf.subarray(1, 1 + fromLen).toString("utf8"),
    kind,
    data: new Uint8Array(buf.subarray(2 + fromLen)),
  };
}

export class RedisBus implements Bus {
  private pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, Set<BusHandler>>();

  constructor(url: string) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 3 });
    this.sub = new Redis(url);
    // Avoid unhandled 'error' events crashing the process during Redis restarts.
    this.pub.on("error", (e: Error) => console.error("[redis pub]", e.message));
    this.sub.on("error", (e: Error) => console.error("[redis sub]", e.message));
    this.sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
      const docId = channel.toString("utf8").slice(PREFIX.length);
      const handlers = this.handlers.get(docId);
      if (!handlers) return;
      const msg = decodeBusMessage(message);
      if (!msg) return;
      for (const handler of handlers) handler(msg);
    });
  }

  async subscribe(docId: string, handler: BusHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(docId);
    if (!set) {
      set = new Set();
      this.handlers.set(docId, set);
      await this.sub.subscribe(PREFIX + docId);
    }
    set.add(handler);
    const handlerSet = set;
    return async () => {
      handlerSet.delete(handler);
      if (handlerSet.size === 0 && this.handlers.get(docId) === handlerSet) {
        this.handlers.delete(docId);
        await this.sub.unsubscribe(PREFIX + docId);
      }
    };
  }

  async publish(docId: string, msg: BusMessage): Promise<void> {
    await this.pub.publish(PREFIX + docId, encodeBusMessage(msg));
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
