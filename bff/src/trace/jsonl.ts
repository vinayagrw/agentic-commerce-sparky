/**
 * Local JSONL span store: data/traces/YYYY-MM-DD.jsonl, one span per line.
 *
 * Line schema (shared with services/shop-mcp/src/shop_mcp/trace.py and services/search-svc/trace.py):
 *   { traceId, spanId, parentId, name, kind, service, start, end, attrs, status, events? }
 * start/end are epoch milliseconds. `kind` is the `sparky.kind` attribute.
 *
 * Volume cap: when the day file passes TRACE_FILE_MAX_MB (default 50) it is rotated to
 * YYYY-MM-DD.1.jsonl (replacing any older .1), and whole files are pruned oldest-first while
 * the directory exceeds 2x the cap. Several processes append to the same file; each line is
 * one appendFileSync (O_APPEND) so lines do not interleave.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const TRACE_DIR = process.env.SPARKY_TRACE_DIR ?? join(ROOT, "data", "traces");
export const MAX_BYTES = Number(process.env.TRACE_FILE_MAX_MB ?? 50) * 1024 * 1024;

export interface SpanLine {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  kind: string;
  service: string;
  start: number;
  end: number;
  attrs: Record<string, unknown>;
  status: "ok" | "error" | "unset";
  events?: { name: string; t: number; attrs?: Record<string, unknown> }[];
}

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function prune(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, st: statSync(join(dir, f)) }))
    .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
  let total = files.reduce((n, x) => n + x.st.size, 0);
  for (const x of files) {
    if (total <= 2 * MAX_BYTES) break;
    if (x.f === `${day()}.jsonl`) continue;
    unlinkSync(join(dir, x.f));
    total -= x.st.size;
  }
}

let writes = 0;
export function appendSpans(lines: SpanLine[], dir = TRACE_DIR) {
  if (!lines.length) return;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day()}.jsonl`);
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, join(dir, `${day()}.1.jsonl`));
      prune(dir);
    }
  } catch {
    /* another process rotated first */
  }
  appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (++writes % 200 === 0) {
    try {
      prune(dir);
    } catch {
      /* best effort */
    }
  }
}

/** All span lines, newest files last. Bounded by the rotation cap above. */
export function readSpans(dir = TRACE_DIR, filter?: (l: SpanLine) => boolean): SpanLine[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && /^\d{4}-\d{2}-\d{2}/.test(f))
    .sort((a, b) => a.replace(".1.jsonl", ".0.jsonl").localeCompare(b.replace(".1.jsonl", ".0.jsonl")));
  const out: SpanLine[] = [];
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const l = JSON.parse(line) as SpanLine;
        if (!filter || filter(l)) out.push(l);
      } catch {
        /* a torn line from a crash: skip */
      }
    }
  }
  return out;
}

const hrMs = (hr: [number, number]) => hr[0] * 1000 + hr[1] / 1e6;

/** Convert an OTel ReadableSpan (sdk-trace 2.x) to one line. */
export function toLine(span: any, service: string): SpanLine {
  const ctx = span.spanContext();
  const attrs = { ...(span.attributes ?? {}) } as Record<string, unknown>;
  const kind = String(attrs["sparky.kind"] ?? "other");
  delete attrs["sparky.kind"];
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    kind,
    service: String(span.resource?.attributes?.["service.name"] ?? service),
    start: Math.round(hrMs(span.startTime) * 1000) / 1000,
    end: Math.round(hrMs(span.endTime) * 1000) / 1000,
    attrs,
    status: span.status?.code === 2 ? "error" : span.status?.code === 1 ? "ok" : "unset",
    ...(span.events?.length ? { events: span.events.map((e: any) => ({ name: e.name, t: hrMs(e.time), ...(e.attributes ? { attrs: e.attributes } : {}) })) } : {}),
  };
}

/** SpanExporter writing JSONL. `isOn` is read per export so the file sink can be switched at runtime. */
export class JsonlSpanExporter {
  constructor(
    private service: string,
    private isOn: () => boolean,
    private dir = TRACE_DIR,
  ) {}
  export(spans: any[], cb: (r: { code: number; error?: Error }) => void) {
    if (!this.isOn()) return cb({ code: 0 });
    try {
      appendSpans(spans.map((s) => toLine(s, this.service)), this.dir);
      cb({ code: 0 });
    } catch (e) {
      cb({ code: 1, error: e as Error });
    }
  }
  shutdown() {
    return Promise.resolve();
  }
  forceFlush() {
    return Promise.resolve();
  }
}
