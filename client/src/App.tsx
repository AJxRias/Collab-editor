import { lazy, Suspense, useEffect, useState } from "react";
import { DocList } from "./DocList";

// The editor (TipTap, ProseMirror, Yjs) is most of the bundle; load it only when a document opens.
const EditorPage = lazy(() => import("./EditorPage").then((m) => ({ default: m.EditorPage })));

/** Hash routing: `#/` is the home page, `#/doc/<id>` is the editor. */
function parseHash(): { docId: string | null } {
  const match = /^#\/doc\/([A-Za-z0-9_-]{1,64})$/.exec(location.hash);
  return { docId: match ? match[1]! : null };
}

export function App() {
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  if (!route.docId) return <DocList />;
  return (
    <Suspense fallback={<p className="muted pad">Loading editor…</p>}>
      <EditorPage key={route.docId} docId={route.docId} />
    </Suspense>
  );
}
