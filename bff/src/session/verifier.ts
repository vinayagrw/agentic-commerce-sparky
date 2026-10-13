/**
 * B09: per-turn session-constraint verifier.
 *
 * Runs after every agent turn and after every site mutation. Checks the real cart against
 * the constraints the shopper stated (chat or site) and produces:
 *   - a status per constraint (ok / violated / unknown) with the evidence as a note
 *   - "could_not": the things the session could not satisfy or could not verify, with why
 *
 * Pure function: product facts are passed in (looked up from search-svc and the catalogue
 * services by the caller), so this is unit-testable and never invents a fact. A fact that is
 * missing makes the constraint "unknown", never "ok".
 */
import type { ConstraintEntry } from "@sparky/shared";

export interface LineFacts {
  product_id: string;
  title: string;
  qty: number;
  price: number;
  /** Dietary tags from the catalogue record (synthetic tags on ESCI products). null = lookup failed. */
  dietary: string[] | null;
  /** Inventory at the session store. null = inventory service unavailable. */
  in_stock: boolean | null;
  snap_eligible: boolean | null;
  age_restricted: boolean | null;
}

export interface CouldNot {
  constraint: string;
  reason: string;
  product_ids?: string[];
}

export interface VerifyInput {
  constraints: ConstraintEntry[];
  lines: LineFacts[];
  budget: number | null;
  cart_total: number;
  store_id: string;
}

export interface VerifyResult {
  constraints: ConstraintEntry[];
  could_not: CouldNot[];
  verdict: "pass" | "fail" | "unknown";
}

/** Dietary words a shopper says -> the catalogue tag that proves it. */
export const DIET_TAGS: [RegExp, string][] = [
  [/gluten[- ]?free|\bgf\b|sin gluten/i, "gluten_free"],
  [/vegan|vegano/i, "vegan"],
  [/organic|org[aá]nico/i, "organic"],
];

/** The catalogue has no allergen data: nut-free can only be checked against titles. */
export const NUT_TERMS = ["peanut", "peanuts", "almond", "almonds", "cashew", "cashews", "walnut", "walnuts", "pecan", "pecans", "hazelnut", "hazelnuts", "pistachio", "pistachios", "macadamia", "nut", "nuts"];
const NUT_RX = new RegExp(`\\b(${NUT_TERMS.join("|")})\\b`, "i");

export const isNutFree = (c: ConstraintEntry) => /nut[- ]?free|no nuts|sin nueces|peanut[- ]?free/i.test(`${c.key} ${c.value}`);
export const dietTagOf = (c: ConstraintEntry): string | null => {
  if (!/diet/i.test(c.key) && !DIET_TAGS.some(([rx]) => rx.test(c.value))) return null;
  for (const [rx, tag] of DIET_TAGS) if (rx.test(c.value) || rx.test(c.key)) return tag;
  return null;
};
export const isSnap = (c: ConstraintEntry) => /snap|ebt/i.test(`${c.key} ${c.value}`);

const money = (n: number) => `$${n.toFixed(2)}`;

export function verifySession(input: VerifyInput): VerifyResult {
  const { lines, budget, cart_total, store_id } = input;
  const could_not: CouldNot[] = [];
  const empty = lines.length === 0;
  const constraints = input.constraints.map((c0) => {
    const c: ConstraintEntry = { ...c0 };
    if (c.key === "budget") {
      const cap = budget ?? Number(String(c.value).replace(/[^\d.]/g, ""));
      if (!Number.isFinite(cap) || cap <= 0) {
        c.status = "unknown";
        c.note = "budget value could not be read";
      } else if (cart_total <= cap) {
        c.status = empty ? "unknown" : "ok";
        c.note = `cart ${money(cart_total)} of ${money(cap)}`;
      } else {
        c.status = "violated";
        c.note = `cart ${money(cart_total)} is ${money(cart_total - cap)} over ${money(cap)}`;
        could_not.push({ constraint: `budget ≤ ${money(cap)}`, reason: `The cart is ${money(cart_total)}, ${money(cart_total - cap)} over budget. Remove or swap an item.` });
      }
      return c;
    }
    const tag = dietTagOf(c);
    if (tag) {
      if (empty) {
        c.status = "unknown";
        c.note = "nothing in the cart to check yet";
        return c;
      }
      const unknown = lines.filter((l) => l.dietary === null);
      const bad = lines.filter((l) => l.dietary !== null && !l.dietary.includes(tag));
      if (bad.length) {
        c.status = "violated";
        c.note = `${bad.length} of ${lines.length} line(s) not tagged ${tag.replace("_", "-")}`;
        could_not.push({ constraint: c.value, reason: `Not tagged ${tag.replace("_", "-")} in the catalogue: ${bad.map((l) => l.title).join("; ")}`, product_ids: bad.map((l) => l.product_id) });
      } else if (unknown.length) {
        c.status = "unknown";
        c.note = `${unknown.length} line(s) could not be looked up`;
        could_not.push({ constraint: c.value, reason: `Could not verify ${unknown.length} line(s): the product lookup failed.`, product_ids: unknown.map((l) => l.product_id) });
      } else {
        c.status = "ok";
        c.note = `all ${lines.length} line(s) tagged ${tag.replace("_", "-")} (synthetic tags)`;
      }
      return c;
    }
    if (isNutFree(c)) {
      const hits = lines.filter((l) => NUT_RX.test(l.title));
      if (hits.length) {
        c.status = "violated";
        c.note = `${hits.length} line(s) name a nut in the title`;
        could_not.push({ constraint: c.value, reason: `These titles mention nuts: ${hits.map((l) => l.title).join("; ")}`, product_ids: hits.map((l) => l.product_id) });
      } else {
        c.status = "unknown";
        c.note = "title keyword check only; the catalogue has no allergen data";
        could_not.push({ constraint: c.value, reason: "Cannot verify nut-free: the catalogue carries no allergen data, so only product titles were checked. Read the package label." });
      }
      return c;
    }
    if (c.key === "store") {
      const sid = String(c.value).match(/\d{4}/)?.[0] ?? store_id;
      if (empty) {
        c.status = "unknown";
        c.note = `pickup at ${sid}`;
        return c;
      }
      const oos = lines.filter((l) => l.in_stock === false);
      const unk = lines.filter((l) => l.in_stock === null);
      if (oos.length) {
        c.status = "violated";
        c.note = `${oos.length} line(s) out of stock at ${sid}`;
        could_not.push({ constraint: `pickup at ${sid}`, reason: `Out of stock at store ${sid}: ${oos.map((l) => l.title).join("; ")}`, product_ids: oos.map((l) => l.product_id) });
      } else if (unk.length) {
        c.status = "unknown";
        c.note = "inventory service unavailable";
        could_not.push({ constraint: `pickup at ${sid}`, reason: "Inventory service unavailable: stock could not be checked." });
      } else {
        c.status = "ok";
        c.note = `every line in stock at ${sid} (synthetic inventory)`;
      }
      return c;
    }
    if (isSnap(c)) {
      if (empty) {
        c.status = "unknown";
        return c;
      }
      const bad = lines.filter((l) => l.snap_eligible === false);
      const unk = lines.filter((l) => l.snap_eligible === null);
      if (bad.length) {
        c.status = "violated";
        c.note = `${bad.length} line(s) not SNAP-eligible`;
        could_not.push({ constraint: c.value, reason: `Not SNAP-eligible (synthetic rules): ${bad.map((l) => l.title).join("; ")}`, product_ids: bad.map((l) => l.product_id) });
      } else if (unk.length) {
        c.status = "unknown";
        c.note = "eligibility service unavailable";
        could_not.push({ constraint: c.value, reason: "Eligibility service unavailable: SNAP eligibility could not be checked." });
      } else {
        c.status = "ok";
        c.note = "every line SNAP-eligible (synthetic rules)";
      }
      return c;
    }
    return c;
  });

  const over = lines.filter((l) => l.qty > 5);
  if (over.length) could_not.push({ constraint: "at most 5 of one item", reason: `Quantity above 5: ${over.map((l) => `${l.title} × ${l.qty}`).join("; ")}`, product_ids: over.map((l) => l.product_id) });
  const age = lines.filter((l) => l.age_restricted);
  if (age.length) could_not.push({ constraint: "age-restricted items", reason: `Needs ID at pickup; the assistant cannot verify age: ${age.map((l) => l.title).join("; ")}`, product_ids: age.map((l) => l.product_id) });

  const verdict = constraints.some((c) => c.status === "violated") || over.length ? "fail" : constraints.some((c) => c.status === "unknown") ? "unknown" : "pass";
  return { constraints, could_not, verdict };
}
