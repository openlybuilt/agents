import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { ComputerAgent } from "../agent/computer-agent.js";
import type { ComputerRecording } from "../computer/session.js";
import type { WorkflowRunner } from "../workflow/runner.js";
import { BackendClient, type RunUpdate } from "./backend-client.js";
import type { RunRequest } from "./contracts.js";
import { RunEventSender } from "./events.js";

type ActiveRun = {
  request: RunRequest;
  status: RunUpdate["status"] | "cancelling";
  controller: AbortController;
  readinessController: AbortController;
  readinessTask?: Promise<void>;
  task: Promise<void>;
  recordingDisabled: boolean;
  recordingController: AbortController;
  recordingOutageController: AbortController;
  stopRecording?: () => Promise<void>;
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
      readinessController: new AbortController(),
      task: Promise.resolve(),
      recordingDisabled: !request.recordingEnabled,
      recordingController: new AbortController(),
      recordingOutageController: new AbortController(),
    };
    this.active.set(request.id, run);
    run.task = this.execute(run)
      .catch(() => console.error("Execution result could not reach backend"))
      .finally(async () => {
        run.readinessController.abort();
        await run.readinessTask;
        this.active.delete(request.id);
      });
    return this.get(request.id)!;
  }

  private async execute(run: ActiveRun): Promise<void> {
    const { request, controller } = run;
    const events = request.workflow
      ? new RunEventSender(this.backend, request.id)
      : undefined;
    let reportingFailed = false;
    const checkReadiness = async () => {
      try {
        await this.backend.ready(run.readinessController.signal);
      } catch (error) {
        if (!run.readinessController.signal.aborted) {
          reportingFailed = true;
          run.recordingController.abort();
          run.recordingOutageController.abort();
          controller.abort();
        }
        throw error;
      }
    };
    const report = async (update: RunUpdate) => {
      if (reportingFailed) throw new Error("Backend reporting unavailable");
      try {
        await this.backend.update(request.id, update);
        if (run.status !== "cancelling") run.status = update.status;
      } catch (error) {
        reportingFailed = true;
        run.recordingController.abort();
        run.recordingOutageController.abort();
        controller.abort();
        throw error;
      }
    };
    let result: NonNullable<RunUpdate["result"]>;
    let recording: ComputerRecording | undefined;
    let recordingFailed = false;
    try {
      await checkReadiness();
      run.readinessTask = (async () => {
        for (;;) {
          await delay(5000, undefined, {
            signal: run.readinessController.signal,
          });
          await checkReadiness();
        }
      })().catch(() => undefined);
      await report({ status: "provisioning" });
      if (request.workflow && request.recordingEnabled)
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
            onEvent: (event) => events?.emit(event),
            recordingOutageSignal: run.recordingOutageController.signal,
            recordingTransferSignal: run.recordingController.signal,
            ...(request.recordingEnabled
              ? {
                  shouldRecord: () => !run.recordingDisabled,
                  onRecording: async (
                    capture: ComputerRecording,
                    stop: () => Promise<void>,
                  ) => {
                    run.stopRecording = stop;
                    if (run.recordingDisabled) {
                      try {
                        await stop();
                      } catch (error) {
                        controller.abort();
                        throw error;
                      }
                      return;
                    }
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
                  onRecordingComplete: async (
                    capture: ComputerRecording,
                    signal: AbortSignal,
                  ) => {
                    if (recordingFailed || run.recordingDisabled)
                      throw new Error("Run recording was unavailable");
                    const deadline = AbortSignal.any([
                      signal,
                      run.recordingController.signal,
                    ]);
                    const video = await capture.download(deadline);
                    deadline.throwIfAborted();
                    await this.backend.uploadRecording(
                      request.id,
                      video,
                      deadline,
                    );
                  },
                }
              : {}),
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
    if (await events?.finish()) result = { ...result, logsPartial: true };
    await this.backend.update(request.id, {
      status: result.status,
      result,
      liveViewUrl: null,
    });
    if (
      request.workflow &&
      request.recordingEnabled &&
      !run.recordingDisabled &&
      (!recording || recordingFailed)
    )
      await this.backend
        .recordingStatus(request.id, "failed")
        .catch(() =>
          console.error("Recording failure could not reach backend"),
        );
  }

  async disableRecording(id: string) {
    const run = this.active.get(id);
    if (!run) return undefined;
    run.recordingDisabled = true;
    run.recordingController.abort();
    try {
      await run.stopRecording?.();
    } catch (error) {
      run.controller.abort();
      throw error;
    }
    return this.get(id);
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
