import { useCallback, useEffect, useRef, useState } from "react";

export interface Poll<T> {
  data: T | null;
  /** What failed, in words. Null while the endpoint answers. */
  error: string | null;
  loading: boolean;
  /** The body of the last failed response (often carries `fix`). */
  errorBody: any;
  refresh: () => void;
}

/** GET an endpoint now and every `ms` (0 = once). Keeps the last good payload across a failed poll. */
export function usePoll<T = any>(url: string | null, ms = 0): Poll<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [errorBody, setErrorBody] = useState<any>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!url) return;
    try {
      const r = await fetch(url);
      const body = await r.json().catch(() => null);
      if (!alive.current) return;
      if (!r.ok || body == null || (body && typeof body === "object" && "error" in body && body.error)) {
        const msg = body && typeof body === "object" && typeof (body as any).error === "string" ? (body as any).error : `${url} answered HTTP ${r.status}`;
        setError(msg);
        setErrorBody(body);
        if (body && r.ok) setData(body as T);
      } else {
        setData(body as T);
        setError(null);
        setErrorBody(null);
      }
    } catch {
      if (alive.current) setError(`The BFF did not answer ${url}`);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    if (!ms) return () => void (alive.current = false);
    const t = setInterval(() => void refresh(), ms);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh, ms]);

  return { data, error, loading, errorBody, refresh };
}
