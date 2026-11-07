import * as Y from "yjs";

/** TipTap's Collaboration extension stores the document in this XmlFragment by default. */
export const FRAGMENT = "default";
/** Document-level fields that sync live, such as the title. */
export const META = "meta";
export const TITLE_KEY = "title";

const BLOCK_NODES = new Set(["paragraph", "heading", "listItem", "blockquote", "codeBlock", "horizontalRule"]);

function nodeText(node: Y.XmlFragment): string {
  let out = "";
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert?: unknown }[]) {
        if (typeof op.insert === "string") out += op.insert;
      }
    } else if (child instanceof Y.XmlElement) {
      out += nodeText(child);
      if (BLOCK_NODES.has(child.nodeName)) out += "\n";
    }
  }
  return out;
}

/** Plain-text rendering of a stored snapshot, for the version preview. */
export function snapshotToText(snapshot: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, snapshot);
    return nodeText(doc.getXmlFragment(FRAGMENT)).trimEnd();
  } finally {
    doc.destroy();
  }
}

/**
 * Restore a version by replacing the live content with a copy of the snapshot's content.
 *
 * A CRDT has no "go back in time": history only grows. Restoring is therefore an ordinary
 * edit (delete everything, insert the old content), which propagates to every client like
 * any other change and can itself be undone by restoring a newer version.
 */
export function replaceContent(target: Y.Doc, snapshot: Uint8Array, origin: unknown = "restore"): void {
  const source = new Y.Doc();
  try {
    Y.applyUpdate(source, snapshot);
    const nodes = source
      .getXmlFragment(FRAGMENT)
      .toArray()
      .filter((n): n is Y.XmlElement | Y.XmlText => n instanceof Y.XmlElement || n instanceof Y.XmlText)
      .map((n) => n.clone());
    target.transact(() => {
      const fragment = target.getXmlFragment(FRAGMENT);
      fragment.delete(0, fragment.length);
      fragment.insert(0, nodes);
    }, origin);
  } finally {
    source.destroy();
  }
}
