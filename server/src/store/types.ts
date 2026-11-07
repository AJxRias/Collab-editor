import * as Y from "yjs";

export interface DocMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface VersionMeta {
  id: number;
  docId: string;
  label: string;
  createdAt: string;
  sizeBytes: number;
}

/**
 * Persistence for documents.
 *
 * A document is stored as an append-only log of Yjs updates. Updates are commutative and
 * idempotent, so the log can be replayed in any order and merged freely. That is what makes
 * compaction safe even when several server instances write to the same document.
 */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  ensureDoc(id: string, title?: string): Promise<DocMeta>;
  createDoc(id: string, title: string): Promise<DocMeta>;
  getDoc(id: string): Promise<DocMeta | null>;
  listDocs(): Promise<DocMeta[]>;
  renameDoc(id: string, title: string): Promise<DocMeta | null>;

  appendUpdate(docId: string, update: Uint8Array): Promise<void>;
  loadUpdates(docId: string): Promise<Uint8Array[]>;
  /**
   * Replace the rows that exist right now with one merged row. Rows appended concurrently
   * (by this or another instance) are left untouched, so nothing is lost.
   */
  compact(docId: string): Promise<void>;

  saveVersion(docId: string, label: string, snapshot: Uint8Array): Promise<VersionMeta>;
  listVersions(docId: string): Promise<VersionMeta[]>;
  getVersion(docId: string, versionId: number): Promise<{ meta: VersionMeta; snapshot: Uint8Array } | null>;
}

/** Merge updates into one, dropping tombstoned content that is safe to garbage-collect. */
export function mergeUpdates(updates: Uint8Array[]): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    for (const u of updates) Y.applyUpdate(doc, u);
  });
  const merged = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return merged;
}
