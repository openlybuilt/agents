import { RECORDING_EXPORT_MS } from "../computer/recording-timeouts.js";
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
  constructor(
    private readonly base: string,
    private readonly callbackToken: string,
  ) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(callbackToken))
      throw new Error(
        "AGENTS_CALLBACK_TOKEN must be 32 to 256 URL-safe characters",
      );
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

  async ready(signal: AbortSignal): Promise<void> {
    const response = await fetch(new URL("/ready", this.base), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      redirect: "error",
    });
    await response.body?.cancel();
    if (response.status !== 200) throw new Error("Backend is not ready");
  }

  async update(id: string, update: RunUpdate): Promise<void> {
    const response = await fetch(
      new URL(`/internal/runs/${encodeURIComponent(id)}/update`, this.base),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.callbackToken}`,
        },
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
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.callbackToken}`,
        },
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
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.callbackToken}`,
        },
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
    video: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(
      new URL(`/internal/runs/${encodeURIComponent(id)}/recording`, this.base),
      {
        method: "POST",
        headers: {
          "content-type": "video/mp4",
          authorization: `Bearer ${this.callbackToken}`,
        },
        body: video,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(RECORDING_EXPORT_MS),
        ]),
        redirect: "error",
        ...{ duplex: "half" as const },
      },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("Backend recording upload failed");
  }
}
