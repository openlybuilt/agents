import type { BrowserProvider, BrowserSession } from "../browser/session.js";
import type { ComputerModel } from "../model/model.js";
import { executeAction, type ComputerAction } from "./actions.js";
import type { ActionEvidence, AgentResult } from "./result.js";

export class ComputerAgent {
  constructor(
    private readonly browser: BrowserProvider,
    private readonly model: ComputerModel,
  ) {}

  async run(
    instruction: string,
    options: {
      signal?: AbortSignal;
      maxSteps?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<AgentResult> {
    const maxSteps = options.maxSteps ?? 20;
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!instruction.trim() || instruction.length > 10000)
      throw new Error("Instruction must contain 1 to 10000 characters");
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100)
      throw new Error("maxSteps must be between 1 and 100");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000)
      throw new Error("timeoutMs must be between 1000 and 600000");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const history: ComputerAction[] = [];
    const actions: ActionEvidence[] = [];
    let session: BrowserSession | undefined;
    let result: AgentResult = {
      status: "failed",
      message: "Step limit reached",
      actions,
    };
    try {
      signal.throwIfAborted();
      session = await this.browser.open({ signal });
      for (let step = 0; step < maxSteps; step++) {
        signal.throwIfAborted();
        const screenshot = await session.screenshot();
        signal.throwIfAborted();
        const decision = await this.model.decide(
          { instruction, screenshot, previousActions: history },
          signal,
        );
        signal.throwIfAborted();
        if (decision.type === "complete") {
          result = {
            status: decision.success ? "completed" : "failed",
            message: decision.message,
            actions,
          };
          break;
        }
        const evidence: ActionEvidence = {
          name: decision.action.name,
          status: "failed",
        };
        actions.push(evidence);
        await executeAction(session, decision.action);
        evidence.status = "completed";
        history.push(decision.action);
      }
    } catch {
      result = options.signal?.aborted
        ? { status: "cancelled", message: "Run cancelled", actions }
        : timeout.aborted
          ? { status: "failed", message: "Run timed out", actions }
          : {
              status: "failed",
              message: "Browser or model operation failed",
              actions,
            };
    } finally {
      if (session) {
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
