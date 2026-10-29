import type { AgentResult } from "../agent/result.js";
import type { StepResult, WorkflowResult } from "../workflow/runner.js";
import type { RunEvent } from "./events.js";

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
  result?: (
    | AgentResult
    | WorkflowResult
    | { status: "interrupted"; message: string }
  ) & { logsPartial?: boolean };
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

  async appendEvents(
    id: string,
    events: readonly RunEvent[],
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      new URL(`/internal/runs/${encodeURIComponent(id)}/events`, this.base),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        redirect: "error",
      },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("Backend log delivery failed");
  }

  async recordingStatus(
    id: string,
    status: "pending" | "failed",
    reference?: { browserId: string; replayId: string },
  ): Promise<void> {
    const response = await fetch(
      new URL(
        `/internal/runs/${encodeURIComponent(id)}/recording/status`,
        this.base,
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, ...reference }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("Backend recording update failed");
  }

  async uploadRecording(
    id: string,
    video: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const response = await fetch(
      new URL(`/internal/runs/${encodeURIComponent(id)}/recording`, this.base),
      {
        method: "POST",
        headers: { "content-type": "video/mp4" },
        body: video,
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("Backend recording upload failed");
  }
}
