import type { BrowserProvider, BrowserSession } from "../browser/session.js";
import type { ComputerModel } from "../model/model.js";
import { executeAction, parseAction, type ComputerAction } from "./actions.js";
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
      onStage?: (stage: "running" | "cleaning_up") => Promise<void>;
      session?: BrowserSession;
      allowedActions?: ComputerAction["name"][];
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
    const observations: string[] = [];
    const actions: ActionEvidence[] = [];
    let session: BrowserSession | undefined;
    let stage = "Browser session creation";
    let actionName: string | undefined;
    let result: AgentResult = {
      status: "failed",
      message: "Step limit reached",
      actions,
    };
    try {
      signal.throwIfAborted();
      session = options.session ?? (await this.browser.open({ signal }));
      if (!options.session) await options.onStage?.("running");
      for (let step = 0; step < maxSteps; step++) {
        signal.throwIfAborted();
        stage = "Screenshot capture";
        const screenshot = await session.screenshot();
        signal.throwIfAborted();
        stage = "Model decision";
        const decision = await this.model.decide(
          {
            instruction,
            screenshot,
            previousActions: history,
            previousObservations: observations,
          },
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
        stage = "Action validation";
        if (
          typeof decision.observation !== "string" ||
          decision.observation.length > 2000
        )
          throw new Error("Invalid observation");
        const { name, ...arguments_ } = decision.action;
        const action = parseAction(name, arguments_);
        if (
          options.allowedActions &&
          !options.allowedActions.includes(action.name)
        )
          throw new Error("Action is not allowed for this step");
        const evidence: ActionEvidence = {
          name: action.name,
          status: "failed",
        };
        actions.push(evidence);
        stage = "Browser action";
        actionName = action.name;
        await executeAction(session, action);
        evidence.status = "completed";
        history.push(action);
        observations.push(decision.observation);
        signal.throwIfAborted();
      }
    } catch (error) {
      const status =
        error &&
        typeof error === "object" &&
        "status" in error &&
        typeof error.status === "number"
          ? ` (provider status ${error.status})`
          : "";
      result = options.signal?.aborted
        ? { status: "cancelled", message: "Run cancelled", actions }
        : timeout.aborted
          ? { status: "failed", message: "Run timed out", actions }
          : {
              status: "failed",
              message: `${stage}${stage === "Browser action" && actionName ? ` (${actionName})` : ""} failed${status}`,
              actions,
            };
    } finally {
      if (session && !options.session) {
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
