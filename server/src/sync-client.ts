import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WebSocket } from "ws";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/**
 * A minimal headless client that speaks the same protocol as y-websocket.
 * Used by the integration tests and the load test; the browser uses y-websocket itself.
 *
 * `disconnect()` + `connect()` simulates going offline: the local doc keeps accepting edits,
 * and reconnecting runs the normal two-way sync handshake to merge both sides.
 */
export class SyncClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private ws?: WebSocket;
  synced = false;

  constructor(
    private baseUrl: string,
    readonly docId: string,
  ) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // came from the server; don't echo it back
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });
    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === this) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_AWARENESS);
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, added.concat(updated, removed)),
        );
        this.send(encoding.toUint8Array(enc));
      },
    );
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Resolves once the server has answered our sync step 1 (i.e. we have its state). */
  connect(timeoutMs = 5000): Promise<void> {
    this.synced = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.baseUrl}/ws/${this.docId}`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`sync timeout for ${this.docId}`));
      }, timeoutMs);

      ws.on("open", () => {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeSyncStep1(enc, this.doc);
        this.send(encoding.toUint8Array(enc));
        if (this.awareness.getLocalState() !== null) {
          const aEnc = encoding.createEncoder();
          encoding.writeVarUint(aEnc, MSG_AWARENESS);
          encoding.writeVarUint8Array(
            aEnc,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
          );
          this.send(encoding.toUint8Array(aEnc));
        }
      });
      ws.on("message", (data: ArrayBuffer) => {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const type = decoding.readVarUint(decoder);
        if (type === MSG_SYNC) {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          const syncType = syncProtocol.readSyncMessage(decoder, enc, this.doc, this);
          if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
          if (syncType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
            this.synced = true;
            clearTimeout(timer);
            resolve();
          }
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("close", () => {
        this.synced = false;
        clearTimeout(timer);
      });
    });
  }

  /** Close the socket (simulates going offline). The local doc stays usable. */
  async disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }

  async destroy(): Promise<void> {
    await this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private send(data: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }
}
