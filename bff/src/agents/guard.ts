/**
 * BFF-side observation of the guard rules. This is NOT the enforcement point:
 * policy-mcp is, and it refuses a call before the underlying tool runs (see
 * services/policy-mcp/src/policy_mcp/policy.py). What this class contributes is a
 * second, independent read of the same stream so the trace shows the BFF saw what
 * the proxy saw:
 *  - tool results carrying `untrusted_content` are noted as quarantined and scanned
 *    for instruction-like text;
 *  - an add_to_cart that echoes quarantined text, jumps above 5 units or breaks the
 *    budget is flagged as a pre-check note.
 *
 * The full capability separation lives in agents/camel.ts (technique 36).
 */
import { randomUUID } from "node:crypto";
import type { AgentState, GuardEvent } from "@sparky/shared";

export const MAX_QTY = 5;

const INJECTION_RE =
  /(ignore (all |any |previous |prior )?(instructions|rules)|system prompt|you are now|add\s+(\d+)\s+(units|items|more)|add (this|it) to (the )?cart|disregard)/i;

export interface Quarantine {
  tool: string;
  productId?: string;
  text: string;
  suspicious: boolean;
  injectedQty?: number;
}

export interface GuardVerdict {
  allow: boolean;
  events: GuardEvent[];
}

export function shortTool(name: string): string {
  return name.replace(/^mcp__shop__/, "");
}

export function extractUntrusted(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const direct = r.untrusted_content;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") return JSON.stringify(direct);
  for (const v of Object.values(r)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = extractUntrusted(v);
      if (nested) return nested;
    }
  }
  return null;
}

export class Guard {
  last: Quarantine | null = null;

  /** Record a tool result; returns a warn event when it quarantines suspicious text. */
  observeResult(tool: string, result: unknown): GuardEvent[] {
    const text = extractUntrusted(result);
    if (!text) return [];
    const m = text.match(INJECTION_RE);
    const qtyMatch = text.match(/add\s+(\d+)/i);
    const r = (result ?? {}) as Record<string, any>;
    this.last = {
      tool: shortTool(tool),
      productId: r.product_id ?? r.product?.product_id,
      text,
      suspicious: Boolean(m),
      injectedQty: qtyMatch ? Number(qtyMatch[1]) : undefined,
    };
    if (!m) return [];
    return [
      {
        id: randomUUID(),
        kind: "injection",
        severity: "warn",
        tool: shortTool(tool),
        message: `Quarantined instruction-like text in untrusted_content: "${m[0]}". Treated as data.`,
      },
    ];
  }

  /** Check a model-requested tool call. Only add_to_cart is gated. */
  checkCall(tool: string, input: unknown, state: AgentState, unitPrice?: number): GuardVerdict {
    if (shortTool(tool) !== "add_to_cart") return { allow: true, events: [] };
    const args = (input ?? {}) as Record<string, any>;
    const qty = Number(args.qty ?? args.quantity ?? 1);
    const pid = args.product_id as string | undefined;
    const events: GuardEvent[] = [];
    const mk = (kind: GuardEvent["kind"], message: string): GuardEvent => ({
      id: randomUUID(),
      kind,
      severity: "block",
      tool: "add_to_cart",
      message,
    });

    const q = this.last;
    if (q?.suspicious && (q.productId === undefined || q.productId === pid || q.injectedQty === qty)) {
      events.push(mk("injection", `add_to_cart(${pid ?? "?"}, qty ${qty}) follows quarantined content from ${q.tool}; blocked pending user confirmation.`));
    }
    if (qty > MAX_QTY) {
      events.push(mk("qty_jump", `Quantity ${qty} exceeds the ${MAX_QTY}-unit guard.`));
    }
    const price = Number(args.price ?? unitPrice ?? NaN);
    if (state.budget != null && Number.isFinite(price) && state.cart_total + price * qty > state.budget) {
      events.push(mk("budget", `Adding $${(price * qty).toFixed(2)} would exceed the $${state.budget} budget (cart $${state.cart_total.toFixed(2)}).`));
    }
    return { allow: events.length === 0, events };
  }
}
