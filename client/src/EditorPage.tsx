import { useEffect, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import { api, wsBaseUrl } from "./api";
import { Editor } from "./Editor";
import { getIdentity, saveIdentityName, type Identity } from "./identity";
import { forgetDoc, rememberDoc } from "./recent";
import { VersionPanel } from "./VersionPanel";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Must match META / TITLE_KEY in server/src/content.ts. */
const META = "meta";
const TITLE_KEY = "title";

interface Session {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  local: IndexeddbPersistence;
}

type Load = { state: "loading" } | { state: "ready"; title: string } | { state: "missing" } | { state: "error"; message: string };

/**
 * Owns the Yjs document and its two providers:
 *  - IndexedDB keeps a local copy, so the document opens instantly and edits survive a
 *    reload even while offline.
 *  - WebSocket syncs with the server; it reconnects automatically and merges on reconnect.
 */
export function EditorPage({ docId }: { docId: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    api
      .getDoc(docId)
      .then((d) => !cancelled && setLoad({ state: "ready", title: d.title }))
      .catch((e: Error) => {
        if (cancelled) return;
        if (/not found/i.test(e.message)) {
          forgetDoc(docId);
          setLoad({ state: "missing" });
        } else {
          setLoad({ state: "error", message: e.message });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  if (load.state === "loading") return <p className="muted pad">Loading…</p>;
  if (load.state === "missing") {
    return (
      <main className="page">
        <h1>Document not found</h1>
        <p className="muted">This link doesn't point to a document on this server. It may have been mistyped.</p>
        <a className="btn primary" href="#/">
          Back to home
        </a>
      </main>
    );
  }
  if (load.state === "error") {
    return (
      <main className="page">
        <h1>Can't reach the server</h1>
        <p className="error">{load.message}</p>
        <button className="btn" onClick={() => location.reload()}>
          Try again
        </button>
      </main>
    );
  }
  return <LiveEditor docId={docId} initialTitle={load.title} />;
}

function LiveEditor({ docId, initialTitle }: { docId: string; initialTitle: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [title, setTitle] = useState(initialTitle);
  const [editingTitle, setEditingTitle] = useState(false);
  const [identity, setIdentity] = useState<Identity>(getIdentity);
  const [showVersions, setShowVersions] = useState(false);
  const [manualOffline, setManualOffline] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const local = new IndexeddbPersistence(`collab-editor:${docId}`, ydoc);
    const provider = new WebsocketProvider(wsBaseUrl(), docId, ydoc);
    const onStatus = ({ status }: { status: ConnectionStatus }) => setStatus(status);
    provider.on("status", onStatus);
    setSession({ ydoc, provider, local });

    return () => {
      provider.off("status", onStatus);
      provider.destroy();
      void local.destroy();
      ydoc.destroy();
      setSession(null);
    };
  }, [docId]);

  // The title lives in the shared doc, so a rename by anyone shows up for everyone.
  useEffect(() => {
    if (!session) return;
    const meta = session.ydoc.getMap<string>(META);
    const sync = () => {
      const value = meta.get(TITLE_KEY);
      if (typeof value === "string" && !editingTitle) setTitle(value);
    };
    sync();
    meta.observe(sync);
    return () => meta.unobserve(sync);
  }, [session, editingTitle]);

  useEffect(() => {
    rememberDoc(docId, title);
  }, [docId, title]);

  function toggleOffline() {
    if (!session) return;
    if (manualOffline) session.provider.connect();
    else session.provider.disconnect();
    setManualOffline(!manualOffline);
  }

  function commitTitle() {
    setEditingTitle(false);
    const next = title.trim() || "Untitled";
    setTitle(next);
    session?.ydoc.getMap<string>(META).set(TITLE_KEY, next);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this link", location.href);
    }
  }

  const statusLabel = manualOffline
    ? "Offline (paused)"
    : status === "connected"
      ? "Synced"
      : status === "connecting"
        ? "Connecting…"
        : "Offline: changes are saved locally";

  return (
    <div className={`editor-layout ${showVersions ? "with-panel" : ""}`}>
      <div className="editor-main">
        <header className="editor-header">
          <a href="#/" className="back" aria-label="Back to home">
            ←
          </a>
          <input
            className="title-input"
            value={title}
            placeholder="Untitled"
            onFocus={() => setEditingTitle(true)}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            maxLength={200}
            aria-label="Document title"
          />
          <span className={`status ${manualOffline ? "disconnected" : status}`} role="status" data-testid="status">
            <span className="dot" />
            <span className="status-text">{statusLabel}</span>
          </span>
          <button className="btn" onClick={toggleOffline} title="Simulate losing your connection">
            {manualOffline ? "Go online" : "Go offline"}
          </button>
          <button className="btn" onClick={copyLink} title="Copy a link to this document">
            {copied ? "Copied" : "Share"}
          </button>
          <button className="btn" onClick={() => setShowVersions((v) => !v)} aria-pressed={showVersions}>
            History
          </button>
        </header>

        {session ? (
          <Editor
            ydoc={session.ydoc}
            provider={session.provider}
            identity={identity}
            onRename={(name) => setIdentity(saveIdentityName(name))}
          />
        ) : (
          <p className="muted pad">Loading…</p>
        )}
      </div>

      {showVersions && <VersionPanel docId={docId} onClose={() => setShowVersions(false)} />}
    </div>
  );
}
