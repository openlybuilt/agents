import type { BrowserProvider, BrowserSession } from "../browser/session.js";
import type { ComputerAgent } from "../agent/computer-agent.js";
import type { ResolvedWorkflow } from "./definition.js";

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
    },
  ): Promise<WorkflowResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout]);
    const steps: StepResult[] = [];
    let session: BrowserSession | undefined;
    let result: WorkflowResult = {
      status: "completed",
      message: "Workflow completed",
      steps,
    };
    try {
      signal.throwIfAborted();
      session = await this.browser.open({ signal });
      await options.onStage?.("running");
      for (let i = 0; i < workflow.steps.length; i++) {
        signal.throwIfAborted();
        const step = workflow.steps[i];
        const evidence: StepResult = {
          index: i,
          type: step.type,
          status: "running",
        };
        steps.push(evidence);
        await options.onStep?.(steps);
        try {
          if (step.type === "navigate") await session.navigate(step.url);
          else if (step.type === "type") await session.type(step.text);
          else if (step.type === "press_keys")
            await session.pressKeys(step.keys);
          else if (step.type === "click") await session.click(step.x, step.y);
          else {
            const agentResult = await this.agent.run(step.instruction, {
              session,
              signal,
              timeoutMs: options.timeoutMs,
              maxSteps: options.maxSteps,
            });
            evidence.message = agentResult.message;
            if (agentResult.status !== "completed")
              throw new Error("AI step did not complete");
          }
          signal.throwIfAborted();
          evidence.status = "completed";
        } catch (error) {
          evidence.status = options.signal.aborted ? "cancelled" : "failed";
          await options.onStep?.(steps);
          throw error;
        }
        await options.onStep?.(steps);
      }
    } catch {
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
          await options.onStage?.("cleaning_up");
        } catch {
          result = {
            ...result,
            status: "failed",
            message: "Run status update failed",
          };
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
