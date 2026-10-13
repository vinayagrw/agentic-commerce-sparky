/**
 * /ops/tokens: the token meter as a full page (the same panel the Ops dashboard's OPS8 tab shows).
 * Reads data/token_ledger.jsonl through GET /api/tokens/{summary,ledger}; filters live in the URL,
 * so a filtered view is a shareable link.
 */
import { Link } from "react-router";
import { OpsTokens } from "./OpsTokens";

export function Component() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-[90rem] gap-4 px-4 py-6 sm:px-6 lg:px-8" data-testid="token-meter-page">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.02em]">Token meter</h1>
          <Link to="/ops/traces" className="text-sm text-accent-soft-fg underline-offset-4 hover:underline">Traces</Link>
          <Link to="/ops/1" className="ml-auto text-sm text-accent-soft-fg underline-offset-4 hover:underline">Back to Ops</Link>
        </header>
        <OpsTokens />
      </div>
    </div>
  );
}
