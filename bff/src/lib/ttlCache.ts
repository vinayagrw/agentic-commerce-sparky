/**
 * Response cache by input hash with a TTL (Phase 2). Used for follow-up suggestions, prompt starters
 * and compare results. A hit is always labelled `cached: true` with its age, so a cached answer is
 * never presented as freshly computed.
 */
import { createHash } from "node:crypto";

export const hashKey = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

export class TtlCache<T> {
  private m = new Map<string, { at: number; v: T }>();
  hits = 0;
  misses = 0;
  constructor(readonly ttlMs: number, readonly max = 500, private now = () => Date.now()) {}
  get(key: string): { value: T; ageMs: number } | null {
    const e = this.m.get(key);
    if (!e || this.now() - e.at > this.ttlMs) {
      if (e) this.m.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return { value: e.v, ageMs: this.now() - e.at };
  }
  set(key: string, v: T) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(key, { at: this.now(), v });
  }
  stats() {
    return { size: this.m.size, hits: this.hits, misses: this.misses, ttl_ms: this.ttlMs };
  }
}
