import { BEATS, type BeatDef } from "@sparky/shared";

export type BeatPlane = "shopper" | "ops";

export const planeBeats = (plane: BeatPlane) => BEATS.filter((b) => b.plane === plane);

/** URL position of a beat: 1-based within its plane, so /ops/1 is beat 8a. */
export function beatPath(def: BeatDef): string {
  const i = planeBeats(def.plane as BeatPlane).findIndex((b) => b.id === def.id);
  return `/${def.plane}/${i + 1}`;
}

/** Resolve the :beat param (position "2", or a display label such as "8b"). */
export function resolveBeat(plane: BeatPlane, param: string | undefined): BeatDef | null {
  const list = planeBeats(plane);
  if (!param) return null;
  if (/^\d+$/.test(param)) {
    const n = Number(param);
    if (n >= 1 && n <= list.length) return list[n - 1];
  }
  return list.find((b) => b.label.toLowerCase() === param.toLowerCase()) ?? null;
}
