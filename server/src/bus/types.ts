export type BusKind = "update" | "awareness" | "sync1" | "sync2";

export interface BusMessage {
  /** Instance id of the sender. Receivers ignore their own messages. */
  from: string;
  kind: BusKind;
  data: Uint8Array;
}

export type BusHandler = (msg: BusMessage) => void;

/**
 * Fan-out between server instances. Each document has its own channel, and an instance is
 * only subscribed to the channels of documents it currently has open.
 */
export interface Bus {
  subscribe(docId: string, handler: BusHandler): Promise<() => Promise<void>>;
  publish(docId: string, msg: BusMessage): Promise<void>;
  close(): Promise<void>;
}
