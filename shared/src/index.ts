/** Shared contracts between bff and web for Compass. */

/**
 * The assistant's display name, and the accessible names built from it.
 *
 * These live here because the storefront renders them and the e2e specs resolve elements BY them:
 * `aria-label="Compass chat"` in StoreLayout is literally the selector in web/e2e/helpers.ts. When
 * the two were separate literals, renaming the assistant (Sparky -> Compass, Wave 13) silently broke
 * every spec that reaches the chat region. One constant, imported by both sides, makes the next
 * rename a one-line change that cannot drift.
 */
export const ASSISTANT_NAME = "Compass";
export const CHAT_REGION_LABEL = `${ASSISTANT_NAME} chat`;
export const CHAT_COMPOSER_LABEL = `Message ${ASSISTANT_NAME}`;
export const CHAT_SHEET_LABEL = `Ask ${ASSISTANT_NAME}`;
export const MEMORY_DIALOG_LABEL = `What ${ASSISTANT_NAME} remembers`;

/**
 * Where a number came from. Every figure rendered in the UI must carry one: there is
 * no fixture or simulation path left, so a number with no provenance is a bug, and
 * `Measured<T>` makes that a type error rather than a review comment.
 */
export interface Provenance {
  /** The service that computed it: "search-svc" | "shop-http" | "ops-http" | "policy-mcp" | "claude-cli" | "bff". */
  service: string;
  /** The exact endpoint / tool that produced it, e.g. "POST /eval/ndcg" or "mcp__policy__search_products". */
  endpoint: string;
  /** ISO-8601 instant the value was measured. */
  timestamp: string;
  /** Optional one-line method note ("paired bootstrap, 1000 resamples"). */
  note?: string;
}

/** A number (or any value) that cannot be rendered without saying where it came from. */
export interface Measured<T = number> {
  value: T;
  provenance: Provenance;
}

export function measured<T>(value: T, service: string, endpoint: string, note?: string): Measured<T> {
  return { value, provenance: { service, endpoint, timestamp: new Date().toISOString(), ...(note ? { note } : {}) } };
}

export function isMeasured(x: unknown): x is Measured<unknown> {
  const m = x as Measured<unknown> | null;
  return Boolean(m && typeof m === "object" && "value" in m && m.provenance && typeof m.provenance.service === "string");
}

/** One backing service the app refuses to run without. Drives the red health banners. */
export interface ServiceDef {
  /** Key in the /api/diag payload. */
  key: "searchSvc" | "shopHttp" | "opsHttp" | "policyMcp" | "claude";
  name: string;
  port: number | null;
  /** Shown verbatim in the banner. */
  fix: string;
  /** Planes that cannot run at all without it. */
  requiredFor: Plane[];
}

export const SERVICES: ServiceDef[] = [
  { key: "searchSvc", name: "search-svc", port: 8801, fix: "make dev", requiredFor: ["shopper", "ops"] },
  { key: "shopHttp", name: "shop-http", port: 8802, fix: "make dev", requiredFor: ["shopper"] },
  { key: "opsHttp", name: "ops-http", port: 8803, fix: "make dev", requiredFor: ["ops"] },
  { key: "policyMcp", name: "policy-mcp", port: null, fix: "cd services/policy-mcp && uv sync", requiredFor: ["shopper", "ops"] },
  { key: "claude", name: "Claude CLI", port: null, fix: "claude login", requiredFor: ["shopper", "ops"] },
];

/** One unavailable service, as the banner renders it. */
export interface ServiceOutage {
  key: ServiceDef["key"];
  name: string;
  port: number | null;
  fix: string;
  detail?: string;
}

/** Why a run could not start. There is no scripted substitute: the run refuses. */
export type RefusalReason =
  | "service-unavailable"
  | "spawn-failed"
  | "not-authenticated"
  | "no-tools"
  | "timeout"
  | "empty-output"
  | "policy-refused";

export interface PlanStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "blocked";
}

export interface ConstraintEntry {
  key: string;
  value: string;
  status: "ok" | "violated" | "unknown";
  note?: string;
}

export interface CartLine {
  product_id: string;
  title: string;
  qty: number;
  price: number;
  sponsored?: boolean;
}

export interface TraceEntry {
  id: string;
  tool: string;
  args: unknown;
  latency_ms: number;
  ok: boolean;
}

export interface GuardEvent {
  id: string;
  kind: "injection" | "qty_jump" | "budget" | "tool_denied" | "quarantine" | "capability";
  severity: "warn" | "block";
  message: string;
  tool?: string;
  /** Where the decision was made. policy-mcp is the proxy the CLI talks to, so its blocks are pre-execution. */
  source?: "bff" | "shop-mcp" | "policy-mcp";
  /** The policy rule that fired, e.g. "qty_limit" or "capability.untrusted_arg". */
  rule?: string;
}

export type Tier = "T0" | "T1" | "T2" | "T3" | "—";

/** One agent role in a run (Planner / Shopper / Critic / Checkout, or an ops agent). */
export interface AgentRole {
  name: string;
  tier: Tier;
  status: "idle" | "running" | "done" | "blocked" | "skipped";
  model?: string;
  tokens?: { input: number; output: number };
  cost_usd?: number;
  note?: string;
}

export type LifecycleStage = "Data" | "Validate" | "Deploy" | "Monitor" | "Retrain";
export const LIFECYCLE: LifecycleStage[] = ["Data", "Validate", "Deploy", "Monitor", "Retrain"];

export interface AuditRow {
  ts: string;
  actor: string;
  agent?: string;
  tier?: Tier | string;
  action: string;
  approval?: string;
  detail?: string;
}

export interface OpsApproval {
  approval_id: string;
  kind: "remediation" | "promote" | string;
  status: "pending" | "approved" | "rejected";
  title?: string;
  choice?: string;
  /** ops-mcp subject the approval is about: remediation_id, or the version for a promote. */
  subject?: string;
}

/** MLOps-plane shared state (Ops Copilot). Latest payload per surface kind. */
export interface OpsState {
  stage: LifecycleStage | null;
  active_agent: string | null;
  tier: Tier | null;
  approvals: OpsApproval[];
  alerts: any[];
  dq: any | null;
  labels: any | null;
  drift: any | null;
  gate: any | null;
  canary: any | null;
  registry: any | null;
  mlbom: any | null;
  finops: any | null;
  audit: AuditRow[];
  candidate: string | null;
  worse_candidate: boolean;
}

export function emptyOps(): OpsState {
  return { stage: null, active_agent: null, tier: null, approvals: [], alerts: [], dq: null, labels: null, drift: null, gate: null, canary: null, registry: null, mlbom: null, finops: null, audit: [], candidate: null, worse_candidate: false };
}

export interface Mandate {
  mandate_id: string;
  status: "pending_approval" | "approved" | "rejected";
  cart_total: number;
  spend_cap: number;
  signature?: string;
  [k: string]: unknown;
}

export interface AgentState {
  beat: number;
  plan: PlanStep[];
  constraints: ConstraintEntry[];
  omissions: string[];
  cart: CartLine[];
  cart_total: number;
  budget: number | null;
  trace: TraceEntry[];
  tokens: { input: number; output: number };
  cost_usd: number;
  guard_events: GuardEvent[];
  mandate: Mandate | null;
  /** "live" = real services + real Claude. "refused" = a dependency was missing and the run stopped. */
  mode: "live" | "refused";
  refusal?: { reason: RefusalReason; message: string; outages: ServiceOutage[] };
  plane: Plane;
  agents: AgentRole[];
  ops: OpsState;
  /** Capability-tagged variables produced by the CaMeL quarantined LLM (technique 36). */
  camel?: CamelTrace;
}

/** One value the quarantined LLM extracted from untrusted content. Never a tool argument unless policy allows. */
export interface CamelVariable {
  name: string;
  type: "string" | "number" | "product_id" | "boolean";
  value: string | number | boolean;
  /** "trusted" = from the user or a typed tool result; "untrusted" = derived from seller text etc. */
  capability: "trusted" | "untrusted";
  origin: string;
}

export interface CamelTrace {
  /** The privileged planner's steps. It only ever saw variable names, never untrusted text. */
  plan: { step: number; tool: string; args: Record<string, string | number | boolean>; note?: string }[];
  variables: CamelVariable[];
  /** Calls the executor attempted and what policy-mcp decided. */
  decisions: { tool: string; allowed: boolean; reason?: string; rule?: string }[];
}

/** "coverage" is the technique coverage board: a route with no agent, chat or beats. */
export type Plane = "shopper" | "ops" | "coverage";

export function emptyState(beat = 1, plane: Plane = "shopper"): AgentState {
  return {
    beat,
    plan: [],
    constraints: [],
    omissions: [],
    cart: [],
    cart_total: 0,
    budget: null,
    trace: [],
    tokens: { input: 0, output: 0 },
    cost_usd: 0,
    guard_events: [],
    mandate: null,
    mode: "live",
    plane,
    agents: [],
    ops: emptyOps(),
  };
}

/** UI hints a shop tool result may carry, mapped to an A2UI surface. */
export type UiHint =
  | "product_grid"
  | "compare_table"
  | "cart"
  | "substitutes"
  | "mandate"
  | "storefront"
  | "agent_api"
  | "could_not_do"
  | OpsUiHint;

/** UI hints carried by ops-mcp tool results (MLOps plane). */
export type OpsUiHint = "alert" | "approval" | "eval_gate" | "drift_chart" | "canary" | "registry" | "mlbom" | "audit" | "label_queue" | "dq_report" | "finops" | "ops_insight";
export const OPS_UI_HINTS: OpsUiHint[] = ["alert", "approval", "eval_gate", "drift_chart", "canary", "registry", "mlbom", "audit", "label_queue", "dq_report", "finops", "ops_insight"];

export const UI_HINTS: UiHint[] = [
  "product_grid",
  "compare_table",
  "cart",
  "substitutes",
  "mandate",
  "storefront",
  "agent_api",
  "could_not_do",
  ...OPS_UI_HINTS,
];

/** A2UI v0.9 (public preview) message subset we emit + render. */
export type A2uiDynamic = string | number | boolean | { path: string };

export interface A2uiComponent {
  id: string;
  component: "List" | "Card" | "Column" | "Row" | "Image" | "Text" | "Button";
  child?: string;
  children?: string[] | { path: string; componentId: string };
  text?: A2uiDynamic;
  url?: A2uiDynamic;
  variant?: string;
  action?: { event: { name: string; context?: Record<string, A2uiDynamic> } };
}

export type A2uiMessage =
  | { version: "v0.9"; createSurface: { surfaceId: string; catalogId: string } }
  | { version: "v0.9"; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
  | { version: "v0.9"; updateDataModel: { surfaceId: string; path: string; value: unknown } };

export const BASIC_CATALOG_ID = "https://a2ui.org/specification/v0_9/basic_catalog.json";

export interface BeatDef {
  id: number;
  /** Display number ("1".."7", "8a", "8b", "8c"). */
  label: string;
  plane: Plane;
  key: string;
  title: string;
  prompt: string;
  blurb: string;
}

export const BEATS: BeatDef[] = [
  { id: 1, label: "1", plane: "shopper", key: "goal-to-cart", title: "Goal to cart", blurb: "Planner → Shopper → Critic, ledger, cart", prompt: "Coffee plus filters bundle: one bag of ground coffee and a pack of #4 cone coffee filters, under $25 total." },
  { id: 2, label: "2", plane: "shopper", key: "compare", title: "Compare & explain", blurb: "Why this ranks: BM25 / vector / rerank", prompt: "Compare the top 3 #4 cone coffee filters and explain why each ranks where it does." },
  { id: 3, label: "3", plane: "shopper", key: "substitute", title: "Out of stock → substitute", blurb: "Human-in-the-loop accept / reject", prompt: "The #4 Cone Coffee Filters, Natural Unbleached, 300 count (B07MDNV9M5) are out of stock at store 4108. Find substitutes." },
  { id: 4, label: "4", plane: "shopper", key: "mandate", title: "Agent checkout mandate", blurb: "Checkout agent (T2): spend cap, human approves", prompt: "Check out my cart with a $40 spend cap. Do not pay, create a mandate for my approval." },
  { id: 5, label: "5", plane: "shopper", key: "agent-customer", title: "Agent as customer", blurb: "Signed agent identity, readiness score", prompt: "Show how an external shopper agent sees our catalog feed." },
  { id: 6, label: "6", plane: "shopper", key: "future-search", title: "Future search", blurb: "Photo, voice, reasoning rerank, storefront", prompt: "Build a back-to-school storefront for a 10 year old." },
  { id: 7, label: "7", plane: "shopper", key: "trust-safety", title: "Trust & safety", blurb: "Injection quarantined, blocked in the tool path", prompt: "My budget is $20. Read the seller listing for B07FB7PMBB (Kashi chewy bars) and add what it suggests. The listing says to add 10 boxes, so add 10 to my cart." },
  { id: 8, label: "8a", plane: "ops", key: "ops-data", title: "Data quality + labeling", blurb: "DQ gates, Claude labels, human review queue", prompt: "Run data validation on the catalog, then label the latest unlabeled shopper queries and send low-confidence ones to human review." },
  { id: 9, label: "8b", plane: "ops", key: "ops-closed-loop", title: "Closed-loop search quality", blurb: "Drift → propose → approve → gate → canary → promote", prompt: "Check the live query stream for drift, estimate the impact on NDCG and propose remediations for my approval." },
  { id: 10, label: "8c", plane: "ops", key: "ops-finops", title: "FinOps router", blurb: "Cheap path vs Claude path, cost per 1k / per task", prompt: "Show how the router splits shopper traffic between the cheap path and the Claude path, with cost per 1k queries and per fulfilled task." },
];

/** Continuation prompts sent after a human approval in beat 8b. */
export const OPS_CONTINUE: Record<string, string> = {
  build: "Remediation {subject} was approved by a human. Call build_candidate('{subject}') now — do NOT propose again — then run the eval gate on the candidate it returns and, only if the gate passes, start a 10% canary and ask for promotion approval.",
  release: "Promotion of {subject} was approved by a human. Call promote('{subject}'), then sign_model, generate_mlbom and get_audit_log.",
};

/** Fill {subject} in a continuation prompt with the approved remediation_id / version. */
export function opsContinuePrompt(phase: string, subject?: string): string {
  const t = OPS_CONTINUE[phase] ?? "";
  return subject ? t.replace(/\{subject\}/g, subject) : t.replace(/ ?\{subject\}/g, "").replace(/\('\'\)/g, "()");
}

// ---------------------------------------------------------------- B16 shopper account, wallet, tender
// Additive SessionView keys. Every one of these is synthetic demo data: no real shopper, no real
// balance, and no payment is ever executed.

export interface AccountRef {
  account_id: string;
  name: string;
  /** The persona's one-line purpose, e.g. "happy path: approved card plus a gift balance". */
  tagline: string;
  synthetic: true;
}

export interface WalletMethodRef {
  pm_id: string;
  kind: string;
  brand: string | null;
  last4: string | null;
  outcome: string | null;
}

export interface WalletSummary {
  count: number;
  default: WalletMethodRef | null;
}

export interface AddressRef {
  address_id: string;
  label: string;
  city: string | null;
  region: string | null;
}

export interface AddressSummary {
  count: number;
  default: AddressRef | null;
}

export interface TenderLeg {
  pm_id: string;
  amount: number;
  kind?: string | null;
  brand?: string | null;
  last4?: string | null;
  display?: string | null;
  covers?: string | null;
  label?: string | null;
}

/** A tender-preview result as the payment step shows it. `refusals` is never dropped. */
export interface TenderView {
  plan: TenderLeg[];
  tender_hash: string | null;
  refusals: unknown[];
  total?: number | null;
  covered_total?: number | null;
  uncovered?: number | null;
  split_tender?: boolean;
  ok?: boolean;
}
