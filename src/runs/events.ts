import type { ComputerAction } from "../agent/actions.js";
import type { WorkflowStep } from "../workflow/definition.js";
import type { PrewarmStep } from "../prewarm/config.js";
import type { BackendClient } from "./backend-client.js";

type Outcome = "completed" | "failed" | "cancelled";
export type RunEventDraft =
  | {
      kind: "prewarming";
      stepIndex: number;
      stepType: PrewarmStep["type"];
      status: Outcome | "running";
      durationMs?: number;
    }
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

export class RunEventSender {
  private readonly queue: RunEvent[] = [];
  private readonly controller = new AbortController();
  private task?: Promise<void>;
  private sequence = 0;
  private closed = false;
  private partial = false;

  constructor(
    private readonly backend: BackendClient,
    private readonly id: string,
  ) {}

  emit(event: RunEventDraft): void {
    if (this.closed || this.sequence === 10000) {
      this.partial = true;
      return;
    }
    const sequence = ++this.sequence;
    if (this.queue.length >= 256) {
      this.partial = true;
      return;
    }
    try {
      // Copy only safe metadata once; retries reuse the same timestamp and payload.
      const frozen = JSON.parse(
        JSON.stringify(
          { ...event, sequence, timestamp: new Date().toISOString() },
          [
            "sequence",
            "timestamp",
            "kind",
            "status",
            "stepIndex",
            "stepType",
            "action",
            "durationMs",
            "usage",
            "inputTokens",
            "outputTokens",
          ],
        ),
      ) as RunEvent;
      this.queue.push(frozen);
      this.start();
    } catch {
      this.partial = true;
    }
  }

  private start(): void {
    if (this.task || this.closed || !this.queue.length) return;
    this.task = this.drain().finally(() => {
      this.task = undefined;
      this.start();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.closed) {
      const batch = this.queue.splice(0, 32);
      let delivered = false;
      for (let attempt = 0; attempt < 2 && !this.closed; attempt++) {
        try {
          await this.backend.appendEvents(
            this.id,
            batch,
            this.controller.signal,
          );
          delivered = true;
          break;
        } catch {
          // Log delivery is independent from execution and progress reporting.
        }
      }
      if (!delivered) this.partial = true;
    }
  }

  private async flush(): Promise<void> {
    while (this.task) await this.task;
  }

  async finish(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.partial = true;
            resolve();
          }, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.closed = true;
      this.controller.abort();
      if (this.queue.length) this.partial = true;
      this.queue.length = 0;
    }
    return this.partial;
  }
}
