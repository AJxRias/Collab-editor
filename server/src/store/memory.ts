import { mergeUpdates, type DocMeta, type Store, type VersionMeta } from "./types.js";

/** In-memory store for tests and quick local runs. Data is lost when the process exits. */
export class MemoryStore implements Store {
  private docs = new Map<string, DocMeta>();
  private updates = new Map<string, Uint8Array[]>();
  private versions = new Map<string, { meta: VersionMeta; snapshot: Uint8Array }[]>();
  private nextVersionId = 1;

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async ensureDoc(id: string, title = "Untitled"): Promise<DocMeta> {
    return this.docs.get(id) ?? (await this.createDoc(id, title));
  }

  async createDoc(id: string, title: string): Promise<DocMeta> {
    const existing = this.docs.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const meta: DocMeta = { id, title, createdAt: now, updatedAt: now };
    this.docs.set(id, meta);
    this.updates.set(id, []);
    this.versions.set(id, []);
    return meta;
  }

  async getDoc(id: string): Promise<DocMeta | null> {
    return this.docs.get(id) ?? null;
  }

  async listDocs(): Promise<DocMeta[]> {
    return [...this.docs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async renameDoc(id: string, title: string): Promise<DocMeta | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    doc.title = title;
    doc.updatedAt = new Date().toISOString();
    return doc;
  }

  async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    const list = this.updates.get(docId);
    const doc = this.docs.get(docId);
    if (!list || !doc) throw new Error(`document ${docId} does not exist`);
    list.push(update.slice());
    doc.updatedAt = new Date().toISOString();
  }

  async loadUpdates(docId: string): Promise<Uint8Array[]> {
    return (this.updates.get(docId) ?? []).map((u) => u.slice());
  }

  async compact(docId: string): Promise<void> {
    const list = this.updates.get(docId);
    if (!list || list.length < 2) return;
    this.updates.set(docId, [mergeUpdates(list)]);
  }

  /** Test helper. */
  countUpdates(docId: string): number {
    return this.updates.get(docId)?.length ?? 0;
  }

  async saveVersion(docId: string, label: string, snapshot: Uint8Array): Promise<VersionMeta> {
    const list = this.versions.get(docId);
    if (!list) throw new Error(`document ${docId} does not exist`);
    const meta: VersionMeta = {
      id: this.nextVersionId++,
      docId,
      label,
      createdAt: new Date().toISOString(),
      sizeBytes: snapshot.byteLength,
    };
    list.push({ meta, snapshot: snapshot.slice() });
    return meta;
  }

  async listVersions(docId: string): Promise<VersionMeta[]> {
    return (this.versions.get(docId) ?? []).map((v) => v.meta).reverse();
  }

  async getVersion(docId: string, versionId: number) {
    const found = (this.versions.get(docId) ?? []).find((v) => v.meta.id === versionId);
    return found ? { meta: found.meta, snapshot: found.snapshot.slice() } : null;
  }
}
