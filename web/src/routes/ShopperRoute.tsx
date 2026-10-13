import { useMemo, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { ShieldAlert } from "lucide-react";
import { ChatPane, useRunning, type ChatHandle } from "@/components/ChatPane";
import { PlaneInspector } from "@/components/PlaneInspector";
import { FutureSearchBar } from "@/components/FutureSearchBar";
import { HealthBanners } from "@/components/HealthGate";
import { PolicyEventsFeed } from "@/components/PolicyEvents";
import { AgentCustomer } from "@/beats/AgentCustomer";
import { agentState, useStore } from "@/store";
import { PlaneLayout } from "@/shell/PlaneLayout";
import { SideNav } from "@/shell/SideNav";
import { Inspector } from "@/shell/Inspector";
import { useShell } from "@/shell/context";
import { usePlane } from "@/shell/usePlane";

/** Beat 7: the guard's live decision log sits above the chat, where the audience is looking. */
function GuardStrip() {
  return (
    <details open className="group flex-none border-b border-line bg-surface">
      <summary className="flex cursor-pointer items-center gap-2 px-4 py-2.5 select-none">
        <ShieldAlert className="size-4 text-bad" aria-hidden />
        <span className="text-sm font-semibold">Guard · policy-mcp decisions</span>
        <span className="text-xs text-fg-muted">live proof that injected instructions are refused before a tool runs</span>
      </summary>
      <div className="max-h-[38vh] overflow-auto px-4 pb-3">
        <PolicyEventsFeed limit={60} />
      </div>
    </details>
  );
}

/** /shopper/:beat. */
export function Component() {
  const [params] = useSearchParams();
  const layout = params.get("layout");
  const running = useRunning("default");
  const [rerank, setRerank] = useState(true);
  const chat = useRef<ChatHandle>(null);
  const shop = useStore(agentState);
  const { gate } = useShell();
  const { beats, current, outages, locked, select, run } = usePlane("shopper", {
    running,
    send: (def) => chat.current?.send(def.prompt, { beat: def.id, imagePath: null }),
  });
  const extra = useMemo(() => ({ rerank }), [rerank]);

  // ?layout=site|chat|split: the storefront layouts live under /shop; keep ?chat= so the prompt is prefilled there.
  if (layout === "site" || layout === "chat" || layout === "split") {
    const q = new URLSearchParams({ view: layout });
    if (params.get("chat")) q.set("chat", params.get("chat")!);
    return <Navigate to={`/shop?${q}`} replace />;
  }
  if (!current) return <Navigate to="/shopper/1" replace />;

  return (
    <PlaneLayout
      nav={<SideNav title="Shopper beats" beats={beats} current={current} running={running} locked={locked} onSelect={select} onRun={run} />}
      interrupt={locked ? <HealthBanners planeLabel="Shopper" outages={outages} onRetry={() => void gate.refresh(true)} checking={gate.checking} checkedAt={gate.checkedAt} /> : null}
      inspector={
        <Inspector>
          <PlaneInspector state={shop} />
        </Inspector>
      }
    >
      <section aria-label="Chat" className="flex min-h-0 flex-1 flex-col bg-canvas">
        {current.id === 5 && <AgentCustomer />}
        {current.id === 6 && <FutureSearchBar rerank={rerank} setRerank={setRerank} disabled={running} send={(t, x) => chat.current?.send(t, x)} />}
        {current.id === 7 && <GuardStrip />}
        <ChatPane ref={chat} agentId="default" beat={current.id} extra={extra} />
      </section>
    </PlaneLayout>
  );
}
