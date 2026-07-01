/**
 * Injectible clock seam for testable time-based behavior.
 * Route every schedule, cutoff, and timestamp decision through this.
 */
let clockOverride: (() => number) | null = null;

/** Current unix ms. */
export function now(): number {
  return clockOverride ? clockOverride() : Date.now();
}

/** Override the clock for tests. Pass null to restore. */
export function setClock(fn: (() => number) | null): void {
  clockOverride = fn;
}
