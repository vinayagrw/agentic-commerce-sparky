/**
 * Constraint provenance and filter mapping (B11).
 *
 * The planner's `constraintsFrom` extracts budget / headcount / gluten-free / vegan / store.
 * This adds the constraints the storefront also needs (nut-free, organic, SNAP), the
 * Spanish phrasings, a stable id per constraint, and how each one applies to the site's
 * search filters, so a chip can explain itself and be removed.
 */
import type { ConstraintEntry } from "@sparky/shared";
import { NUT_TERMS, dietTagOf, isNutFree } from "./verifier.js";

export type AppliesAs =
  | { filter: "dietary"; value: string }
  | { filter: "exclude_terms"; value: string[] }
  | { filter: "max_price"; value: number }
  | { filter: "store"; value: string }
  | null;

export interface ConstraintMeta {
  source: "chat" | "site" | "planner";
  source_text?: string;
  at: string;
}

export function detectConstraints(text: string): ConstraintEntry[] {
  const out: ConstraintEntry[] = [];
  if (/nut[- ]?free|no nuts|peanut[- ]?free|sin nueces|sin cacahuate|sin man[ií]/i.test(text)) out.push({ key: "allergy", value: "nut-free", status: "unknown" });
  if (/\borganic\b|org[aá]nic[oa]s?\b/i.test(text)) out.push({ key: "dietary", value: "organic", status: "unknown" });
  if (/sin gluten/i.test(text)) out.push({ key: "dietary", value: "gluten-free option required", status: "unknown" });
  if (/vegan[oa]s?\b/i.test(text) && !/vegan\b/i.test(text)) out.push({ key: "dietary", value: "vegan", status: "unknown" });
  if (/\bsnap\b|\bebt\b|food stamps|cupones de alimentos/i.test(text)) out.push({ key: "payment", value: "pay with SNAP/EBT", status: "unknown" });
  return out;
}

export const constraintId = (c: ConstraintEntry) => `${c.key}:${String(c.value).toLowerCase().replace(/[^a-z0-9$.]+/g, "-").replace(/^-|-$/g, "")}`;

/** Merge newly detected constraints in, without duplicating an existing key+value. */
export function mergeConstraints(prev: ConstraintEntry[], add: ConstraintEntry[]): ConstraintEntry[] {
  const have = new Set(prev.map(constraintId));
  const next = [...prev];
  for (const c of add) {
    if (have.has(constraintId(c))) continue;
    // one tag per dietary value: "gluten-free option required" and a planner "gluten free" are the same filter
    const tag = dietTagOf(c);
    if (tag && next.some((x) => dietTagOf(x) === tag)) continue;
    next.push(c);
    have.add(constraintId(c));
  }
  return next;
}

export function appliesAs(c: ConstraintEntry): AppliesAs {
  if (c.key === "budget" || c.key === "headcount") return null;
  if (c.key === "store") {
    const sid = String(c.value).match(/\d{4}/)?.[0];
    return sid ? { filter: "store", value: sid } : null;
  }
  if (isNutFree(c)) return { filter: "exclude_terms", value: NUT_TERMS };
  const tag = dietTagOf(c);
  if (tag) return { filter: "dietary", value: tag };
  const max = c.key === "max_price" ? Number(String(c.value).replace(/[^\d.]/g, "")) : NaN;
  if (Number.isFinite(max) && max > 0) return { filter: "max_price", value: max };
  return null;
}

export interface SiteFilters {
  brands?: string[];
  min_price?: number;
  max_price?: number;
  dietary?: string[];
  in_stock?: boolean;
  exclude_terms?: string[];
}

/** User filters + constraint filters. Constraints win; `from_constraints` says which fields they set. */
export function effectiveFilters(user: SiteFilters, constraints: ConstraintEntry[]) {
  const f: SiteFilters = { ...user, dietary: [...(user.dietary ?? [])], exclude_terms: [...(user.exclude_terms ?? [])] };
  const from: { field: string; value: unknown; constraint: string; id: string }[] = [];
  let store: string | null = null;
  for (const c of constraints) {
    const a = appliesAs(c);
    if (!a) continue;
    if (a.filter === "dietary") {
      if (!f.dietary!.includes(a.value)) f.dietary!.push(a.value);
      from.push({ field: "dietary", value: a.value, constraint: c.value, id: constraintId(c) });
    } else if (a.filter === "exclude_terms") {
      for (const t of a.value) if (!f.exclude_terms!.includes(t)) f.exclude_terms!.push(t);
      from.push({ field: "exclude_terms", value: a.value, constraint: c.value, id: constraintId(c) });
    } else if (a.filter === "max_price") {
      f.max_price = f.max_price == null ? a.value : Math.min(f.max_price, a.value);
      from.push({ field: "max_price", value: a.value, constraint: c.value, id: constraintId(c) });
    } else if (a.filter === "store") {
      store = a.value;
      from.push({ field: "store_id", value: a.value, constraint: c.value, id: constraintId(c) });
    }
  }
  if (!f.dietary!.length) delete f.dietary;
  if (!f.exclude_terms!.length) delete f.exclude_terms;
  return { filters: f, store, from_constraints: from };
}
