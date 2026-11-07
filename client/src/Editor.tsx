import { useEffect, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import type * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import type { Identity } from "./identity";
import { Toolbar } from "./Toolbar";

interface Peer {
  clientId: number;
  name: string;
  color: string;
  isSelf: boolean;
}

function usePeers(provider: WebsocketProvider): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    const { awareness } = provider;
    const update = () => {
      const list: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        const user = state.user as { name?: string; color?: string } | undefined;
        if (user?.name) list.push({ clientId, name: user.name, color: user.color ?? "#888", isSelf: clientId === awareness.clientID });
      });
      setPeers(list.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name)));
    };
    update();
    awareness.on("change", update);
    return () => awareness.off("change", update);
  }, [provider]);
  return peers;
}

export function Editor({
  ydoc,
  provider,
  identity,
  onRename,
}: {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  identity: Identity;
  onRename: (name: string) => void;
}) {
  const editor = useEditor(
    {
      extensions: [
        // The Collaboration extension supplies collaborative undo/redo, so disable the built-in one.
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc }),
        CollaborationCursor.configure({ provider, user: identity }),
      ],
      editorProps: { attributes: { class: "prose", spellcheck: "true" } },
    },
    [ydoc, provider],
  );

  // Keep our presence in sync if the user renames themselves.
  useEffect(() => {
    editor?.commands.updateUser(identity);
  }, [editor, identity]);

  const peers = usePeers(provider);

  return (
    <>
      <div className="toolbar-row">
        <Toolbar editor={editor} />
        <div className="peers" aria-label="People in this document">
          {peers.map((p) => (
            <span
              key={p.clientId}
              className="avatar"
              style={{ background: p.color }}
              title={p.isSelf ? `${p.name} (you)` : p.name}
            >
              {p.name.charAt(0)}
            </span>
          ))}
          <button
            className="btn small"
            onClick={() => {
              const name = window.prompt("Your display name", identity.name);
              if (name) onRename(name);
            }}
            title="Change your display name"
          >
            {identity.name}
          </button>
        </div>
      </div>
      <div className="editor-scroll">
        <EditorContent editor={editor} />
      </div>
    </>
  );
}
