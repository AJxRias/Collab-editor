export interface DocMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface VersionMeta {
  id: number;
  docId: string;
  label: string;
  createdAt: string;
  sizeBytes: number;
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  listDocs: () => request<DocMeta[]>("/docs"),
  createDoc: (title?: string) => request<DocMeta>("/docs", { method: "POST", body: { title } }),
  getDoc: (id: string) => request<DocMeta>(`/docs/${id}`),
  renameDoc: (id: string, title: string) => request<DocMeta>(`/docs/${id}`, { method: "PATCH", body: { title } }),
  listVersions: (id: string) => request<VersionMeta[]>(`/docs/${id}/versions`),
  saveVersion: (id: string, label: string) =>
    request<VersionMeta>(`/docs/${id}/versions`, { method: "POST", body: { label: label || undefined } }),
  previewVersion: (id: string, versionId: number) =>
    request<VersionMeta & { text: string }>(`/docs/${id}/versions/${versionId}/preview`),
  restoreVersion: (id: string, versionId: number) =>
    request<{ restored: VersionMeta }>(`/docs/${id}/versions/${versionId}/restore`, { method: "POST" }),
};

export function wsBaseUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}
