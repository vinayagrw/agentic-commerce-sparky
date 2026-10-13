/** Storefront types, mirroring the bff session layer contract (CONTRACT.md "bff session layer"). */

export type SvcStatus = "ok" | "stale" | "unavailable" | string;
export type Actor = "site" | "agent" | "system";

export interface Filters {
  brands?: string[];
  min_price?: number | null;
  max_price?: number | null;
  dietary?: string[];
  in_stock?: boolean;
  exclude_terms?: string[];
}

export type Sort = "relevance" | "price_asc" | "price_desc" | "rating";

export type AppliesAs =
  | { filter: "dietary"; value: string }
  | { filter: "exclude_terms"; value: string[] }
  | { filter: "max_price"; value: number }
  | { filter: "store"; value: string }
  | null;

export interface Constraint {
  id?: string;
  key: string;
  value: string;
  status: "ok" | "violated" | "unknown";
  note?: string;
  source: "chat" | "site" | "planner";
  source_text?: string;
  applies_as: AppliesAs;
}

export interface CartItem {
  product_id: string;
  title: string;
  price: number;
  qty: number;
  line_total: number;
}

export interface Activity {
  id: string;
  at: string;
  actor: Actor;
  kind: string;
  summary: string;
}

export interface CouldNot {
  constraint: string;
  reason: string;
  product_ids?: string[];
}

export interface SessionView {
  session_id: string;
  version: number;
  store_id: string;
  query: string;
  filters: Filters;
  sort: Sort;
  last_search: {
    query: string;
    filters: Filters;
    actor: Actor;
    at: string;
    product_ids: string[];
  } | null;
  cart: { items: CartItem[]; total: number; item_count: number };
  budget: number | null;
  constraints: Constraint[];
  could_not: CouldNot[];
  activity: Activity[];
  mandate: Record<string, any> | null;
  verifier: {
    checked_at: string | null;
    verdict: "pass" | "fail" | "unknown";
  } | null;
  /* Wave 0b (additive) */
  memory?: MemoryItem[];
  pending_actions?: PendingAction[];
  audit?: {
    id: string;
    at: string;
    action_id: string;
    event: string;
    actor: string;
    summary: string;
  }[];
  watches?: Watch[];
  notifications?: {
    id: string;
    at: string;
    watch_id: string;
    text: string;
    read: boolean;
  }[];
  plan?: MissionPlan | null;
  /* B16 (additive): a guest session carries account: null and tender: null */
  account?: SessionAccount | null;
  wallet?: {
    count: number;
    default: {
      pm_id: string;
      kind: PmKind;
      brand: string | null;
      last4: string | null;
      outcome: PmOutcome;
    } | null;
  } | null;
  addresses?: {
    count: number;
    default: {
      address_id: string;
      label: string;
      city: string | null;
      region: string | null;
    } | null;
  } | null;
  tender?: SessionTender | null;
}

export interface MemoryItem {
  id: string;
  key: "dietary" | "brands" | "store" | "household_size";
  value: string;
  origin: "stated" | "inferred";
  status: "confirmed" | "quarantined";
  source: string;
  source_text?: string;
  created_at: string;
  updated_at: string;
}

export interface PendingAction {
  id: string;
  kind: "cart_add" | "cart_remove" | "reorder_add";
  product_id: string;
  title: string;
  qty: number;
  price: number | null;
  proposed_by: "agent" | "reorder";
  reason: string;
  status: "pending" | "approved" | "rejected" | "undone" | "failed";
  created_at: string;
  note?: string;
}

export interface Watch {
  id: string;
  kind: "price_drop" | "back_in_stock";
  product_id: string;
  title: string;
  store_id: string;
  baseline_price: number | null;
  last_price: number | null;
  last_in_stock: boolean | null;
  last_checked_at: string | null;
  status: "active" | "triggered";
}

export interface MissionPlan {
  id: string;
  goal: string;
  source: string;
  lines: {
    id: string;
    ingredient: string;
    product_id: string;
    title: string;
    price: number | null;
    qty: number;
  }[];
  omissions: { ingredient: string; reason: string }[];
  status: "draft" | "added_to_cart";
  verifier: {
    checked_at: string | null;
    verdict: "pass" | "fail" | "unknown";
    could_not: { constraint: string; reason: string }[];
  };
  edits: number;
}

export interface Promo {
  promo_id: string;
  label: string;
  pct_off: number;
  ends_at?: string;
}

export interface ResultItem {
  product_id: string;
  title: string;
  brand: string;
  category: string;
  rating: number | null;
  dietary: string[];
  image: string;
  sponsored: boolean;
  label?: string;
  price: number | null;
  list_price: number | null;
  promo: Promo | null;
  in_stock: boolean | null;
  qty: number | null;
  pickup_label: string | null;
  snap_eligible: boolean | null;
  age_restricted: boolean | null;
}

export interface HelpAnswer {
  query: string;
  lang: string;
  matched: boolean;
  answer: string;
  citations: { doc_id: string; title: string; section: string }[];
  corpus_note: string;
}

export interface StorefrontSearch {
  query: string;
  kind: "products" | "help";
  intent?: { route: string; intent: string; rule?: string; by?: string };
  help?: HelpAnswer;
  total: number;
  page: number;
  page_size: number;
  pages: number;
  retrieved: number;
  facet_scope: string;
  results: ResultItem[];
  facets: {
    brands: { value: string; count: number }[];
    price: {
      label: string;
      min: number | null;
      max: number | null;
      count: number;
    }[];
    dietary: { value: string; count: number }[];
    in_stock: { count: number };
  };
  suggestions: { did_you_mean: string | null; related: string[] };
  zero_result: null | {
    relaxation: { dropped: string[]; label: string; count: number } | null;
    triage_id: string;
  };
  services: Record<string, SvcStatus>;
  synthetic_label: string;
  provenance?: unknown;
  error?: string;
}

export interface SearchResponse {
  search: StorefrontSearch;
  effective_filters: Filters & {
    from_constraints?: Record<string, unknown> | string[];
  } & Record<string, any>;
  from_constraints?: {
    field: string;
    value: unknown;
    constraint: string;
    id: string;
  }[];
  session: SessionView;
  error?: string;
}

export interface Quote {
  product_id: string;
  store_id: string;
  price: {
    status: SvcStatus;
    list_price: number | null;
    price: number | null;
    currency: string;
    promo: Promo | null;
    updated_at?: string;
    ttl_s?: number;
    error?: string;
  };
  inventory: {
    status: SvcStatus;
    qty: number | null;
    in_stock: boolean | null;
    pickup_eta_minutes: number | null;
    pickup_label: string | null;
    other_stores: Record<string, number>;
    updated_at?: string;
    ttl_s?: number;
    error?: string;
  };
  eligibility: {
    status: SvcStatus;
    snap_eligible: boolean | null;
    age_restricted: boolean | null;
    min_age: number | null;
    region: string | null;
    region_blocked: boolean | null;
    rules: { rule: string; applies: boolean; text: string }[];
    error?: string;
  };
  synthetic_label: string;
}

export interface ProductDetail {
  product: Record<string, any>;
  quote: Quote;
  attributes: {
    name: string;
    value: any;
    tier: "T1" | "T2" | "T3";
    source: string;
  }[];
  substitutes: {
    product_id: string;
    title: string;
    brand: string;
    price: number | null;
    in_stock: boolean | null;
    sub_score: number;
  }[];
  synthetic_label: string;
  provenance?: unknown;
  error?: string;
}

export interface StoreInfo {
  store_id: string;
  name: string;
  city: string;
  region: string;
  hours: string;
  synthetic: boolean;
}

export interface RevalIssue {
  kind:
    | "out_of_stock"
    | "insufficient_qty"
    | "price_changed"
    | "region_blocked"
    | "age_restricted"
    | "service_unavailable";
  message: string;
  blocking: boolean;
}

export interface Revalidation {
  ok: boolean;
  checked_at: string;
  lines: {
    product_id: string;
    title: string;
    qty: number;
    cart_price: number;
    current_price: number | null;
    price_changed: boolean;
    qty_available: number | null;
    in_stock: boolean | null;
    issues: RevalIssue[];
    substitutes: {
      product_id: string;
      title: string;
      brand?: string;
      price: number | null;
      in_stock?: boolean | null;
    }[];
  }[];
  services: Record<string, SvcStatus>;
}

export interface Order {
  order_id: string;
  session_id?: string;
  mandate_id: string;
  lines: {
    product_id: string;
    title: string;
    qty: number;
    price: number;
    line_total?: number;
  }[];
  total: number;
  store_id: string;
  created_at: string;
  status: string;
  payment_executed: false;
  /* B16 (additive: a guest order has no account, no tender block and no address) */
  account_id?: string | null;
  address_id?: string | null;
  auth_ref?: string | null;
  /** The API's own note that nothing was executed. */
  note?: string;
  synthetic_label?: string;
  payment?: OrderPayment | null;
  address?: Address | null;
  fulfilment?: Fulfilment | null;
  fulfilment_advanced_to?: string | null;
}

export interface TriageItem {
  id: string;
  ts: string;
  kind: "zero_result";
  query: string;
  filters: Filters;
  store_id: string;
  session_id: string | null;
  relaxation: { dropped: string[]; label: string; count: number } | null;
  status: "open" | "acknowledged" | "resolved";
  note: string;
}

/* ---------------- B16 shopper accounts, wallet, addresses, tender ---------------- */

export type PmKind = "credit" | "debit" | "ebt_snap" | "gift";
export type PmOutcome =
  | "approved"
  | "declined"
  | "insufficient_funds"
  | "step_up"
  | "expired"
  | string;

export interface PaymentMethod {
  pm_id: string;
  account_id: string;
  kind: PmKind;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  token: string;
  outcome: PmOutcome;
  balance: number | null;
  /** The API's own wording for this instrument. Rendered verbatim: never restated in our words. */
  label: string;
  is_default: boolean;
  display: string;
  synthetic: boolean;
  synthetic_label: string;
}

export interface Address {
  address_id: string;
  account_id: string;
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  store_id: string | null;
  instructions: string | null;
  label: string;
  is_default: boolean;
  display: string;
  synthetic: boolean;
  synthetic_label: string;
}

export interface AccountPrefs {
  dietary?: string[];
  brands?: string[];
  store_id?: string | null;
  household_size?: number | string | null;
}

export interface ShopperAccount {
  account_id: string | null;
  name: string;
  email?: string;
  prefs: AccountPrefs;
  /** The API's own one-line description of what this persona demonstrates. */
  label?: string;
  note?: string;
  is_guest: boolean;
  payment_methods: PaymentMethod[];
  addresses: Address[];
  synthetic?: boolean;
  synthetic_label: string;
}

/** The compact account block the SessionView carries once a persona is bound. */
export interface SessionAccount {
  account_id: string;
  name: string;
  tagline?: string;
  synthetic?: boolean;
}

export interface TestCard {
  number: string;
  brand: string | null;
  kind: PmKind;
  last4: string | null;
  outcome: PmOutcome;
  balance: number | null;
  profile: string;
  label: string;
}

export interface TestCardsResponse {
  cards: TestCard[];
  tenders: {
    kind: PmKind;
    brand: string | null;
    last4: string | null;
    outcome: PmOutcome;
    requires_balance: boolean;
    label: string;
    display: string;
  }[];
  note: string;
  step_up_code: string;
  payment_executed: false;
  synthetic_label: string;
}

export interface TenderLeg {
  pm_id: string;
  kind: PmKind | null;
  brand: string | null;
  last4: string | null;
  display?: string;
  amount: number;
  covers: string | null;
  label: string | null;
}

export type RefusalKind =
  | "eligibility_unverified"
  | "ebt_balance_short"
  | "not_snap_eligible"
  | "uncovered_remainder"
  | string;

export interface TenderRefusal {
  kind: RefusalKind;
  blocking: boolean;
  product_ids: string[];
  message: string;
}

export interface TenderLine {
  product_id: string;
  title: string;
  qty: number;
  line_total: number;
  snap_eligible: boolean | null;
  eligibility_status: SvcStatus;
  eligibility_error: string | null;
  snap_rules: { rule: string; applies: boolean; text: string }[];
  snap_reason: string | null;
}

export interface TenderPreview {
  session_id: string;
  store_id: string;
  account_id: string | null;
  total: number;
  snap_subtotal: number;
  covered_total: number;
  uncovered: number;
  lines: TenderLine[];
  plan: TenderLeg[];
  split_tender: boolean;
  split_tender_plan:
    { pm_id: string; amount: number; covers: string | null }[] | null;
  tender_hash: string;
  refusals: TenderRefusal[];
  ok: boolean;
  services: Record<string, SvcStatus>;
  payment_executed: false;
  eligibility_rule_source: string;
  /** The API's own label for the tender plan. */
  label: string;
  synthetic_label: string;
}

/** The tender summary the SessionView carries (compact; the full preview lives in page state). */
export interface SessionTender {
  plan: { pm_id: string; amount: number; covers?: string | null }[];
  refusals: TenderRefusal[];
  total?: number;
  covered_total?: number;
  tender_hash?: string;
  ok?: boolean;
}

export type AuthDecision =
  "approved" | "declined" | "refused" | "step_up_required" | string;

export interface StepUp {
  step_up_id: string;
  pm_id: string;
  amount: number;
  max_attempts: number;
  attempts?: number;
  expires_at?: number;
  status?: string;
  prompt?: string;
  demo_code_note?: string;
}

export interface AuthResult {
  mandate_id: string;
  amount: number;
  checks: Record<string, boolean>;
  payment_executed: false;
  synthetic_label: string;
  currency?: string;
  tender?: TenderLeg[];
  note?: string;
  decision: AuthDecision;
  reason: string | null;
  failed_checks?: string[];
  pm_id?: string;
  step_up?: StepUp;
  auth_ref?: string;
  /** The API's own sentence about what did (and did not) happen. Rendered verbatim. */
  message?: string;
  balance?: number | null;
  status?: string;
}

export interface StepUpResult {
  step_up_id: string;
  pm_id: string;
  amount: number;
  attempts: number;
  max_attempts: number;
  attempts_remaining: number;
  status: string;
  payment_executed: false;
  synthetic_label: string;
  verified: boolean;
  message?: string;
  authorisation?: AuthResult;
}

export interface Fulfilment {
  stage: string;
  stage_index: number;
  stages: string[];
  next_stage: string | null;
  eta_seconds: number | null;
  elapsed_seconds: number;
  derived_from: string;
  advanced_to: string | null;
  thresholds_seconds: Record<string, number>;
  simulated: boolean;
  /** The API's own label for how the stage was derived. */
  label: string;
  payment_executed: false;
}

export interface OrderPayment {
  status: string;
  auth_ref: string | null;
  amount: number;
  currency: string;
  tender: TenderLeg[];
  split_tender: boolean;
  payment_executed: false;
  authorised_at: string | null;
  /** The API's own sentence: nothing settles and nothing can be refunded. Rendered verbatim. */
  note: string;
  synthetic_label: string;
}

/** Human labels for the fulfilment stage ids the API returns. */
export const FULFILMENT_LABEL: Record<string, string> = {
  placed: "Placed",
  preparing: "Preparing",
  ready_for_pickup: "Ready for pickup",
  picked_up: "Picked up",
};

/** Human labels for the deliberate outcome baked into each demo instrument. */
export const OUTCOME_BADGE: Record<
  string,
  { text: string; tone: "ok" | "bad" | "warn" | "neutral" }
> = {
  approved: { text: "test card: approves", tone: "ok" },
  declined: { text: "test card: declines", tone: "bad" },
  insufficient_funds: { text: "test card: insufficient funds", tone: "bad" },
  step_up: { text: "test card: needs verification", tone: "warn" },
  expired: { text: "test card: expired", tone: "bad" },
};

export const PM_KIND_LABEL: Record<string, string> = {
  credit: "Credit",
  debit: "Debit",
  ebt_snap: "EBT SNAP",
  gift: "Gift balance",
};

export const CATEGORIES = [
  { id: "grocery", label: "Grocery", emoji: "🥫", query: "snacks" },
  { id: "pet", label: "Pet", emoji: "🐾", query: "dog food" },
  {
    id: "home_kitchen",
    label: "Home & Kitchen",
    emoji: "🍳",
    query: "kitchen storage",
  },
  { id: "baby", label: "Baby", emoji: "🍼", query: "diapers" },
  {
    id: "health_household",
    label: "Health & Household",
    emoji: "🧴",
    query: "vitamins",
  },
  {
    id: "electronics_accessories",
    label: "Electronics Accessories",
    emoji: "🔌",
    query: "usb c charger",
  },
] as const;

export const SYNTHETIC_LABEL =
  "synthetic commerce data (ESCI has no price or stock)";
