/**
 * CopilotKit v2 runtime mount, copied from trust-graph ask/copilotRuntime.ts.
 * The runtime has no model and no key: its `default` agent is an HttpAgent that
 * loops back to our own POST /api/agui bridge. createCopilotEndpoint returns a
 * Hono app, adapted onto Fastify with one wildcard route that streams the web
 * Response (SSE) back out the raw socket.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CopilotRuntime, createCopilotEndpoint } from "@copilotkit/runtime/v2";
import { HttpAgent } from "@ag-ui/client";
import { config } from "./config.js";

export const COPILOT_RUNTIME_BASE_PATH = "/api/copilotkit";

function buildCopilotEndpoint() {
  const aguiUrl = `http://127.0.0.1:${config.port}/api/agui`;
  // Two planes, one runtime: `default` = shopper agents, `ops` = Ops Copilot (ops-mcp).
  const runtime = new CopilotRuntime({ agents: { default: new HttpAgent({ url: aguiUrl }), ops: new HttpAgent({ url: `${aguiUrl}/ops` }) } });
  return createCopilotEndpoint({ runtime, basePath: COPILOT_RUNTIME_BASE_PATH });
}

function toWebRequest(req: FastifyRequest): Request {
  const method = req.method.toUpperCase();
  const host = (req.headers.host as string) ?? `127.0.0.1:${config.port}`;
  const url = `http://${host}${req.raw.url ?? req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, String(v));
  }
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    const body = req.body;
    if (Buffer.isBuffer(body)) init.body = new Uint8Array(body);
    else if (typeof body === "string") init.body = body;
    else if (body != null) init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

async function sendWebResponse(reply: FastifyReply, res: Response): Promise<void> {
  reply.hijack();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  reply.raw.writeHead(res.status, headers);
  if (!res.body) {
    reply.raw.end();
    return;
  }
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) reply.raw.write(Buffer.from(value));
    }
  } finally {
    reply.raw.end();
  }
}

export async function registerCopilotRuntime(app: FastifyInstance): Promise<void> {
  const endpoint = buildCopilotEndpoint();
  await app.register(async (scope) => {
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.all(`${COPILOT_RUNTIME_BASE_PATH}/*`, async (req, reply) => {
      const webRes = await endpoint.fetch(toWebRequest(req));
      await sendWebResponse(reply, webRes);
    });
  });
}
