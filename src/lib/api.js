const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  '/exam-scanner/backend/api';
const API_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || 10000);
const EDUCATOR_SESSIONS = import.meta.env.VITE_EDUCATOR_SESSIONS === '1';
const EDUCATOR_SESSION_ENDED = 'exam-scanner:educator-session-ended';

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (EDUCATOR_SESSIONS && response.status === 401 && data?.code === 'session_required') {
      window.dispatchEvent(new Event(EDUCATOR_SESSION_ENDED));
    }
    const message = data?.error || `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      ...options,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${API_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return parseResponse(response);
}

export async function apiGet(path) {
  return request(path)
}

export async function apiPost(path, body) {
  return request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body || {}),
  })
}

export async function apiDelete(path) {
  return request(path, { method: 'DELETE' })
}

export async function apiPut(path, body) {
  return request(path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body || {}),
  })
}

export { API_BASE, EDUCATOR_SESSIONS, EDUCATOR_SESSION_ENDED };
