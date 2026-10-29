import type {
  ComputerOpenOptions,
  ComputerProvider,
  ComputerSession,
  ExecutionTarget,
} from "./session.js";

export class ExecutionTargetUnavailableError extends Error {
  constructor(target: ExecutionTarget) {
    super(
      `${target === "windows" ? "Windows" : "Browser"} execution is unavailable`,
    );
  }
}

export class ComputerProviders implements ComputerProvider {
  constructor(
    private readonly providers: Partial<
      Record<ExecutionTarget, ComputerProvider>
    >,
  ) {}

  async open(options: ComputerOpenOptions = {}): Promise<ComputerSession> {
    const target =
      options.executionTarget === undefined
        ? "browser"
        : options.executionTarget;
    if (target !== "browser" && target !== "windows")
      throw new Error("Unknown execution target");
    options.signal?.throwIfAborted();
    const provider = this.providers[target];
    if (!provider) throw new ExecutionTargetUnavailableError(target);
    return provider.open({ ...options, executionTarget: target });
  }
}
