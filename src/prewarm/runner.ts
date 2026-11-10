import type { ComputerSession } from "../computer/session.js";
import type { PrewarmStep } from "./config.js";
import { emitEvent, type EventSink } from "../runs/events.js";
export class PrewarmError extends Error {
  constructor() {
    super("Prewarming failed");
  }
}

export async function prewarm(
  session: ComputerSession,
  steps: PrewarmStep[],
  signal: AbortSignal,
  onEvent?: EventSink,
  cancellation?: AbortSignal,
): Promise<void> {
  try {
    if (!session.prewarmSelector) throw new Error();
    for (const [index, step] of steps.entries()) {
      signal.throwIfAborted();
      const started = performance.now();
      const metadata = {
        kind: "prewarming" as const,
        stepIndex: index,
        stepType: step.type,
      };
      emitEvent(onEvent, { ...metadata, status: "running" });
      try {
        if (step.type === "goto") await session.navigate(step.url);
        else if (step.type === "fill")
          await session.prewarmSelector(
            "fill",
            step.selector,
            undefined,
            step.value,
          );
        else if (step.type === "click")
          await session.prewarmSelector("click", step.selector);
        else
          await session.prewarmSelector(
            "wait_for",
            step.selector,
            step.timeout,
          );
        signal.throwIfAborted();
        emitEvent(onEvent, {
          ...metadata,
          status: "completed",
          durationMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        emitEvent(onEvent, {
          ...metadata,
          status: cancellation?.aborted ? "cancelled" : "failed",
          durationMs: Math.round(performance.now() - started),
        });
        throw error;
      }
    }
    signal.throwIfAborted();
  } catch {
    throw new PrewarmError();
  }
}
