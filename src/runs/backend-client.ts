import type { AgentResult } from "../agent/result.js";
import type { StepResult, WorkflowResult } from "../workflow/runner.js";

export type RunUpdate = {
  status:
    | "provisioning"
    | "running"
    | "cleaning_up"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  steps?: StepResult[];
  result?:
    | AgentResult
    | WorkflowResult
    | { status: "interrupted"; message: string };
  liveViewUrl?: string | null;
};

export class BackendClient {
  constructor(private readonly base: string) {
    const url = new URL(base);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("BACKEND_URL must be a loopback HTTP origin");
  }

  async update(id: string, update: RunUpdate): Promise<void> {
    const response = await fetch(
      new URL(`/internal/runs/${encodeURIComponent(id)}/update`, this.base),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("Backend execution update failed");
  }
}
