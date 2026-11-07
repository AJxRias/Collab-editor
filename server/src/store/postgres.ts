import pg from "pg";
import { mergeUpdates, type DocMeta, type Store, type VersionMeta } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id         text PRIMARY KEY,
  title      text NOT NULL DEFAULT 'Untitled',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS doc_updates (
  id         bigserial PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  data       bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_updates_doc_idx ON doc_updates (doc_id, id);
CREATE TABLE IF NOT EXISTS doc_versions (
  id         bigserial PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  label      text NOT NULL,
  snapshot   bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_versions_doc_idx ON doc_versions (doc_id, id DESC);
`;

interface DocRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  doc_id: string;
  label: string;
  created_at: Date;
  size_bytes: number;
}

const toDoc = (r: DocRow): DocMeta => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toVersion = (r: VersionRow): VersionMeta => ({
  id: Number(r.id),
  docId: r.doc_id,
  label: r.label,
  createdAt: r.created_at.toISOString(),
  sizeBytes: Number(r.size_bytes),
});

export class PostgresStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max });
  }

  async init(): Promise<void> {
    // Several instances may boot at once; serialise schema creation with an advisory lock.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727274)");
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ensureDoc(id: string, title = "Untitled"): Promise<DocMeta> {
    return this.createDoc(id, title);
  }

  async createDoc(id: string, title: string): Promise<DocMeta> {
    // The no-op update makes RETURNING work on conflict, so this is a single round trip.
    const { rows } = await this.pool.query<DocRow>(
      `INSERT INTO documents (id, title) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
       RETURNING *`,
      [id, title],
    );
    return toDoc(rows[0]!);
  }

  async getDoc(id: string): Promise<DocMeta | null> {
    const { rows } = await this.pool.query<DocRow>("SELECT * FROM documents WHERE id = $1", [id]);
    return rows[0] ? toDoc(rows[0]) : null;
  }

  async listDocs(): Promise<DocMeta[]> {
    const { rows } = await this.pool.query<DocRow>("SELECT * FROM documents ORDER BY updated_at DESC LIMIT 500");
    return rows.map(toDoc);
  }

  async renameDoc(id: string, title: string): Promise<DocMeta | null> {
    const { rows } = await this.pool.query<DocRow>(
      "UPDATE documents SET title = $2, updated_at = now() WHERE id = $1 RETURNING *",
      [id, title],
    );
    return rows[0] ? toDoc(rows[0]) : null;
  }

  async appendUpdate(docId: string, update: Uint8Array): Promise<void> {
    await this.pool.query(
      `WITH ins AS (INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2))
       UPDATE documents SET updated_at = now() WHERE id = $1`,
      [docId, Buffer.from(update)],
    );
  }

  async loadUpdates(docId: string): Promise<Uint8Array[]> {
    const { rows } = await this.pool.query<{ data: Buffer }>(
      "SELECT data FROM doc_updates WHERE doc_id = $1 ORDER BY id",
      [docId],
    );
    return rows.map((r) => new Uint8Array(r.data));
  }

  async compact(docId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // NO KEY UPDATE serialises compactors without blocking inserts into doc_updates,
      // whose foreign key only takes FOR KEY SHARE on this row.
      const lock = await client.query("SELECT id FROM documents WHERE id = $1 FOR NO KEY UPDATE", [docId]);
      if (lock.rowCount === 0) {
        await client.query("ROLLBACK");
        return;
      }
      const { rows } = await client.query<{ id: string; data: Buffer }>(
        "SELECT id, data FROM doc_updates WHERE doc_id = $1 ORDER BY id",
        [docId],
      );
      if (rows.length < 2) {
        await client.query("COMMIT");
        return;
      }
      const merged = mergeUpdates(rows.map((r) => new Uint8Array(r.data)));
      await client.query("INSERT INTO doc_updates (doc_id, data) VALUES ($1, $2)", [docId, Buffer.from(merged)]);
      // Only delete the rows we actually merged; anything appended meanwhile survives.
      await client.query("DELETE FROM doc_updates WHERE doc_id = $1 AND id = ANY($2::bigint[])", [
        docId,
        rows.map((r) => r.id),
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async saveVersion(docId: string, label: string, snapshot: Uint8Array): Promise<VersionMeta> {
    const { rows } = await this.pool.query<VersionRow>(
      `INSERT INTO doc_versions (doc_id, label, snapshot) VALUES ($1, $2, $3)
       RETURNING id, doc_id, label, created_at, octet_length(snapshot) AS size_bytes`,
      [docId, label, Buffer.from(snapshot)],
    );
    return toVersion(rows[0]!);
  }

  async listVersions(docId: string): Promise<VersionMeta[]> {
    const { rows } = await this.pool.query<VersionRow>(
      `SELECT id, doc_id, label, created_at, octet_length(snapshot) AS size_bytes
       FROM doc_versions WHERE doc_id = $1 ORDER BY id DESC LIMIT 200`,
      [docId],
    );
    return rows.map(toVersion);
  }

  async getVersion(docId: string, versionId: number) {
    const { rows } = await this.pool.query<VersionRow & { snapshot: Buffer }>(
      `SELECT id, doc_id, label, created_at, snapshot, octet_length(snapshot) AS size_bytes
       FROM doc_versions WHERE doc_id = $1 AND id = $2`,
      [docId, versionId],
    );
    const row = rows[0];
    return row ? { meta: toVersion(row), snapshot: new Uint8Array(row.snapshot) } : null;
  }
}
