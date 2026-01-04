

/*
  DRESZI — Serverless-safe time budget utilities

  Purpose
  - Enforce predictable runtime by providing cheap, deterministic checkpoints.
  - Avoid relying solely on platform timeouts; instead, we early-exit safely.

  Notes
  - This is intentionally minimal and dependency-free.
  - Uses injected clock when provided for testability.
*/

export interface TimeBudget {
  /** Wall clock time when the budget started (ms). */
  readonly started_at_ms: number;

  /** Maximum allowed elapsed time (ms). */
  readonly budget_ms: number;

  /** Returns the current time in ms. */
  readonly nowMs: () => number;
}

export interface TimeBudgetSnapshot {
  readonly elapsed_ms: number;
  readonly remaining_ms: number;
  readonly over_budget: boolean;
}

/**
 * Create a new time budget.
 */
export function createTimeBudget(budget_ms: number, nowMs: () => number = () => Date.now()): TimeBudget {
  if (!Number.isFinite(budget_ms) || budget_ms <= 0) {
    throw new Error(`TimeBudget invalid: budget_ms must be > 0 (got ${budget_ms})`);
  }

  return {
    started_at_ms: nowMs(),
    budget_ms,
    nowMs
  };
}

/**
 * Snapshot current elapsed/remaining time.
 */
export function snapshotBudget(b: TimeBudget): TimeBudgetSnapshot {
  const elapsed_ms = Math.max(0, b.nowMs() - b.started_at_ms);
  const remaining_ms = Math.max(0, b.budget_ms - elapsed_ms);
  return {
    elapsed_ms,
    remaining_ms,
    over_budget: elapsed_ms >= b.budget_ms
  };
}

/**
 * Whether we should early-exit now.
 *
 * `min_remaining_ms` is a guard to ensure we keep enough time to do:
 * - summary logging
 * - fallback path
 * - minimal serialization
 */
export function shouldExit(b: TimeBudget, min_remaining_ms: number = 250): boolean {
  if (!Number.isFinite(min_remaining_ms) || min_remaining_ms < 0) {
    throw new Error(`TimeBudget invalid: min_remaining_ms must be >= 0 (got ${min_remaining_ms})`);
  }

  const snap = snapshotBudget(b);
  return snap.remaining_ms <= min_remaining_ms;
}

/**
 * Convenience helper: throws with a caller-provided message if time budget exceeded.
 */
export function assertWithinBudget(b: TimeBudget, min_remaining_ms: number, message: string): void {
  if (shouldExit(b, min_remaining_ms)) {
    const snap = snapshotBudget(b);
    throw new Error(
      `${message} (elapsed=${snap.elapsed_ms}ms, remaining=${snap.remaining_ms}ms, budget=${b.budget_ms}ms)`
    );
  }
}

/**
 * Convert a snapshot into a compact object for structured logs.
 */
export function budgetLogFields(b: TimeBudget): { elapsed_ms: number; remaining_ms: number; budget_ms: number } {
  const snap = snapshotBudget(b);
  return {
    elapsed_ms: snap.elapsed_ms,
    remaining_ms: snap.remaining_ms,
    budget_ms: b.budget_ms
  };
}