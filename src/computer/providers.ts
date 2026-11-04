import type {
  ComputerOpenOptions,
  ComputerProvider,
  ComputerSession,
  ExecutionTarget,
  ProviderId,
} from "./session.js";

export class ExecutionTargetUnavailableError extends Error {
  constructor(target: ExecutionTarget, provider?: ProviderId) {
    super(
      provider
        ? `${provider} is unavailable for ${target} execution`
        : `${target === "windows" ? "Windows" : "Browser"} execution is unavailable`,
    );
  }
}

type ProviderRegistry = Partial<
  Record<ProviderId, Partial<Record<ExecutionTarget, ComputerProvider>>>
>;

const providerIds = ["onkernel", "daytona"] as const;
const targets = ["browser", "windows"] as const;

export class ComputerProviders implements ComputerProvider {
  constructor(private readonly providers: ProviderRegistry) {}

  executionTargets(): ExecutionTarget[] {
    return targets.filter((target) =>
      providerIds.some((id) => this.providers[id]?.[target] !== undefined),
    );
  }

  providerCapabilities(): {
    id: ProviderId;
    executionTargets: ExecutionTarget[];
  }[] {
    return providerIds.flatMap((id) => {
      const executionTargets = targets.filter(
        (target) => this.providers[id]?.[target] !== undefined,
      );
      return executionTargets.length ? [{ id, executionTargets }] : [];
    });
  }

  async open(options: ComputerOpenOptions = {}): Promise<ComputerSession> {
    const target =
      options.executionTarget === undefined
        ? "browser"
        : options.executionTarget;
    if (target !== "browser" && target !== "windows")
      throw new Error("Unknown execution target");
    options.signal?.throwIfAborted();
    const id =
      options.provider ?? (target === "browser" ? "onkernel" : "daytona");
    if (!providerIds.includes(id)) throw new Error("Unknown computer provider");
    const provider = this.providers[id]?.[target];
    if (!provider)
      throw new ExecutionTargetUnavailableError(target, options.provider);
    return provider.open({ ...options, executionTarget: target, provider: id });
  }
}
