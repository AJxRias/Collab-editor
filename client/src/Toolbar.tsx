import type { Editor } from "@tiptap/react";

interface Action {
  label: string;
  title: string;
  run: (e: Editor) => void;
  active?: (e: Editor) => boolean;
  disabled?: (e: Editor) => boolean;
}

const ACTIONS: (Action | "sep")[] = [
  { label: "B", title: "Bold", run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive("bold") },
  { label: "I", title: "Italic", run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive("italic") },
  { label: "S", title: "Strikethrough", run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive("strike") },
  { label: "</>", title: "Inline code", run: (e) => e.chain().focus().toggleCode().run(), active: (e) => e.isActive("code") },
  "sep",
  { label: "H1", title: "Heading 1", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), active: (e) => e.isActive("heading", { level: 1 }) },
  { label: "H2", title: "Heading 2", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive("heading", { level: 2 }) },
  { label: "•", title: "Bullet list", run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive("bulletList") },
  { label: "1.", title: "Numbered list", run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive("orderedList") },
  { label: "❝", title: "Quote", run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive("blockquote") },
  { label: "{ }", title: "Code block", run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive("codeBlock") },
  "sep",
  { label: "↶", title: "Undo (only your own changes)", run: (e) => e.chain().focus().undo().run(), disabled: (e) => !e.can().undo() },
  { label: "↷", title: "Redo", run: (e) => e.chain().focus().redo().run(), disabled: (e) => !e.can().redo() },
];

export function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return <div className="toolbar" />;
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {ACTIONS.map((a, i) =>
        a === "sep" ? (
          <span key={`sep${i}`} className="sep" />
        ) : (
          <button
            key={a.title}
            type="button"
            className={`tool ${a.active?.(editor) ? "active" : ""}`}
            title={a.title}
            aria-label={a.title}
            aria-pressed={a.active ? a.active(editor) : undefined}
            disabled={a.disabled?.(editor)}
            // Keep editor focus and selection when clicking the toolbar.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => a.run(editor)}
          >
            {a.label}
          </button>
        ),
      )}
    </div>
  );
}
