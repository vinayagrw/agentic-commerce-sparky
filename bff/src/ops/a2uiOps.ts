/**
 * A2UI v0.9 surfaces for ops-mcp `ui` hints. Basic catalog only (Column/Row/Card/Text/Image/Button/List);
 * charts are SVG data-URI Image components so the surfaces stay spec-pure.
 * Tolerant of shape differences between ops-mcp and search-svc payloads.
 */
import { canaryP95Guardrail } from "./gateConfig.js";
import type { A2uiComponent, A2uiMessage, OpsUiHint } from "@sparky/shared";
import { BASIC_CATALOG_ID } from "@sparky/shared";
import { agentName, opsToolMeta, OPS_AGENTS } from "./meta.js";
import { approvalsOf, normalizeAudit, normalizeGate } from "./reducer.js";

type Json = Record<string, any>;

class B {
  components: A2uiComponent[] = [];
  private n = 0;
  private id(p: string) {
    return `${p}_${++this.n}`;
  }
  add(c: Omit<A2uiComponent, "id"> & { id?: string }) {
    const id = c.id ?? this.id(c.component.toLowerCase());
    this.components.push({ ...c, id } as A2uiComponent);
    return id;
  }
  text(text: A2uiComponent["text"], variant?: string) {
    return this.add({ component: "Text", text, ...(variant ? { variant } : {}) });
  }
  img(url: string, variant = "chart") {
    return this.add({ component: "Image", url, variant });
  }
  row(children: string[], variant?: string) {
    return this.add({ component: "Row", children, ...(variant ? { variant } : {}) });
  }
  col(children: string[], id?: string) {
    return this.add({ component: "Column", children, ...(id ? { id } : {}) });
  }
  card(child: string, variant?: string) {
    return this.add({ component: "Card", child, ...(variant ? { variant } : {}) });
  }
  button(label: string, name: string, context: Record<string, string | number | boolean> = {}, variant = "primary") {
    return this.add({ component: "Button", child: this.text(label), variant, action: { event: { name, context } } });
  }
}

const num = (v: unknown, d = 3) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : v == null ? "–" : String(v));
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const svgUri = (w: number, h: number, body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" font-family="system-ui,sans-serif">${body}</svg>`)}`;

/** Champion vs candidate NDCG bars with the candidate's bootstrap CI on the delta. */
export function gateChart(ch: number, ca: number, ci: [number, number] | null): string {
  const W = 520, H = 170, x0 = 150, scale = (v: number) => x0 + ((W - x0 - 30) * Math.max(0, v - 0.4)) / 0.3;
  const bar = (y: number, v: number, fill: string, label: string) =>
    `<text x="10" y="${y + 20}" font-size="15" fill="#6b7280">${label}</text><rect x="${x0}" y="${y}" width="${scale(v) - x0}" height="30" rx="6" fill="${fill}"/><text x="${scale(v) + 6}" y="${y + 21}" font-size="15" font-weight="700" fill="#6b7280">${v.toFixed(3)}</text>`;
  let ciSvg = "";
  if (ci) {
    const lo = scale(ch + ci[0]), hi = scale(ch + ci[1]);
    ciSvg = `<line x1="${lo}" y1="${97}" x2="${hi}" y2="${97}" stroke="#111827" stroke-width="3"/><line x1="${lo}" y1="88" x2="${lo}" y2="106" stroke="#111827" stroke-width="3"/><line x1="${hi}" y1="88" x2="${hi}" y2="106" stroke="#111827" stroke-width="3"/>`;
  }
  const axis = [0.4, 0.5, 0.6, 0.7].map((t) => `<line x1="${scale(t)}" y1="20" x2="${scale(t)}" y2="130" stroke="#9ca3af" stroke-dasharray="3 3"/><text x="${scale(t)}" y="150" font-size="12" text-anchor="middle" fill="#6b7280">${t.toFixed(1)}</text>`).join("");
  return svgUri(W, H, `${axis}${bar(24, ch, "#0071dc", "Champion")}${bar(82, ca, ca >= ch ? "#1a7f37" : "#cf222e", "Candidate")}${ciSvg}<text x="10" y="166" font-size="11" fill="#6b7280">bar = NDCG@10 · whisker = 95% bootstrap CI of candidate − champion</text>`);
}

export function driftChart(timeline: Json[]): string {
  const W = 520, H = 190, pad = 40;
  const vals = timeline.map((t) => Number(t.mmd2 ?? t.mmd ?? 0));
  const max = Math.max(...vals, 0.001) * 1.15;
  const x = (i: number) => pad + ((W - pad * 2) * i) / Math.max(1, timeline.length - 1);
  const y = (v: number) => H - 40 - ((H - 70) * v) / max;
  const path = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = timeline.map((t, i) => `<circle cx="${x(i)}" cy="${y(vals[i])}" r="7" fill="${t.alert ? "#cf222e" : "#0071dc"}"/><text x="${x(i)}" y="${H - 18}" font-size="12" text-anchor="middle" fill="#6b7280">w${t.window ?? i}</text><text x="${x(i)}" y="${y(vals[i]) - 12}" font-size="11" text-anchor="middle" fill="#6b7280">p=${num(t.p_value, 3)}</text>`).join("");
  return svgUri(W, H, `<line x1="${pad}" y1="${H - 40}" x2="${W - pad}" y2="${H - 40}" stroke="#9ca3af"/><path d="${path}" fill="none" stroke="#0071dc" stroke-width="3"/>${dots}<text x="${pad}" y="16" font-size="12" fill="#6b7280">MMD² per window (red = alert, p &lt; 0.05)</text>`);
}

export function canaryChart(arms: Json): string {
  const W = 520, H = 150;
  const ch = arms?.champion ?? {}, ca = arms?.canary ?? {};
  // B02: the guardrail line is the threshold search-svc enforces (coverage.json gate_config), not a typed number.
  const guard = canaryP95Guardrail();
  const maxP95 = Math.max(Number(ch.p95_ms ?? 0), Number(ca.p95_ms ?? 0), guard ?? 0, 1) * 1.1;
  const row = (y: number, a: Json, label: string, fill: string) => {
    const w = (220 * Number(a.p95_ms ?? 0)) / maxP95;
    return `<text x="10" y="${y + 20}" font-size="14" fill="#6b7280">${esc(label)}</text><rect x="120" y="${y}" width="${w}" height="28" rx="5" fill="${fill}"/><text x="${126 + w}" y="${y + 19}" font-size="13" fill="#6b7280">p95 ${num(a.p95_ms, 0)}ms · NDCG ${num(a.ndcg10, 3)} · n=${a.requests ?? "–"}</text>`;
  };
  const limit = guard == null ? null : 120 + (220 * guard) / maxP95;
  const line = limit == null ? `<text x="120" y="130" font-size="11" fill="#cf222e">p95 guardrail unknown: data/coverage.json missing</text>` : `<line x1="${limit}" y1="10" x2="${limit}" y2="110" stroke="#cf222e" stroke-dasharray="4 3"/><text x="${limit}" y="130" font-size="11" text-anchor="middle" fill="#cf222e">p95 guardrail ${guard}ms</text>`;
  return svgUri(W, H, `${row(20, ch, "Champion", "#0071dc")}${row(70, ca, "Canary", guard != null && Number(ca.p95_ms) > guard ? "#cf222e" : "#ffc220")}${line}`);
}

/** Generic bar / line chart for an ops_insight series (labels + values, optional CI whiskers). */
export function insightChart(chart: { type?: string; unit?: string; series?: { label: string; value: number; ci?: [number, number] | null }[] }): string | null {
  const pts = (chart.series ?? []).filter((p) => typeof p.value === "number" && Number.isFinite(p.value)).slice(-16);
  if (!pts.length) return null;
  const W = 560, H = 236, L = 46, R = 14, T = 40, Bm = 58;
  const vals = pts.flatMap((p) => [p.value, ...(p.ci ?? [])]).filter((v) => Number.isFinite(v));
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi === lo) hi = lo + 1;
  const y = (v: number) => T + ((H - T - Bm) * (hi - v)) / (hi - lo);
  const step = (W - L - R) / pts.length;
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
  let body = `<line x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}" stroke="#9ca3af"/><text x="4" y="14" font-size="12" fill="#6b7280">${esc(chart.unit ?? "")}</text>`;
  body += [hi, lo].map((v) => `<text x="${L - 4}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="#6b7280">${fmt(v)}</text>`).join("");
  if (chart.type === "line") {
    const path = pts.map((p, i) => `${i ? "L" : "M"}${(L + step * (i + 0.5)).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    body += `<path d="${path}" fill="none" stroke="#0071dc" stroke-width="3"/>`;
    body += pts.map((p, i) => `<circle cx="${L + step * (i + 0.5)}" cy="${y(p.value)}" r="4" fill="#0071dc"/>`).join("");
  } else {
    body += pts
      .map((p, i) => {
        const x = L + step * i + step * 0.15, w = step * 0.7, top = Math.min(y(p.value), y(0)), h = Math.max(1, Math.abs(y(p.value) - y(0)));
        const ci = p.ci && p.ci.length === 2 ? `<line x1="${x + w / 2}" y1="${y(p.ci[0])}" x2="${x + w / 2}" y2="${y(p.ci[1])}" stroke="#111827" stroke-width="2"/>` : "";
        return `<rect x="${x}" y="${top}" width="${w}" height="${h}" rx="3" fill="${p.value < 0 ? "#cf222e" : "#0071dc"}"/>${ci}<text x="${x + w / 2}" y="${top - 4}" font-size="10" text-anchor="middle" fill="#6b7280">${fmt(p.value)}</text>`;
      })
      .join("");
  }
  body += pts.map((p, i) => `<text transform="translate(${L + step * (i + 0.5)},${H - Bm + 14}) rotate(30)" font-size="11" fill="#6b7280">${esc(String(p.label).slice(0, 18))}</text>`).join("");
  return svgUri(W, H, body);
}

function header(b: B, data: Json, title: string): string[] {
  const m = opsToolMeta(String(data.provenance?.tool ?? ""));
  const name = agentName(data.agent, String(data.provenance?.tool ?? ""));
  const def = Object.values(OPS_AGENTS).find((a) => a.agent === name);
  const avatar = def?.avatar ?? m.avatar;
  const tier = String(data.tier ?? m.tier);
  return [
    b.row([b.text(avatar, "avatar"), b.col([b.text(title, "h3"), b.row([b.text(name, "strong"), b.text(tier, `tier tier-${tier}`), b.text(`source: ${data.provenance?.source ?? "ops-mcp"}`, "caption")])])], "head"),
  ];
}

export function buildOpsA2ui(hint: OpsUiHint, data: Json, surfaceId: string): A2uiMessage[] {
  const b = new B();
  const root: string[] = [];
  let model: Json = {};

  switch (hint) {
    case "alert": {
      const cur = data.current;
      root.push(...header(b, data, String(data.title ?? (data.alert_id ? `Drift alert ${data.alert_id}` : data.error ? "Action refused" : "Alert"))));
      root.push(b.text(String(data.message ?? data.recommendation ?? (typeof data.error === "string" ? `${data.error}${data.detail ? `: ${typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)}` : ""}` : "")), data.blocked || data.error ? "warning" : undefined));
      if (cur && Array.isArray(data.timeline)) {
        root.push(b.text(`MMD² ${num(cur.mmd2, 4)} · p=${num(cur.p_value, 3)} · est NDCG@10 ${num(cur.est_ndcg10, 3)} (Δ ${num(cur.est_ndcg10_delta, 3)}) · zero-result ${num(cur.zero_result_rate, 3)}`, "strong"));
        root.push(b.img(driftChart(data.timeline)));
      }
      if (data.alert_id && !data.severity) data = { ...data, severity: "high" };
      if (data.severity) root.push(b.text(`severity: ${data.severity}`, data.severity === "high" ? "fail" : "caption"));
      root.splice(0, root.length, b.card(b.col([...root]), data.severity === "high" || data.blocked ? "danger" : undefined));
      break;
    }
    case "approval": {
      const id = String(data.approval_id ?? data.id ?? "");
      const found = approvalsOf(data);
      const kind = String(data.kind ?? found[0]?.kind ?? "remediation");
      const opts: Json[] = Array.isArray(data.options) ? data.options : Array.isArray(data.proposals) ? data.proposals : [];
      const kids = [...header(b, data, String(data.title ?? (data.proposals ? "Approve a remediation" : data.error === "awaiting_human_approval" ? `Approval required: ${kind} ${data.version ?? data.remediation_id ?? ""}` : "Approval required")))];
      if (data.rationale || data.diagnosis) kids.push(b.text(String(data.rationale ?? data.diagnosis), "caption"));
      if (data.proposals && !data.proposals.length) kids.push(b.text(`No remediation proposed: ${data.trigger_rule?.rule ?? "trigger rule did not fire"}`, "warning"));
      kids.push(b.text(`Requires ${data.requires ?? "human approval"} · status ${data.status ?? "pending"} · the agent cannot approve itself`, "caption"));
      if (opts.length) {
        for (const o of opts) {
          const cost = o.cost_usd ?? o.cost?.cost_usd;
          const gain = o.expected_gain_ndcg ?? o.expected_ndcg_gain;
          const ol = o.gate_outlook as Json | undefined;
          const delta = ol?.ndcg10_delta ?? gain;
          const deltaLabel = delta != null ? `${ol?.basis?.startsWith("measured") ? "measured" : "expected"} ΔNDCG ${delta >= 0 ? "+" : ""}${num(delta, 4)}${ol?.ci95 ? ` CI [${(ol.ci95 as number[]).map((v) => num(v, 4)).join(", ")}]` : ""}` : "";
          const meta = [cost != null ? `cost $${num(cost, 2)}` : "", o.cpu_min != null ? `${o.cpu_min} CPU-min` : "", deltaLabel, o.cost?.roi != null ? `ROI ${num(o.cost.roi, 1)}` : "", o.eta_min != null ? `${o.eta_min} min` : ""].filter(Boolean).join(" · ");
          const title = `${o.recommended ? "★ Recommended — " : ""}${o.title ?? o.id}`;
          const col = [b.text(title, "h5"), b.text(meta, "caption")];
          if (ol?.expectation) col.push(b.text(`gate outlook: ${String(ol.expectation).replace(/_/g, " ")} · ${ol.risk ?? ""}`, ol.expectation === "likely_fail" ? "warning" : "caption"));
          else if (o.recommendation_reason) col.push(b.text(String(o.recommendation_reason), "caption"));
          kids.push(b.card(b.row([b.col(col), b.button("Approve", "ops_approve", { approval_id: String(o.approval_id ?? id), choice: String(o.option_id ?? o.id ?? ""), kind })]), "option"));
        }
        kids.push(b.button("Reject", "ops_reject", { approval_id: String(opts[0]?.approval_id ?? id), kind }, "secondary"));
      } else if (id) {
        kids.push(b.row([b.button("Approve", "ops_approve", { approval_id: id, kind, choice: String(data.version ?? "") }), b.button("Reject", "ops_reject", { approval_id: id, kind }, "secondary")]));
      }
      root.push(b.card(b.col(kids), "highlight"));
      break;
    }
    case "eval_gate": {
      if (data.error) {
        const kids = [...header(b, data, "Eval gate: release refused"), b.text(`${data.error}${data.gate ? ` · ${JSON.stringify(data.gate)}` : ""}`, "warning")];
        root.push(b.card(b.col(kids), "danger"));
        break;
      }
      data = normalizeGate(data);
      const nd = data.metrics?.ndcg10 ?? {};
      const ch = Number(nd.champion ?? data.champion_ndcg ?? 0), ca = Number(nd.candidate ?? data.candidate_ndcg ?? 0);
      const ci = (nd.delta?.ci95 ?? data.ci95 ?? null) as [number, number] | null;
      const passed = Boolean(data.passed ?? data.gate?.passed ?? data.verdict === "PASS");
      const kids = [...header(b, data, `Eval gate: ${data.candidate ?? "candidate"} vs ${data.champion ?? "champion"}`)];
      kids.push(b.row([b.text(passed ? "PASS" : "FAIL", passed ? "pass" : "fail"), b.text(`ΔNDCG@10 ${num(nd.delta?.mean ?? ca - ch, 4)} · 95% CI [${ci ? ci.map((v) => num(v, 3)).join(", ") : "–"}] · n=${data.n_queries ?? "–"}`, "strong")]));
      kids.push(b.img(gateChart(ch, ca, ci)));
      const pk = data.pass_k ?? data.passk ?? {};
      const rt = data.red_team ?? {};
      const checks = data.gate?.checks ?? {};
      kids.push(b.row([b.text(`pass^k ${num(pk.pass_hat_k ?? pk.value ?? pk.pass_k, 2)} (k=${pk.k ?? "–"}, ≥${pk.threshold ?? 0.8})`, "chip"), b.text(`red-team ${rt.blocked ?? "–"}/${rt.attacks ?? "–"} blocked`, "chip"), ...Object.entries(checks).map(([k, v]) => b.text(`${v ? "✔" : "✖"} ${k.replace(/_/g, " ")}`, v ? "chip ok" : "chip bad"))]));
      if (!passed) kids.push(b.text("Release blocked: the candidate does not beat the champion with a CI excluding 0.", "warning"));
      root.push(b.card(b.col(kids), passed ? "ok" : "danger"));
      break;
    }
    case "drift_chart": {
      const tl: Json[] = Array.isArray(data.timeline) ? data.timeline : Array.isArray(data.windows) ? data.windows : [];
      const cur = data.current ?? tl[tl.length - 1] ?? {};
      const kids = [...header(b, data, `Drift: ${data.stream ?? "query stream"}`)];
      kids.push(b.row([b.text(cur.alert ? "ALERT" : "OK", cur.alert ? "fail" : "pass"), b.text(`MMD² ${num(cur.mmd2, 4)} · p=${num(cur.p_value, 3)} · est NDCG@10 ${num(cur.est_ndcg10, 3)} (Δ ${num(cur.est_ndcg10_delta, 3)}) · zero-result ${num(cur.zero_result_rate, 3)}`, "strong")]));
      if (tl.length) kids.push(b.img(driftChart(tl)));
      if (data.stream_source) kids.push(b.text(String(data.stream_source), "caption"));
      root.push(b.card(b.col(kids)));
      break;
    }
    case "canary": {
      const arms = data.arms ?? {};
      const g = data.guardrail ?? {};
      const kids = [...header(b, data, `Canary ${data.version ?? ""} at ${data.traffic_pct ?? "–"}% traffic`)];
      const st = String(data.status ?? "running");
      kids.push(b.row([b.text(st.toUpperCase(), st === "rolled_back" ? "fail" : st === "promoted" ? "pass" : "chip"), b.text(`split ${100 - Number(data.traffic_pct ?? 10)}/${data.traffic_pct ?? 10} champion/canary`, "caption")]));
      kids.push(b.img(canaryChart(arms)));
      if (g.breached || data.ended_reason) kids.push(b.text(`Guardrail: ${(g.reasons ?? [data.ended_reason]).filter(Boolean).join("; ")} → automatic rollback (T3)`, "warning"));
      root.push(b.card(b.col(kids), st === "rolled_back" ? "danger" : undefined));
      break;
    }
    case "registry": {
      const versions: Json[] = Array.isArray(data.versions) ? data.versions : [];
      const kids = [...header(b, data, "Model registry")];
      kids.push(b.row([b.text(`champion ${data.champion ?? "–"}`, "chip ok"), b.text(`candidate ${data.candidate ?? data.candidate_version ?? data.version ?? "–"}`, "chip"), data.status ? b.text(String(data.status), "chip") : b.text("")]));
      kids.push(b.row(["version", "status", "config"].map((h) => b.text(h, "th")), "table"));
      for (const v of versions.slice(-6)) kids.push(b.row([b.text(String(v.version ?? v.name)), b.text(String(v.status ?? v.alias ?? "")), b.text(JSON.stringify(v.config ?? {}).slice(0, 80), "caption")], "table"));
      root.push(b.card(b.col(kids)));
      break;
    }
    case "mlbom": {
      const sig = data.signature ?? {};
      const verified = Boolean(sig.verified ?? data.verification?.verified ?? data.verified ?? data.signed);
      const kids = [...header(b, data, `Signature${data.bom ? " + ML-BOM" : ""}: ${data.version ?? ""}`)];
      kids.push(b.row([b.text(verified ? "✔ signature verified" : "✖ unverified", verified ? "pass" : "fail"), b.text(`${sig.alg ?? ""} ${String(sig.digest ?? "").slice(0, 26)}…`, "caption")]));
      const { ui: _u, provenance: _p, agent: _a, tier: _t, ...rest } = data;
      model = { bom: JSON.stringify(data.bom ?? rest, null, 2) };
      kids.push(b.text({ path: "/bom" }, "json"));
      root.push(b.card(b.col(kids)));
      break;
    }
    case "audit": {
      const entries = normalizeAudit(Array.isArray(data.entries) ? data.entries : Array.isArray(data.log) ? data.log : []) as Json[];
      const kids = [...header(b, data, "Audit log")];
      kids.push(b.row(["time", "actor", "agent · tier", "action", "approval"].map((h) => b.text(h, "th")), "table"));
      for (const e of entries.slice(-14)) {
        const ts = String(e.ts ?? e.time ?? "").replace(/^.*T/, "").slice(0, 8);
        kids.push(b.row([b.text(ts, "caption"), b.text(String(e.actor ?? "")), b.text(`${e.agent ?? ""} · ${e.tier ?? ""}`), b.text(`${e.action ?? e.event ?? ""}${e.detail ? ` — ${e.detail}` : ""}`), b.text(String(e.approval ?? "—"), "caption")], "table"));
      }
      root.push(b.card(b.col(kids)));
      break;
    }
    case "label_queue": {
      const items: Json[] = (Array.isArray(data.items) ? data.items : Array.isArray(data.human_review_queue) ? data.human_review_queue.map((x: Json) => ({ ...x, needs_review: true })) : []).map((x: Json) => ({ ...x, label: x.label ?? x.model_label ?? "?", query: x.query ?? x.title ?? x.product_title }));
      const review = items.filter((i) => i.needs_review);
      const kids = [...header(b, data, `Label review queue (${review.length} of ${items.length} need a human)`)];
      const agree = data.agreement_vs_esci_heldout ?? data.agreement;
      if (agree != null) kids.push(b.text(`Labeling agent (LLM labels, not the lexical online judge) vs ESCI held-out labels: ${num(agree, 2)}${data.cohens_kappa != null ? ` · Cohen's κ ${num(data.cohens_kappa, 2)}` : ""} · review threshold ${data.review_threshold ?? 0.7}`, "caption"));
      kids.push(b.row(["query", "label", "conf", "status"].map((h) => b.text(h, "th")), "table"));
      for (const it of items.slice(0, 10)) kids.push(b.row([b.text(String(it.query)), b.text(String(it.label), "strong"), b.text(num(it.confidence, 2)), b.text(it.needs_review ? "needs review" : it.reviewed_by ? "human ✔" : "auto", it.needs_review ? "warning" : "caption")], "table"));
      if (review.length) kids.push(b.button(`Confirm ${review.length} low-confidence label(s)`, "label_submit", { item_ids: review.map((r) => r.item_id).join(","), labels: review.map((r) => r.label).join(",") }));
      root.push(b.card(b.col(kids)));
      break;
    }
    case "dq_report": {
      const checks: Json[] = Array.isArray(data.checks)
        ? data.checks
        : (Array.isArray(data.gates) ? data.gates : []).map((g: Json) => ({ name: g.gate ?? g.name, status: g.status, value: g.value ?? g.rate ?? g.count, threshold: g.threshold ?? g.max ?? g.min ?? "–" }));
      const issues: string[] = Array.isArray(data.issues) ? data.issues : data.issue ? [`${data.issue.title ?? "Issue opened"}: ${(data.issue.gates ?? []).join(", ")} → ${data.issue.suggested_owner ?? "owner"}`] : [];
      if (data.near_duplicates?.pairs != null) issues.push(`near-duplicates: ${data.near_duplicates.pairs} pairs (${data.near_duplicates.method ?? "MinHash"})`);
      if (data.price_outliers?.count != null) issues.push(`price outliers: ${data.price_outliers.count}`);
      data = { ...data, issues };
      const kids = [...header(b, data, `Data quality: ${data.dataset ?? data.category ?? "catalog"} (${data.rows ?? data.products ?? "–"} rows)${data.verdict ? ` · ${String(data.verdict).toUpperCase()}` : ""}`)];
      for (const c of checks) kids.push(b.row([b.text(c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "WARN", c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "warnbadge"), b.text(String(c.name)), b.text(`${num(c.value, 3)} (threshold ${c.threshold})`, "caption")], "line"));
      for (const i of (data.issues ?? []).slice(0, 6)) kids.push(b.text(`• ${i}`, "caption"));
      root.push(b.card(b.col(kids)));
      break;
    }
    case "ops_insight": {
      const kids = [...header(b, data, String(data.title ?? "Ops insight"))];
      if (data.summary) kids.push(b.text(String(data.summary), "strong"));
      const facts = (data.facts ?? []) as Json[];
      if (facts.length) kids.push(b.row(facts.slice(0, 6).map((f) => b.text(`${f.label}: ${typeof f.value === "object" ? JSON.stringify(f.value) : f.value}${f.cite ? ` [${f.cite}]` : ""}`, "chip")), "wrap"));
      const chart = data.chart ? insightChart(data.chart) : null;
      if (chart) kids.push(b.img(chart));
      for (const f of ((data.findings ?? []) as Json[]).slice(0, 8)) {
        const sev = String(f.severity ?? "");
        kids.push(b.row([b.text(sev ? sev.toUpperCase() : "•", sev === "high" ? "fail" : sev === "medium" ? "warnbadge" : "caption"), b.text(String(f.finding ?? f.what ?? "")), b.text(String(f.cite ?? ""), "caption")], "line"));
      }
      for (const n of ((data.notifications ?? []) as Json[]).slice(0, 6)) kids.push(b.row([b.text(String(n.severity).toUpperCase(), n.severity === "high" ? "fail" : "warnbadge"), b.col([b.text(String(n.message)), b.text(`next: ${n.next_action} · ${n.cite}`, "caption")])], "line"));
      for (const c of ((data.clusters ?? []) as Json[]).slice(0, 6)) kids.push(b.row([b.text(String(c.cluster), "strong"), b.text(`n=${c.n} · NDCG@10 ${num(c.ndcg10, 4)} (${c.gap >= 0 ? "+" : ""}${num(c.gap, 4)}) · fix (proposal): ${c.suggested_fix}`, "caption")], "line"));
      for (const a of ((data.anomalies ?? []) as Json[]).slice(0, 5)) kids.push(b.text(`anomaly: ${a.role} run ${String(a.run_id ?? "").slice(0, 8)} $${num(a.cost_usd, 4)} vs median $${num(a.median_role_cost, 4)} (z ${a.robust_z})`, "warning"));
      if (typeof data.markdown === "string") for (const line of data.markdown.split("\n").filter(Boolean).slice(0, 24)) kids.push(b.text(line.replace(/^#+\s*/, "").replace(/`/g, ""), /^#/.test(line) ? "h5" : "caption"));
      const table = data.table as Json | undefined;
      if (table?.columns?.length && table.rows?.length) {
        kids.push(b.row((table.columns as string[]).map((h) => b.text(String(h), "th")), "table"));
        for (const r of (table.rows as unknown[][]).slice(0, 12)) kids.push(b.row(r.map((c) => b.text(typeof c === "number" ? num(c, Math.abs(c) >= 100 ? 0 : 4) : String(c ?? ""))), "table"));
        if (table.rows.length > 12) kids.push(b.text(`… ${table.rows.length - 12} more row(s)`, "caption"));
      }
      const cites = (data.citations ?? []) as Json[];
      if (cites.length) kids.push(b.text(`Sources: ${cites.map((c) => `${c.source}${c.ref ? ` ${c.ref}` : ""}`).join(" · ")}`, "caption"));
      if (data.n != null) kids.push(b.text(`n = ${data.n}`, "caption"));
      root.push(b.card(b.col(kids), data.kind === "watch_alerts" && (data.notifications ?? []).length ? "danger" : undefined));
      model = { kind: data.kind };
      break;
    }
    case "finops": {
      const c = data.cost_per_1k ?? {};
      const t = data.cost_per_fulfilled_task_usd ?? {};
      const kids = [...header(b, data, "FinOps router: cheap path vs Claude path")];
      kids.push(b.row([b.text(`$${num(c.routed, 2)} / 1k routed`, "pass"), b.text(`$${num(c.all_claude, 2)} / 1k all-Claude`, "chip"), b.text(`−${num(c.savings_pct, 1)}%`, "chip ok")]));
      kids.push(b.text(`Cost per fulfilled task: routed $${num(t.routed, 4)} vs all-Claude $${num(t.all_claude, 4)}`, "strong"));
      for (const p of data.paths ?? []) kids.push(b.row([b.text(String(p.path), "strong"), b.text(`share ${Math.round(Number(p.share) * 100)}% · $${p.cost_per_query_usd}/query · p95 ${p.p95_ms}ms · fulfilment ${p.fulfilment}`, "caption")], "line"));
      for (const s of (data.sample ?? []).slice(0, 8)) kids.push(b.row([b.text(s.route === "claude" ? "🧠 Claude" : "⚡ cheap", s.route === "claude" ? "chip" : "chip ok"), b.text(String(s.query))], "line"));
      if (data.rule) kids.push(b.text(String(data.rule), "caption"));
      root.push(b.card(b.col(kids)));
      break;
    }
  }

  b.col(root, "root");
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: BASIC_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components: b.components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: model } },
  ];
}
