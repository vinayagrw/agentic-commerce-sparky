/** Minimal SSE channel for non-AG-UI streams (follow-ups, photo): `data: {type, ...}\n\n`. */
import type { FastifyReply, FastifyRequest } from "fastify";

export function wantsStream(req: FastifyRequest): boolean {
  return (req.query as any)?.stream === "1" || /text\/event-stream/.test(String(req.headers.accept ?? ""));
}

export function openSse(_req: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const ac = new AbortController();
  // Only the response socket: req.raw "close" fires as soon as the POST body has been read.
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) ac.abort();
  });
  return {
    signal: ac.signal,
    send: (e: Record<string, unknown>) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify({ ...e, timestamp: Date.now() })}\n\n`);
    },
    end: () => reply.raw.end(),
  };
}
