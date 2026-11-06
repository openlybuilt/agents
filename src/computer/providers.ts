import {
  defaultProvider,
  executionTargets,
  isProviderId,
  providerIds,
  supportsTarget,
} from "./provider-catalog.js";
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

export class ComputerProviders implements ComputerProvider {
  constructor(private readonly providers: ProviderRegistry) {}

  executionTargets(): ExecutionTarget[] {
    return executionTargets.filter((target) =>
      providerIds.some(
        (id) =>
          supportsTarget(id, target) &&
          this.providers[id]?.[target] !== undefined,
      ),
    );
  }

  providerCapabilities(): {
    id: ProviderId;
    executionTargets: ExecutionTarget[];
  }[] {
    return providerIds.flatMap((id) => {
      const targets = executionTargets.filter(
        (target) =>
          supportsTarget(id, target) &&
          this.providers[id]?.[target] !== undefined,
      );
      return targets.length ? [{ id, executionTargets: targets }] : [];
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
    const id = options.provider ?? defaultProvider(target);
    if (!isProviderId(id)) throw new Error("Unknown computer provider");
    const provider = supportsTarget(id, target)
      ? this.providers[id]?.[target]
      : undefined;
    if (!provider)
      throw new ExecutionTargetUnavailableError(target, options.provider);
    return provider.open({ ...options, executionTarget: target, provider: id });
  }
}
