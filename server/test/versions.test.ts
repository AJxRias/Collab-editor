import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { FRAGMENT } from "../src/content.js";
import type { VersionMeta } from "../src/store/types.js";
import { api, cleanupClients, connect, sleep, startServer, waitFor, type TestServer } from "./helpers.js";

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(async () => {
  await cleanupClients();
  await server.app.close();
});

/** Build ProseMirror-shaped content the way TipTap does: paragraph elements holding text. */
function setParagraphs(doc: Y.Doc, lines: string[]) {
  const fragment = doc.getXmlFragment(FRAGMENT);
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    fragment.insert(
      0,
      lines.map((line) => {
        const p = new Y.XmlElement("paragraph");
        const t = new Y.XmlText();
        t.insert(0, line);
        p.insert(0, [t]);
        return p;
      }),
    );
  });
}

function paragraphs(doc: Y.Doc): string[] {
  return doc
    .getXmlFragment(FRAGMENT)
    .toArray()
    .map((p) => (p as Y.XmlElement).toArray().map((t) => (t as Y.XmlText).toString()).join(""));
}

describe("documents API", () => {
  it("creates, lists, renames and fetches documents", async () => {
    const created = await api<{ id: string; title: string }>(server, "/api/docs", { method: "POST", body: { title: "Plan" } });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe("Plan");

    const list = await api<{ id: string }[]>(server, "/api/docs");
    expect(list.body.map((d) => d.id)).toContain(created.body.id);

    const renamed = await api<{ title: string }>(server, `/api/docs/${created.body.id}`, { method: "PATCH", body: { title: "Roadmap" } });
    expect(renamed.body.title).toBe("Roadmap");

    const fetched = await api<{ title: string }>(server, `/api/docs/${created.body.id}`);
    expect(fetched.body.title).toBe("Roadmap");
  });

  it("validates input and reports missing documents", async () => {
    expect((await api(server, "/api/docs/does-not-exist")).status).toBe(404);
    expect((await api(server, "/api/docs/bad%20id!")).status).toBe(400);
    expect((await api(server, "/api/docs", { method: "POST", body: { title: 42 } })).status).toBe(400);
    expect((await api(server, "/api/docs/does-not-exist/versions", { method: "POST", body: {} })).status).toBe(404);
  });
});

describe("version history", () => {
  it("saves a version, previews it, and restores it into the live document", async () => {
    const { body: doc } = await api<{ id: string }>(server, "/api/docs", { method: "POST", body: { title: "Spec" } });
    const writer = await connect(server, doc.id);
    const reader = await connect(server, doc.id);

    setParagraphs(writer.doc, ["Version one", "Second line"]);
    await waitFor(() => paragraphs(reader.doc).length === 2, 3000, "initial content");

    const saved = await api<VersionMeta>(server, `/api/docs/${doc.id}/versions`, { method: "POST", body: { label: "Draft 1" } });
    expect(saved.status).toBe(201);
    expect(saved.body.label).toBe("Draft 1");

    setParagraphs(writer.doc, ["Completely different now"]);
    await waitFor(() => paragraphs(reader.doc).join("|") === "Completely different now", 3000, "edited content");

    const preview = await api<{ text: string }>(server, `/api/docs/${doc.id}/versions/${saved.body.id}/preview`);
    expect(preview.body.text).toBe("Version one\nSecond line");

    const restore = await api(server, `/api/docs/${doc.id}/versions/${saved.body.id}/restore`, { method: "POST" });
    expect(restore.status).toBe(200);

    // Both connected clients see the restored content without reconnecting.
    await waitFor(() => paragraphs(reader.doc).join("|") === "Version one|Second line", 3000, "reader restored");
    await waitFor(() => paragraphs(writer.doc).join("|") === "Version one|Second line", 3000, "writer restored");

    const versions = await api<VersionMeta[]>(server, `/api/docs/${doc.id}/versions`);
    expect(versions.body).toHaveLength(1);
  });

  it("lets a restore be undone by restoring a newer version", async () => {
    const { body: doc } = await api<{ id: string }>(server, "/api/docs", { method: "POST", body: {} });
    const c = await connect(server, doc.id);

    setParagraphs(c.doc, ["A"]);
    await sleep(50);
    const v1 = (await api<VersionMeta>(server, `/api/docs/${doc.id}/versions`, { method: "POST", body: { label: "A" } })).body;
    setParagraphs(c.doc, ["B"]);
    await sleep(50);
    const v2 = (await api<VersionMeta>(server, `/api/docs/${doc.id}/versions`, { method: "POST", body: { label: "B" } })).body;

    await api(server, `/api/docs/${doc.id}/versions/${v1.id}/restore`, { method: "POST" });
    await waitFor(() => paragraphs(c.doc).join("|") === "A", 3000, "restore v1");
    await api(server, `/api/docs/${doc.id}/versions/${v2.id}/restore`, { method: "POST" });
    await waitFor(() => paragraphs(c.doc).join("|") === "B", 3000, "restore v2");
  });

  it("includes edits that have not reached the store yet", async () => {
    await server.app.close();
    server = await startServer({ config: { persistDebounceMs: 60_000, persistMaxWaitMs: 60_000 } });
    const { body: doc } = await api<{ id: string }>(server, "/api/docs", { method: "POST", body: {} });
    const c = await connect(server, doc.id);
    setParagraphs(c.doc, ["not flushed yet"]);
    await waitFor(() => server.app.metrics.messagesIn >= 3, 3000, "server to receive edit");

    const saved = await api<VersionMeta>(server, `/api/docs/${doc.id}/versions`, { method: "POST", body: {} });
    const preview = await api<{ text: string }>(server, `/api/docs/${doc.id}/versions/${saved.body.id}/preview`);
    expect(preview.body.text).toBe("not flushed yet");
  });

  it("returns 404 for an unknown version", async () => {
    const { body: doc } = await api<{ id: string }>(server, "/api/docs", { method: "POST", body: {} });
    expect((await api(server, `/api/docs/${doc.id}/versions/999/preview`)).status).toBe(404);
    expect((await api(server, `/api/docs/${doc.id}/versions/999/restore`, { method: "POST" })).status).toBe(404);
  });
});
