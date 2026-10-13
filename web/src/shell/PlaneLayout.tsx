import type * as React from "react";

/**
 * Plane routes: beats | work area | inspector.
 * >= xl three columns; lg two (inspector drops under the work area); below lg everything
 * stacks and the page scrolls (beat list becomes a horizontal strip).
 */
export function PlaneLayout({ nav, interrupt, children, inspector }: { nav: React.ReactNode; interrupt?: React.ReactNode; children: React.ReactNode; inspector: React.ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 max-lg:flex-none lg:grid-cols-[var(--shell-nav)_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[var(--shell-nav)_minmax(0,1fr)_var(--shell-inspector)]">
      <div className="flex min-h-0 flex-col border-b border-line lg:row-span-2 lg:border-b-0 xl:row-span-1 [&>*]:flex-1">{nav}</div>
      <main className="flex min-h-[80vh] min-w-0 flex-col lg:min-h-0">
        {interrupt ? <div className="flex-none border-b border-line bg-canvas p-3">{interrupt}</div> : null}
        {children}
      </main>
      <div className="flex min-h-0 flex-col lg:max-xl:col-start-2 lg:max-xl:max-h-[42vh] [&>*]:flex-1">{inspector}</div>
    </div>
  );
}
