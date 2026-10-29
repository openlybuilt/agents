import { isDeepStrictEqual } from "node:util";
import type { ComputerAgent } from "../agent/computer-agent.js";
import type { BrowserRecording } from "../browser/session.js";
import type { WorkflowRunner } from "../workflow/runner.js";
import { BackendClient, type RunUpdate } from "./backend-client.js";
import type { RunRequest } from "./contracts.js";

type ActiveRun = {
  request: RunRequest;
  status: RunUpdate["status"] | "cancelling";
  controller: AbortController;
  task: Promise<void>;
};

export class RunService {
  private readonly active = new Map<string, ActiveRun>();
  private stopping = false;

  constructor(
    private readonly agent: ComputerAgent,
    private readonly workflows: WorkflowRunner,
    private readonly backend: BackendClient,
  ) {}

  get(id: string) {
    const run = this.active.get(id);
    return run ? { id, status: run.status } : undefined;
  }

  create(request: RunRequest) {
    if (this.stopping) throw new Error("Service is stopping");
    const existing = this.active.get(request.id);
    if (existing) {
      if (!isDeepStrictEqual(existing.request, request))
        throw new Error("Run ID already has different inputs");
      return this.get(request.id)!;
    }
    const run: ActiveRun = {
      request,
      status: "provisioning",
      controller: new AbortController(),
      task: Promise.resolve(),
    };
    this.active.set(request.id, run);
    run.task = this.execute(run)
      .catch(() => console.error("Execution result could not reach backend"))
      .finally(() => this.active.delete(request.id));
    return this.get(request.id)!;
  }

  private async execute(run: ActiveRun): Promise<void> {
    const { request, controller } = run;
    let reportingFailed = false;
    const report = async (update: RunUpdate) => {
      if (reportingFailed) throw new Error("Backend reporting unavailable");
      try {
        await this.backend.update(request.id, update);
        if (run.status !== "cancelling") run.status = update.status;
      } catch (error) {
        reportingFailed = true;
        controller.abort();
        throw error;
      }
    };
    let result: NonNullable<RunUpdate["result"]>;
    let recording: BrowserRecording | undefined;
    let recordingFailed = false;
    try {
      await report({ status: "provisioning" });
      if (request.workflow)
        await this.backend
          .recordingStatus(request.id, "pending")
          .catch(() =>
            console.error("Recording preparation could not reach backend"),
          );
      const options = {
        signal: controller.signal,
        maxSteps: request.maxSteps,
        timeoutMs: request.timeoutMs,
        onStage: (status: "running" | "cleaning_up") => report({ status }),
      };
      result = request.workflow
        ? await this.workflows.run(request.workflow, {
            ...options,
            onStep: (steps) => report({ status: "running", steps }),
            onRecording: async (capture) => {
              recording = capture;
              await this.backend.recordingStatus(
                request.id,
                "pending",
                capture,
              );
            },
            onRecordingError: () => {
              recordingFailed = true;
            },
            onLiveView: (url) =>
              report({
                status:
                  run.status === "cancelling" ? "cleaning_up" : run.status,
                liveViewUrl: url ?? null,
              }),
          })
        : await this.agent.run(request.instruction, options);
    } catch {
      result = {
        status: "interrupted",
        message: "Execution stopped before a result was available",
      };
    }
    if (reportingFailed)
      result = {
        status: "interrupted",
        message: "Execution stopped because progress could not be saved",
      };
    await this.backend.update(request.id, {
      status: result.status,
      result,
      liveViewUrl: null,
    });
    if (request.workflow) {
      try {
        if (!recording || recordingFailed)
          throw new Error("Browser recording was unavailable");
        const video = await recording.download();
        await this.backend.uploadRecording(request.id, video);
      } catch {
        await this.backend
          .recordingStatus(request.id, "failed")
          .catch(() =>
            console.error("Recording failure could not reach backend"),
          );
      }
    }
  }

  cancel(id: string) {
    const run = this.active.get(id);
    if (!run) return undefined;
    run.status = "cancelling";
    run.controller.abort();
    return this.get(id);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map((run) => run.task));
  }
}
