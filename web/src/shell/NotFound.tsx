import { Link, useLocation } from "react-router";

export function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="grid flex-1 place-items-center p-8 text-center">
      <div className="grid gap-2">
        <div className="font-mono text-sm text-fg-subtle">{pathname}</div>
        <h1 className="m-0 text-2xl font-semibold">No page at this address</h1>
        <p className="m-0 text-fg-muted">
          Go to the <Link to="/shopper/1" className="text-accent">shopper plane</Link>, <Link to="/ops/1" className="text-accent">Ops Copilot</Link> or the{" "}
          <Link to="/coverage" className="text-accent">coverage board</Link>.
        </p>
      </div>
    </div>
  );
}
