import type { ComputerAction } from "./actions.js";

export type ActionEvidence = {
  name: ComputerAction["name"];
  status: "completed" | "failed";
};
export type AgentResult = {
  status: "completed" | "failed" | "cancelled";
  message: string;
  actions: ActionEvidence[];
  cleanupError?: string;
};
