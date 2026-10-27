import type { ComputerAgent } from "../agent/computer-agent.js";
import type { RunRequest } from "./contracts.js";
import { RunStore } from "./store.js";

export class RunService {
  private readonly active = new Map<
    string,
    { controller: AbortController; task: Promise<void> }
  >();
  private stopping = false;
  constructor(
    private readonly store: RunStore,
    private readonly agent: ComputerAgent,
  ) {}
  async create(request: RunRequest) {
    if (this.stopping) throw new Error("Service is stopping");
    const created = await this.store.create(request);
    if (created.created) {
      const controller = new AbortController();
      const entry = { controller, task: Promise.resolve() };
      this.active.set(request.id, entry);
      entry.task = (async () => {
        const current = await this.store.get(request.id);
        if (current?.status === "cancelling") controller.abort();
        await this.execute(request, controller);
      })()
        .catch(() => {
          console.error("Failed to persist run outcome");
        })
        .finally(() => this.active.delete(request.id));
    }
    return created.record;
  }
  private async execute(
    request: RunRequest,
    controller: AbortController,
  ): Promise<void> {
    const result = await this.agent.run(request.instruction, {
      signal: controller.signal,
      maxSteps: request.maxSteps,
      timeoutMs: request.timeoutMs,
      onStage: (stage) => this.store.status(request.id, stage),
    });
    await this.store.status(request.id, result.status, result);
  }
  async cancel(id: string) {
    const record = await this.store.get(id);
    if (!record) return undefined;
    const active = this.active.get(id);
    if (
      ["provisioning", "running", "cleaning_up", "cancelling"].includes(
        record.status,
      )
    ) {
      await this.store.status(id, "cancelling");
      active?.controller.abort();
    }
    return this.store.get(id);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map((run) => run.task));
  }
}
