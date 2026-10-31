import type { ComputerAction } from "../agent/actions.js";
import type { ComputerScreenshot } from "../computer/session.js";

export type ModelDecision = (
  | { type: "action"; action: ComputerAction; observation: string }
  | { type: "complete"; success: boolean; message: string }
) & { usage?: { inputTokens: number; outputTokens: number } };
export type ModelContext = {
  instruction: string;
  screenshot: ComputerScreenshot;
  previousActions: readonly ComputerAction[];
  previousObservations: readonly string[];
};
export interface ComputerModel {
  decide(context: ModelContext, signal: AbortSignal): Promise<ModelDecision>;
}
