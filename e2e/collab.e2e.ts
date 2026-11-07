/**
 * End-to-end test in real browsers: two separate browser profiles edit one document through
 * the production build served by the server.
 *
 *   npm run build && npm run test:e2e
 *
 * Set E2E_SCREENSHOTS=1 to also write docs/screenshot-*.png.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const PORT = Number(process.env.E2E_PORT ?? 4321);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.E2E_SCREENSHOTS === "1";

let server: ChildProcess | undefined;
let browser: Browser | undefined;
let passed = 0;

async function step(name: string, fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    throw err;
  }
}

async function startServer(): Promise<void> {
  server = spawn("node", ["server/dist/index.js"], {
    env: { ...process.env, PORT: String(PORT), STATIC_DIR: "client/dist", DATABASE_URL: "", REDIS_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start (did you run `npm run build`?)");
}

/** Document text without the remote-cursor name labels, which differ per viewer. */
const editorText = (page: Page) =>
  page.locator(".prose").evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".collaboration-cursor__caret").forEach((c) => c.remove());
    document.body.appendChild(clone);
    const text = clone.innerText;
    clone.remove();
    return text;
  });

async function expectText(page: Page, predicate: (t: string) => boolean, label: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    last = await editorText(page);
    if (predicate(last)) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label}: editor text was ${JSON.stringify(last)}`);
}

async function synced(page: Page) {
  await page.getByTestId("status").filter({ hasText: "Synced" }).waitFor({ timeout: 10_000 });
}

async function main() {
  await startServer();
  browser = await chromium.launch();
  // Separate contexts = separate IndexedDB and localStorage, like two different people.
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await ctxA.addInitScript(() => localStorage.setItem("collab-editor:identity", JSON.stringify({ name: "Ada", color: "#7c3aed" })));
  await ctxB.addInitScript(() => localStorage.setItem("collab-editor:identity", JSON.stringify({ name: "Grace", color: "#ea580c" })));
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errors: string[] = [];
  for (const p of [a, b]) {
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("dialog", (d) => void d.accept());
  }

  let docUrl = "";
  console.log("e2e: collaborative editing in two browsers");

  await step("creates a document from the home page", async () => {
    await a.goto(BASE);
    await a.getByRole("button", { name: "New document" }).click();
    await a.waitForURL(/#\/doc\/[A-Za-z0-9_-]+$/);
    docUrl = a.url();
    await synced(a);
  });

  await step("second person opens the link and both see each other", async () => {
    await b.goto(docUrl);
    await synced(b);
    await a.locator(".peers .avatar").nth(1).waitFor();
    await b.locator(".peers .avatar").nth(1).waitFor();
  });

  await step("typing in one browser appears in the other", async () => {
    await a.locator(".prose").click();
    await a.keyboard.type("Hello from Ada.");
    await expectText(b, (t) => t.includes("Hello from Ada."), "B sees A's text");
    await b.locator(".prose").click();
    await b.keyboard.press("End");
    await b.keyboard.type(" And Grace.");
    await expectText(a, (t) => t.includes("Hello from Ada. And Grace."), "A sees B's text");
  });

  await step("shows the other person's cursor with their name", async () => {
    await a.locator(".collaboration-cursor__label", { hasText: "Grace" }).waitFor({ timeout: 5000 });
    await b.locator(".collaboration-cursor__label", { hasText: "Ada" }).waitFor({ timeout: 5000 });
  });

  await step("formatting syncs (heading)", async () => {
    await a.keyboard.press("Enter");
    await a.getByRole("button", { name: "Heading 2" }).click();
    await a.keyboard.type("Agenda");
    await b.locator(".prose h2", { hasText: "Agenda" }).waitFor({ timeout: 5000 });
  });

  await step("renaming the document updates the other browser live", async () => {
    const title = a.getByLabel("Document title");
    await title.fill("Team sync notes");
    await title.press("Enter");
    await b.waitForFunction(
      () => (document.querySelector(".title-input") as HTMLInputElement | null)?.value === "Team sync notes",
      undefined,
      { timeout: 5000 },
    );
  });

  if (SHOTS) {
    mkdirSync("docs", { recursive: true });
    await a.locator(".prose").click();
    await a.waitForTimeout(300);
    await a.screenshot({ path: "docs/screenshot-editor.png" });
  }

  await step("edits made offline merge when the connection returns", async () => {
    await b.getByRole("button", { name: "Go offline" }).click();
    await b.getByTestId("status").filter({ hasText: "Offline" }).waitFor();
    await b.locator(".prose p").first().click();
    await b.keyboard.press("End");
    await b.keyboard.type(" (written offline)");
    await a.locator(".prose p").first().click();
    await a.keyboard.press("Home");
    await a.keyboard.type("[online] ");
    // While B is offline, A must not see B's edit.
    await a.waitForTimeout(400);
    if ((await editorText(a)).includes("written offline")) throw new Error("offline edit leaked before reconnect");

    await b.getByRole("button", { name: "Go online" }).click();
    await synced(b);
    const both = (t: string) => t.includes("[online] ") && t.includes("(written offline)");
    await expectText(a, both, "A has both edits");
    await expectText(b, both, "B has both edits");
    const [ta, tb] = [await editorText(a), await editorText(b)];
    if (ta !== tb) throw new Error(`documents diverged after reconnect:\nA: ${JSON.stringify(ta)}\nB: ${JSON.stringify(tb)}`);
  });

  let savedText = "";
  await step("saves a version and restores it for everyone", async () => {
    savedText = await editorText(a);
    await a.getByRole("button", { name: "History" }).click();
    await a.getByPlaceholder("Label (optional)").fill("Before cleanup");
    await a.getByRole("button", { name: "Save version" }).click();
    await a.getByText("Version saved").waitFor();

    await a.locator(".prose").click();
    await a.keyboard.press("ControlOrMeta+a");
    await a.keyboard.press("Backspace");
    await a.keyboard.type("Oops, everything is gone");
    await expectText(b, (t) => t.trim() === "Oops, everything is gone", "B sees the deletion");

    await a.locator(".version-row", { hasText: "Before cleanup" }).click();
    await a.locator(".preview pre").filter({ hasText: "Hello from Ada" }).waitFor();
    if (SHOTS) await a.screenshot({ path: "docs/screenshot-history.png" });
    await a.getByRole("button", { name: "Restore this version" }).click();
    await expectText(b, (t) => t === savedText, "B sees the restored version");
    await expectText(a, (t) => t === savedText, "A sees the restored version");
  });

  await step("content survives a reload", async () => {
    await b.reload();
    await synced(b);
    await expectText(b, (t) => t === savedText, "B after reload");
  });

  await step("home page lists the document as recent", async () => {
    await b.goto(BASE);
    await b.locator(".doc-list a", { hasText: "Team sync notes" }).waitFor();
  });

  await step("an unknown link shows 'not found' instead of reconnecting forever", async () => {
    await b.goto(`${BASE}/#/doc/doesNotExist123`);
    await b.getByRole("heading", { name: "Document not found" }).waitFor();
  });

  if (errors.length) throw new Error(`uncaught page errors:\n${errors.join("\n")}`);
  console.log(`\n${passed} passed`);
}

main()
  .then(async () => {
    await browser?.close();
    server?.kill();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\n", err);
    await browser?.close();
    server?.kill();
    process.exit(1);
  });
