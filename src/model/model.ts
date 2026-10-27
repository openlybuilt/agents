import type { ComputerAction } from "../agent/actions.js";
import type { BrowserScreenshot } from "../browser/session.js";

export type ModelDecision =
  | { type: "action"; action: ComputerAction; observation: string }
  | { type: "complete"; success: boolean; message: string };
export type ModelContext = {
  instruction: string;
  screenshot: BrowserScreenshot;
  previousActions: readonly ComputerAction[];
  previousObservations: readonly string[];
};
export interface ComputerModel {
  decide(context: ModelContext, signal: AbortSignal): Promise<ModelDecision>;
}
