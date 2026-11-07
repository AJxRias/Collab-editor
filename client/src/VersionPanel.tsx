import { useCallback, useEffect, useState } from "react";
import { api, type VersionMeta } from "./api";

export function VersionPanel({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setVersions(await api.listVersions(docId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [docId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveVersion(docId, label.trim());
      setLabel("");
      setNotice("Version saved");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function select(id: number) {
    setSelected(id);
    setPreview(null);
    setNotice(null);
    try {
      setPreview((await api.previewVersion(docId, id)).text);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function restore(v: VersionMeta) {
    if (!window.confirm(`Replace the current content with "${v.label}"? You can undo this by restoring a newer version, so save one first if you want to keep the current text.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.restoreVersion(docId, v.id);
      setNotice(`Restored "${v.label}"`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="panel" aria-label="Version history">
      <header className="panel-header">
        <h2>Version history</h2>
        <button className="btn small" onClick={onClose} aria-label="Close version history">
          ✕
        </button>
      </header>

      <form
        className="save-row"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" maxLength={100} />
        <button className="btn primary" disabled={busy}>
          Save version
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      {!versions && <p className="muted">Loading…</p>}
      {versions && versions.length === 0 && <p className="muted">No saved versions yet.</p>}

      <ul className="versions">
        {versions?.map((v) => (
          <li key={v.id} className={v.id === selected ? "selected" : ""}>
            <button className="version-row" onClick={() => void select(v.id)}>
              <span className="doc-title">{v.label}</span>
              <span className="muted">{new Date(v.createdAt).toLocaleString()}</span>
            </button>
            {v.id === selected && (
              <div className="preview">
                {preview === null ? <p className="muted">Loading preview…</p> : <pre>{preview || "(empty document)"}</pre>}
                <button className="btn" disabled={busy || preview === null} onClick={() => void restore(v)}>
                  Restore this version
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
