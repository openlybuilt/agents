import { setTimeout as delay } from "node:timers/promises";
import type {
  BrowserProvider,
  BrowserRecording,
  BrowserSession,
} from "../browser/session.js";
import type { ComputerAgent } from "../agent/computer-agent.js";
import type { ResolvedWorkflow } from "./definition.js";
import { emitEvent, type EventSink } from "../runs/events.js";

export type StepResult = {
  index: number;
  type: string;
  status: "running" | "completed" | "failed" | "cancelled";
  message?: string;
};
export type WorkflowResult = {
  status: "completed" | "failed" | "cancelled";
  message: string;
  steps: StepResult[];
  cleanupError?: string;
};
export class WorkflowRunner {
  constructor(
    private readonly browser: BrowserProvider,
    private readonly agent: ComputerAgent,
  ) {}
  async run(
    workflow: ResolvedWorkflow,
    options: {
      signal: AbortSignal;
      timeoutMs: number;
      maxSteps: number;
      onStage?: (stage: "running" | "cleaning_up") => Promise<void>;
      onStep?: (steps: StepResult[]) => Promise<void>;
      onEvent?: EventSink;
      onLiveView?: (url?: string) => Promise<void>;
      shouldRecord?: () => boolean;
      onRecording?: (
        recording: BrowserRecording,
        stop: () => Promise<void>,
      ) => Promise<void>;
      onRecordingError?: () => void;
    },
  ): Promise<WorkflowResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout]);
    const steps: StepResult[] = [];
    let session: BrowserSession | undefined;
    let recordingStarted = false;
    let result: WorkflowResult = {
      status: "completed",
      message: "Workflow completed",
      steps,
    };
    try {
      signal.throwIfAborted();
      session = await this.browser.open({
        signal,
        timeoutMs: options.timeoutMs,
      });
      if (options.onRecording && options.shouldRecord?.() !== false) {
        try {
          const recording = await session.startRecording();
          recordingStarted = true;
          await options.onRecording(recording, () => session!.stopRecording());
        } catch {
          options.onRecordingError?.();
        }
      }
      await options.onLiveView?.(session.liveViewUrl);
      await options.onStage?.("running");
      for (let i = 0; i < workflow.steps.length; i++) {
        signal.throwIfAborted();
        const step = workflow.steps[i];
        const stepStarted = performance.now();
        const onEvent: EventSink = (event) =>
          emitEvent(options.onEvent, { ...event, stepIndex: i });
        const evidence: StepResult = {
          index: i,
          type: step.type,
          status: "running",
        };
        steps.push(evidence);
        emitEvent(options.onEvent, {
          kind: "step",
          stepIndex: i,
          stepType: step.type,
          status: "running",
        });
        try {
          await options.onStep?.(steps);
          signal.throwIfAborted();
          if (step.type === "navigate") await session.navigate(step.url);
          else if (step.type === "scroll") {
            const amount = ["up", "left"].includes(step.direction)
              ? -step.pixels
              : step.pixels;
            await session.scrollPage(
              ["left", "right"].includes(step.direction) ? amount : 0,
              ["up", "down"].includes(step.direction) ? amount : 0,
            );
          } else if (step.type === "wait")
            await delay(step.seconds * 1000, undefined, { signal });
          else if (step.type === "type") {
            if (step.target) {
              const focus = await this.agent.run(
                `Locate the text input described here: ${JSON.stringify(step.target)}${step.region ? `, located around ${JSON.stringify(step.region)}` : ""}. Click the input to focus it, then finish. Do not type any text or take any other action besides scrolling and clicking.`,
                {
                  session,
                  signal,
                  timeoutMs: options.timeoutMs,
                  maxSteps: options.maxSteps,
                  allowedActions: ["click", "scroll"],
                  onEvent,
                },
              );
              const last = focus.actions.at(-1);
              if (
                focus.status !== "completed" ||
                last?.name !== "click" ||
                last.status !== "completed"
              ) {
                evidence.message =
                  focus.status === "completed"
                    ? "Could not confirm the field was clicked"
                    : focus.message;
                throw new Error("Could not focus the text field");
              }
            }
            signal.throwIfAborted();
            await session.type(step.text);
          } else if (step.type === "press_keys")
            await session.pressKeys(step.keys);
          else if (step.type === "click" && "x" in step)
            await session.click(step.x, step.y);
          else {
            const agentResult = await this.agent.run(
              step.type === "click"
                ? `Click the following visible target: ${step.target}. Click only that target, then finish.`
                : step.instruction,
              {
                session,
                signal,
                timeoutMs: options.timeoutMs,
                maxSteps: options.maxSteps,
                onEvent,
              },
            );
            evidence.message = agentResult.message;
            if (agentResult.status !== "completed")
              throw new Error("AI step did not complete");
          }
          signal.throwIfAborted();
          evidence.status = "completed";
        } catch (error) {
          evidence.status = options.signal.aborted ? "cancelled" : "failed";
          emitEvent(options.onEvent, {
            kind: "step",
            stepIndex: i,
            stepType: step.type,
            status: evidence.status,
            durationMs: Math.round(performance.now() - stepStarted),
          });
          await options.onStep?.(steps);
          throw error;
        }
        emitEvent(options.onEvent, {
          kind: "step",
          stepIndex: i,
          stepType: step.type,
          status: "completed",
          durationMs: Math.round(performance.now() - stepStarted),
        });
        await options.onStep?.(steps);
      }
    } catch {
      const current = steps.at(-1);
      if (current?.status === "running")
        current.status = options.signal.aborted ? "cancelled" : "failed";
      result = {
        status: options.signal.aborted ? "cancelled" : "failed",
        message: options.signal.aborted
          ? "Workflow cancelled"
          : timeout.aborted
            ? "Workflow timed out"
            : "Workflow step or browser operation failed",
        steps,
      };
    } finally {
      if (session) {
        try {
          await options.onLiveView?.(undefined);
          await options.onStage?.("cleaning_up");
        } catch {
          result = {
            ...result,
            status: "failed",
            message: "Run status update failed",
          };
        }
        if (recordingStarted) {
          try {
            await session.stopRecording();
          } catch {
            options.onRecordingError?.();
          }
        }
        try {
          await session.close();
        } catch {
          result = {
            ...result,
            status: "failed",
            cleanupError: "Browser session cleanup failed",
          };
        }
      }
    }
    return result;
  }
}
