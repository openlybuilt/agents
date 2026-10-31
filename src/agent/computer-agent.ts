import type { ComputerProvider, ComputerSession } from "../computer/session.js";
import { HorizontalScrollUnavailableError } from "../computer/session.js";
import { ExecutionTargetUnavailableError } from "../computer/providers.js";
import type { ComputerModel, ModelDecision } from "../model/model.js";
import { emitEvent, type EventSink } from "../runs/events.js";
import { executeAction, parseAction, type ComputerAction } from "./actions.js";
import type { ActionEvidence, AgentResult } from "./result.js";

export class ComputerAgent {
  constructor(
    private readonly computer: ComputerProvider,
    private readonly model: ComputerModel,
  ) {}

  async run(
    instruction: string,
    options: {
      signal?: AbortSignal;
      maxSteps?: number;
      timeoutMs?: number;
      onStage?: (stage: "running" | "cleaning_up") => Promise<void>;
      session?: ComputerSession;
      allowedActions?: ComputerAction["name"][];
      stopAfterClick?: boolean;
      onEvent?: EventSink;
    } = {},
  ): Promise<AgentResult> {
    const maxSteps = options.maxSteps ?? 20;
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!instruction.trim() || instruction.length > 10000)
      throw new Error("Instruction must contain 1 to 10000 characters");
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100)
      throw new Error("maxSteps must be between 1 and 100");
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 3_600_000
    )
      throw new Error("timeoutMs must be between 1000 and 3600000");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    const history: ComputerAction[] = [];
    const observations: string[] = [];
    const actions: ActionEvidence[] = [];
    let session: ComputerSession | undefined;
    let stage = "Computer session creation";
    let actionName: string | undefined;
    let result: AgentResult = {
      status: "failed",
      message: "Step limit reached",
      actions,
    };
    try {
      signal.throwIfAborted();
      session =
        options.session ?? (await this.computer.open({ signal, timeoutMs }));
      if (!options.session) await options.onStage?.("running");
      for (let step = 0; step < maxSteps; step++) {
        signal.throwIfAborted();
        stage = "Screenshot capture";
        const screenshot = await session.screenshot();
        signal.throwIfAborted();
        stage = "Model decision";
        const started = performance.now();
        let decision: ModelDecision;
        try {
          decision = await this.model.decide(
            {
              instruction,
              screenshot,
              previousActions: history,
              previousObservations: observations,
            },
            signal,
          );
        } catch (error) {
          emitEvent(options.onEvent, {
            kind: "model",
            status: signal.aborted ? "cancelled" : "failed",
            durationMs: Math.round(performance.now() - started),
          });
          throw error;
        }
        emitEvent(options.onEvent, {
          kind: "model",
          status: "completed",
          durationMs: Math.round(performance.now() - started),
          ...(decision.usage ? { usage: decision.usage } : {}),
        });
        signal.throwIfAborted();
        if (decision.type === "complete") {
          const missingClick = options.stopAfterClick && decision.success;
          result = {
            status: decision.success && !missingClick ? "completed" : "failed",
            message: missingClick
              ? "No click action was completed"
              : decision.message,
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
        stage = "Computer action";
        actionName = action.name;
        const actionStarted = performance.now();
        try {
          await executeAction(session, action);
        } catch (error) {
          emitEvent(options.onEvent, {
            kind: "action",
            action: action.name,
            status: signal.aborted ? "cancelled" : "failed",
            durationMs: Math.round(performance.now() - actionStarted),
          });
          throw error;
        }
        emitEvent(options.onEvent, {
          kind: "action",
          action: action.name,
          status: "completed",
          durationMs: Math.round(performance.now() - actionStarted),
        });
        evidence.status = "completed";
        history.push(action);
        observations.push(decision.observation);
        signal.throwIfAborted();
        if (options.stopAfterClick && action.name === "click") {
          result = {
            status: "completed",
            message: "Click action completed",
            actions,
          };
          break;
        }
      }
    } catch (error) {
      if (
        options.session &&
        !signal.aborted &&
        error instanceof HorizontalScrollUnavailableError
      )
        throw error;
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
              message:
                error instanceof ExecutionTargetUnavailableError ||
                error instanceof HorizontalScrollUnavailableError
                  ? error.message
                  : `${stage}${stage === "Computer action" && actionName ? ` (${actionName})` : ""} failed${status}`,
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
            cleanupError: "Computer session cleanup failed",
          };
        }
      }
    }
    return result;
  }
}
