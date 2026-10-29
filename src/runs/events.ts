import type { ComputerAction } from "../agent/actions.js";
import type { WorkflowStep } from "../workflow/definition.js";

type Outcome = "completed" | "failed" | "cancelled";
export type RunEventDraft =
  | {
      kind: "step";
      stepIndex: number;
      stepType: WorkflowStep["type"];
      status: Outcome | "running";
      durationMs?: number;
    }
  | {
      kind: "model";
      stepIndex?: number;
      status: Outcome;
      durationMs: number;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | {
      kind: "action";
      stepIndex?: number;
      action: ComputerAction["name"];
      status: Outcome;
      durationMs: number;
    };
export type RunEvent = RunEventDraft & {
  sequence: number;
  timestamp: string;
};
export type EventSink = (event: RunEventDraft) => void | Promise<void>;

export function emitEvent(
  sink: EventSink | undefined,
  event: RunEventDraft,
): void {
  try {
    void Promise.resolve(sink?.(event)).catch(() => undefined);
  } catch {
    // Diagnostics must not change execution outcomes.
  }
}
