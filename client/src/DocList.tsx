import { useState } from "react";
import { api } from "./api";
import { getRecent, rememberDoc } from "./recent";

export function DocList() {
  const [recent] = useState(getRecent);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const doc = await api.createDoc("Untitled");
      rememberDoc(doc.id, doc.title);
      location.hash = `#/doc/${doc.id}`;
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <h1>Collab Editor</h1>
          <p className="muted">
            A real-time collaborative editor. Create a document, then open its link in a second window (or send it to a
            friend) to see edits and cursors sync live. Try "Go offline", keep typing, and come back online.
          </p>
        </div>
        <button className="btn primary" onClick={create} disabled={creating}>
          {creating ? "Creating…" : "New document"}
        </button>
      </header>

      {error && <p className="error">Could not create a document: {error}</p>}

      <h2 className="section-title">Your recent documents</h2>
      {recent.length === 0 && <p className="muted">Documents you open in this browser will appear here.</p>}
      <ul className="doc-list">
        {recent.map((d) => (
          <li key={d.id}>
            <a href={`#/doc/${d.id}`}>
              <span className="doc-title">{d.title}</span>
              <span className="muted">Opened {new Date(d.openedAt).toLocaleString()}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
