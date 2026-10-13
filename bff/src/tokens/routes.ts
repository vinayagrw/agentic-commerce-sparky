/**
 * Token meter API over data/token_ledger.jsonl:
 *   GET /api/tokens/ledger   filtered, paged ledger lines (from,to,plane,role,model,ok,run_id,intent,min_cost,limit,cursor)
 *   GET /api/tokens/summary  totals + buckets grouped by role|model|plane|intent|hour, same filters
 * Both are read-only and carry provenance. No text is stored in or served from the ledger.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { budgetState } from "../agents/budget.js";
import { facets, filterLedger, groupLedger, GROUP_BYS, pageLedger, readLedger, summariseLedger, type GroupBy, type LedgerFilters } from "./query.js";

const prov = (endpoint: string) => ({ service: "bff", endpoint, source: "data/token_ledger.jsonl", timestamp: new Date().toISOString() });

function filtersFrom(q: any): LedgerFilters {
  const okRaw = String(q?.ok ?? "");
  const minCost = Number(q?.min_cost);
  return {
    from: q?.from ? String(q.from) : null,
    to: q?.to ? String(q.to) : null,
    plane: q?.plane ? String(q.plane) : null,
    role: q?.role ? String(q.role) : null,
    model: q?.model ? String(q.model) : null,
    run_id: q?.run_id ? String(q.run_id) : null,
    intent: q?.intent ? String(q.intent) : null,
    ok: okRaw === "true" || okRaw === "1" ? true : okRaw === "false" || okRaw === "0" ? false : null,
    min_cost: Number.isFinite(minCost) && minCost > 0 ? minCost : null,
  };
}

export function registerTokenRoutes(app: FastifyInstance) {
  app.get("/api/tokens/ledger", async (req) => {
    const q = req.query as any;
    const all = readLedger();
    const filters = filtersFrom(q);
    const rows = filterLedger(all, filters);
    const page = pageLedger(rows, { limit: Number(q?.limit ?? 100) || 100, cursor: q?.cursor ?? null });
    return { ok: true, ...page, filters, facets: facets(all), ledger_lines: all.length, provenance: prov("GET /api/tokens/ledger") };
  });

  app.get("/api/tokens/summary", async (req, reply) => {
    const q = req.query as any;
    const by = String(q?.group_by ?? "role") as GroupBy;
    if (!GROUP_BYS.includes(by)) return reply.code(400).send({ ok: false, error: `group_by must be one of ${GROUP_BYS.join("|")}` });
    const all = readLedger();
    const filters = filtersFrom(q);
    const rows = filterLedger(all, filters);
    const totals = summariseLedger(rows);
    // Session budget: the same figure the shopper turn degrades on (bff/src/agents/budget.ts).
    const budget = budgetState(totals.cost_usd, config.sessionCostBudgetUsd);
    return {
      ok: true,
      group_by: by,
      totals,
      buckets: groupLedger(rows, by),
      by_hour: by === "hour" ? null : groupLedger(rows, "hour"),
      filters,
      facets: facets(all),
      ledger_lines: all.length,
      budget: {
        mode: budget.mode,
        ratio: budget.ratio,
        spent_usd: budget.spent_usd,
        budget_usd: budget.budget_usd,
        env: "SESSION_COST_BUDGET_USD",
        // budgetState()'s own message is written for one session; this window may span many, so the
        // wording here is window-scoped and only says what degradation a session at this spend hits.
        message:
          budget.mode === "normal"
            ? null
            : `The filtered window cost $${totals.cost_usd.toFixed(2)}, which is ${Math.round(budget.ratio * 100)}% of the per-session budget of $${config.sessionCostBudgetUsd.toFixed(2)}. A single session reaching this spend degrades to ${budget.mode === "exhausted" ? "paused agent runs (the store, cart and checkout keep working)" : "economy mode: the smaller model with a rules-based planner and critic"}.`,
        note: "the budget is enforced per session (bff/src/agents/budget.ts); this window may span several sessions",
      },
      provenance: prov("GET /api/tokens/summary"),
    };
  });
}
