export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const response = await fetch(`/api${url}`, { ...options, headers: { ...(options.body && !isForm ? { 'content-type': 'application/json' } : {}), 'x-commute-client': '1', ...options.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Something went wrong. Please try again.'); }
  return response.json();
}
export const post = <T,>(url: string, data?: unknown) => api<T>(url, { method: 'POST', ...(data ? { body: JSON.stringify(data) } : {}) });
