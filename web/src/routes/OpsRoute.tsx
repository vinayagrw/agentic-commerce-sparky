import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { opsContinuePrompt } from "@sparky/shared";
import { ChatPane, onActionResult, useRunning, type ChatHandle } from "@/components/ChatPane";
import { PlaneInspector } from "@/components/PlaneInspector";
import { HealthBanners } from "@/components/HealthGate";
import { OpsDashboard } from "@/ops/OpsDashboard";
import { OpsWorkspace } from "@/ops/OpsWorkspace";
import { WatchAlerts } from "@/ops/WatchAlerts";
import { opsState, useStore } from "@/store";
import { PlaneLayout } from "@/shell/PlaneLayout";
import { SideNav } from "@/shell/SideNav";
import { Inspector } from "@/shell/Inspector";
import { useShell } from "@/shell/context";
import { usePlane } from "@/shell/usePlane";

/** /ops/:beat. Dashboard first; the Ops Copilot chat is a resizable, collapsible dock. */
export function Component() {
  const { search } = useLocation();
  const running = useRunning("ops");
  const [worse, setWorse] = useState(false);
  const chat = useRef<ChatHandle>(null);
  const ops = useStore(opsState);
  const worseRef = useRef(worse);
  worseRef.current = worse;
  const { gate } = useShell();
  const { beats, current, outages, locked, select, run } = usePlane("ops", {
    running,
    send: (def) => chat.current?.send(def.prompt, { beat: def.id, opsPhase: null, worseCandidate: worseRef.current }),
  });

  // Beat 8b: a human approval on an A2UI card continues the closed loop.
  useEffect(() => {
    onActionResult("ops", (res) => {
      const prompt = res.next ? opsContinuePrompt(res.next, (res as any).subject) : "";
      if (!res.ok || !res.next || !prompt) return;
      setTimeout(() => chat.current?.send(prompt, { beat: 9, opsPhase: res.next, worseCandidate: worseRef.current }), 500);
    });
  }, []);

  const extra = useMemo(() => ({ worseCandidate: worse }), [worse]);

  // Unknown beat: go to the first one but keep ?copilot= and friends.
  if (!current) return <Navigate to={`/ops/1${search}`} replace />;

  return (
    <PlaneLayout
      nav={<SideNav title="Ops beats" beats={beats} current={current} running={running} locked={locked} onSelect={select} onRun={run} />}
      interrupt={locked ? <HealthBanners planeLabel="Ops" outages={outages} onRetry={() => void gate.refresh(true)} checking={gate.checking} checkedAt={gate.checkedAt} /> : null}
      inspector={
        <Inspector>
          <PlaneInspector state={ops} />
        </Inspector>
      }
    >
      <OpsWorkspace
        running={running}
        headerExtra={<WatchAlerts onAct={(prompt) => chat.current?.send(prompt, { opsPhase: null, worseCandidate: worseRef.current })} />}
        dashboard={<OpsDashboard state={ops} worse={worse} setWorse={setWorse} running={running} />}
        chat={<ChatPane ref={chat} agentId="ops" beat={current.id} extra={extra} />}
      />
    </PlaneLayout>
  );
}
