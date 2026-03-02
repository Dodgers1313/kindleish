// Cross-device sync via server REST API.
// All calls are fire-and-forget safe — failures are silently ignored
// so the app works offline with local storage as primary.

function getServerUrl() {
  return localStorage.getItem('kindleish:ocr-server') || '';
}

export function getUser() {
  return localStorage.getItem('kindleish:user') || '';
}

async function api(path, options = {}) {
  const user = getUser();
  if (!user) return null; // no user set — skip sync
  try {
    const headers = { ...options.headers, 'X-User': user };
    const resp = await fetch(`${getServerUrl()}${path}`, {
      signal: AbortSignal.timeout(options.timeout || 5000),
      ...options,
      headers
    });
    if (!resp.ok) return null;
    return resp;
  } catch {
    return null;
  }
}

export async function fetchLibrary() {
  const resp = await api('/api/library');
  if (!resp) return null;
  const data = await resp.json();
  return data.books || [];
}

export async function pushBookMeta(id, meta) {
  await api(`/api/library/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta)
  });
}

export async function deleteBookRemote(id) {
  await api(`/api/library/${id}`, { method: 'DELETE' });
}

export async function fetchContent(id) {
  const resp = await api(`/api/library/${id}/content`, { timeout: 30000 });
  if (!resp) return null;
  return await resp.text();
}

export async function pushContent(id, html) {
  await api(`/api/library/${id}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html' },
    body: html,
    timeout: 30000
  });
}

export async function fetchPosition(id) {
  const resp = await api(`/api/library/${id}/position`);
  if (!resp) return null;
  return await resp.json();
}

export async function pushPosition(id, position) {
  await api(`/api/library/${id}/position`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(position)
  });
}

export async function fetchBookmarks(id) {
  const resp = await api(`/api/library/${id}/bookmarks`);
  if (!resp) return null;
  return await resp.json();
}

export async function pushBookmarks(id, bookmarks) {
  await api(`/api/library/${id}/bookmarks`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookmarks)
  });
}
