const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const STORAGE_KEY = 'freellmapi_auth_key';

export function getAuthKey(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const authKey = getAuthKey();
  const headers: HeadersInit = { 'Content-Type': 'application/json', ...options?.headers };
  if (authKey) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${authKey}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
    if (res.status === 401) {
      sessionStorage.removeItem(STORAGE_KEY);
      window.location.href = `${BASE}/login`;
    }
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json();
}
