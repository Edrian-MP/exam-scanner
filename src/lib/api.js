const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  'http://localhost/exam-scanner/backend/api';

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error || `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    ...options,
  })
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

export { API_BASE };
