/**
 * Documents this browser has opened. The server does not list documents on public
 * deployments, so the home page shows these instead.
 */
export interface RecentDoc {
  id: string;
  title: string;
  openedAt: string;
}

const KEY = "collab-editor:recent";
const MAX = 30;

export function getRecent(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentDoc[]) : [];
    return Array.isArray(list) ? list.filter((d) => typeof d?.id === "string") : [];
  } catch {
    return [];
  }
}

export function rememberDoc(id: string, title: string): void {
  try {
    const rest = getRecent().filter((d) => d.id !== id);
    const next = [{ id, title: title || "Untitled", openedAt: new Date().toISOString() }, ...rest].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable; the list just won't persist
  }
}

export function forgetDoc(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(getRecent().filter((d) => d.id !== id)));
  } catch {
    // ignore
  }
}
