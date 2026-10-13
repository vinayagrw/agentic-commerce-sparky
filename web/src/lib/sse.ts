/**
 * POST a JSON body and read a `data: {...}\n\n` SSE stream (the BFF's ?stream=1 variants for
 * follow-ups and photo). Calls onEvent for each event; resolves with the "done" event, rejects
 * with the "error" event's message. Aborting the signal cancels the server-side Claude run too.
 */
export async function postStream<T = any>(url: string, body: unknown, onEvent: (e: any) => void, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url.includes("?") ? `${url}&stream=1` : `${url}?stream=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `${res.status}`;
    try {
      const j = await res.json();
      msg = j.error ?? j.message ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let done: T | null = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (e.type === "error") throw new Error(String(e.error ?? "stream failed"));
      if (e.type === "done") done = e as T;
      onEvent(e);
    }
  }
  if (!done) throw new Error("stream ended before a result");
  return done;
}
