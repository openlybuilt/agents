import type { ComputerAction } from "../agent/actions.js";
import type { BrowserScreenshot } from "../browser/session.js";

export type ModelDecision =
  | { type: "action"; action: ComputerAction }
  | { type: "complete"; message: string };
export type ModelContext = {
  instruction: string;
  screenshot: BrowserScreenshot;
  previousActions: readonly ComputerAction[];
};
export interface ComputerModel {
  decide(context: ModelContext, signal: AbortSignal): Promise<ModelDecision>;
}
