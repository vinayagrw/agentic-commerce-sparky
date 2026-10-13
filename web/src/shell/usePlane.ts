import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import type { BeatDef } from "@sparky/shared";
import { beatPath, planeBeats, resolveBeat, type BeatPlane } from "./beats";
import { useShell } from "./context";

/**
 * Beat selection, running and presenter keyboard shortcuts for one plane, driven by the URL.
 * `send` is called on the next tick after navigation so shared state carries the new beat.
 */
export function usePlane(plane: BeatPlane, opts: { running: boolean; send: (def: BeatDef) => void }) {
  const { beat: param } = useParams();
  const navigate = useNavigate();
  const { gate, paletteOpen } = useShell();
  const beats = useMemo(() => planeBeats(plane), [plane]);
  const current = resolveBeat(plane, param);
  const outages = gate.outagesFor(plane);
  const locked = outages.length > 0;
  const sendRef = useRef(opts.send);
  sendRef.current = opts.send;

  const select = useCallback((def: BeatDef) => navigate(beatPath(def)), [navigate]);

  const run = useCallback(
    (def: BeatDef) => {
      // The health gate is enforced here and again in the BFF: a beat never runs, and never
      // silently substitutes, while a service it needs is down.
      if (gate.outagesFor(def.plane).length) {
        void gate.refresh(true);
        return;
      }
      navigate(beatPath(def));
      setTimeout(() => sendRef.current(def), 0);
    },
    [gate, navigate],
  );

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (paletteOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // Typing wins. An EMPTY chat box (CopilotChat autofocuses it) still lets the presenter
      // step through beats with the arrows and run with Enter.
      const field = t?.closest("textarea,input,select,[contenteditable=true]") as HTMLTextAreaElement | HTMLInputElement | null;
      if (t?.closest("[role=dialog]")) return;
      if (field && !(field.tagName === "TEXTAREA" && field.value === "")) return;
      const i = beats.findIndex((b) => b.id === current.id);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        select(beats[Math.min(beats.length - 1, i + 1)]);
      }
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        select(beats[Math.max(0, i - 1)]);
      }
      if (e.key === "Enter" && !opts.running && !locked && !t?.closest("button,a")) run(current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [beats, current, opts.running, locked, paletteOpen, run, select]);

  return { beats, current, outages, locked, select, run };
}
