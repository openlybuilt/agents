import type { ComputerAgent } from "../agent/computer-agent.js";
import type { RunRequest } from "./contracts.js";
import { RunStore } from "./store.js";
import type { WorkflowRunner } from "../workflow/runner.js";

export class RunService {
  private readonly active = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private stopping = false;
  private readonly liveViews = new Map<string, string>();
  async get(id: string) {
    const record = await this.store.get(id);
    const url = this.liveViews.get(id);
    return record && url ? { ...record, liveViewUrl: url } : record;
  }
  private readonly creating = new Map<string, Promise<unknown>>();
  constructor(
    private readonly store: RunStore,
    private readonly agent: ComputerAgent,
    private readonly workflows: WorkflowRunner,
  ) {}
  async create(request: RunRequest) {
    if (this.stopping) throw new Error("Service is stopping");
    const prior = this.creating.get(request.id);
    const operation = (async () => {
      if (prior) await prior.catch(() => undefined);
      if (this.stopping) throw new Error("Service is stopping");
      const created = await this.store.create(request);
      if (this.stopping) {
        if (created.created) await this.store.status(request.id, "interrupted");
        throw new Error("Service is stopping");
      }
      if (
        !created.created &&
        created.record.status === "provisioning" &&
        !this.active.has(request.id)
      ) {
        // A previous commit may have succeeded even though its response was lost.
        await this.store.status(request.id, "interrupted");
        return (await this.store.get(request.id))!;
      }
      if (created.created) {
        const controller = new AbortController();
        const entry = { controller, task: Promise.resolve() };
        this.active.set(request.id, entry);
        entry.task = (async () => {
          const current = await this.retry(() => this.store.get(request.id));
          if (current?.status === "cancelling") controller.abort();
          await this.execute(request, controller);
        })()
          .catch(() => {
            console.error("Failed to persist run outcome");
          })
          .finally(() => this.active.delete(request.id));
      }
      return created.record;
    })();
    this.creating.set(request.id, operation);
    try {
      return await operation;
    } finally {
      if (this.creating.get(request.id) === operation)
        this.creating.delete(request.id);
    }
  }
  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (this.stopping) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  private async execute(
    request: RunRequest,
    controller: AbortController,
  ): Promise<void> {
    const options = {
      signal: controller.signal,
      maxSteps: request.maxSteps,
      timeoutMs: request.timeoutMs,
      onEvent: async (event: Record<string, unknown>) => {
        try {
          await this.store.appendEvent(request.id, event);
        } catch {
          console.error("Failed to persist run event");
        }
      },
      onStage: (stage: "running" | "cleaning_up") =>
        this.store.status(request.id, stage),
    };
    const result = request.workflow
      ? await this.workflows.run(request.workflow, {
          ...options,
          onStep: (steps) => this.store.progress(request.id, steps),
          saveRecording: (video) => this.store.saveRecording(request.id, video),
          onLiveView: (url) => {
            if (url) this.liveViews.set(request.id, url);
            else this.liveViews.delete(request.id);
          },
        })
      : await this.agent.run(request.instruction, options);
    await this.retry(() =>
      this.store.status(request.id, result.status, result),
    );
  }
  async cancel(id: string) {
    const record = await this.store.get(id);
    if (!record) return undefined;
    if (
      ["provisioning", "running", "cleaning_up", "cancelling"].includes(
        record.status,
      )
    ) {
      await this.store.status(id, "cancelling");
      this.active.get(id)?.controller.abort();
    }
    return this.store.get(id);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.creating.values()]);
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map((run) => run.task));
  }
}
