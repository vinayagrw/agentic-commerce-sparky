/** Tiny never-throwing JSON fetch with timeout, used for search-svc / shop-http. */
export interface JRes<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

export async function jfetch<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<JRes<T>> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 3000);
  try {
    const headers = { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) };
    const res = await fetch(url, { ...init, headers, signal: ctl.signal });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}
