export type BackgroundWorkState = "unknown" | "idle" | "busy";

export const RUNNER_IDLE_MS = 10 * 60 * 1_000;
export const RUNNER_UNKNOWN_IDLE_MS = 2 * 60 * 60 * 1_000;

export interface RunnerIdleInput {
  turnBusy: boolean;
  backgroundWork: BackgroundWorkState;
  idleSinceMs: number;
}

export type RunnerIdleDecision =
  | { action: "keep-open"; reason: "turn-busy" | "background-busy"; deadlineMs: null }
  | { action: "wait"; reason: "known-idle" | "unknown"; deadlineMs: number; delayMs: number }
  | { action: "close"; reason: "known-idle" | "unknown"; deadlineMs: number; delayMs: 0 };

/**
 * The main turn must be done before an idle clock starts. Known empty background state uses the
 * normal 10-minute grace period; SDKs without a reliable snapshot get the conservative 2-hour one.
 */
export function decideRunnerIdle(input: RunnerIdleInput, nowMs: number): RunnerIdleDecision {
  if (input.turnBusy) return { action: "keep-open", reason: "turn-busy", deadlineMs: null };
  if (input.backgroundWork === "busy") return { action: "keep-open", reason: "background-busy", deadlineMs: null };
  const duration = input.backgroundWork === "idle" ? RUNNER_IDLE_MS : RUNNER_UNKNOWN_IDLE_MS;
  const deadlineMs = input.idleSinceMs + duration;
  const reason = input.backgroundWork === "idle" ? "known-idle" : "unknown";
  return nowMs >= deadlineMs
    ? { action: "close", reason, deadlineMs, delayMs: 0 }
    : { action: "wait", reason, deadlineMs, delayMs: deadlineMs - nowMs };
}

export function idleDelayFor(backgroundWork: BackgroundWorkState, turnBusy: boolean): number | null {
  if (turnBusy || backgroundWork === "busy") return null;
  return backgroundWork === "idle" ? RUNNER_IDLE_MS : RUNNER_UNKNOWN_IDLE_MS;
}
