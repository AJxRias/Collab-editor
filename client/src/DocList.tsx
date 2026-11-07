import { useState } from "react";
import { api } from "./api";
import { Hero } from "./Hero";
import { getRecent, rememberDoc } from "./recent";

const SOURCE_URL = "https://github.com/AJxRias/Collab-editor";
const DOT_COLORS = ["#FF3D8B", "#3D5AFE", "#0FA37F", "#F06D1F", "#8B5CF6", "#0E9BD8"];

function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DOT_COLORS[h % DOT_COLORS.length]!;
}

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
    <div className="home">
      <nav className="home-nav">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Collab Editor
        </span>
        <a className="nav-link" href={SOURCE_URL} target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
      </nav>

      <main className="home-main">
        <section className="hero">
          <Hero />
          <p className="hero-lede">
            Open a document, send the link, and write with anyone at the same time. You see each other's cursors as you
            type, and anything written offline merges in when the connection comes back.
          </p>
          <div className="hero-actions">
            <button className="btn-big" onClick={create} disabled={creating}>
              {creating ? "Creating…" : "New document"}
            </button>
            {error && <p className="error">Couldn't create a document: {error}</p>}
          </div>
        </section>

        <section className="try" aria-labelledby="try-title">
          <h2 id="try-title">Try it in a minute</h2>
          <ol className="steps">
            <li>
              <strong>Start a document</strong>
              <span>Write anything. It saves as you type.</span>
            </li>
            <li>
              <strong>Open it twice</strong>
              <span>Press Share, then paste the link in another window or send it to a friend.</span>
            </li>
            <li>
              <strong>Go offline</strong>
              <span>Keep typing in one window while the other edits, then reconnect and watch both merge.</span>
            </li>
          </ol>
        </section>

        <section className="recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Your recent documents</h2>
          {recent.length === 0 ? (
            <p className="muted">Nothing yet. Documents you open in this browser show up here.</p>
          ) : (
            <ul className="doc-list">
              {recent.map((d) => (
                <li key={d.id}>
                  <a href={`#/doc/${d.id}`}>
                    <span className="doc-dot" style={{ background: colorFor(d.id) }} aria-hidden="true" />
                    <span className="doc-title">{d.title}</span>
                    <span className="muted">Opened {new Date(d.openedAt).toLocaleString()}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="home-foot">
        Built by Arjuna Sharma with React, Yjs, Node, PostgreSQL and Redis.{" "}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
          Read the source
        </a>
      </footer>
    </div>
  );
}
