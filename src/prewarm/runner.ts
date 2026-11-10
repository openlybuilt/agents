import type { ComputerSession } from "../computer/session.js";
import type { PrewarmStep } from "./config.js";
export class PrewarmError extends Error {
  constructor() {
    super("Prewarming failed");
  }
}

export async function prewarm(
  session: ComputerSession,
  steps: PrewarmStep[],
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!session.prewarmSelector) throw new Error();
    for (const step of steps) {
      signal.throwIfAborted();
      if (step.type === "goto") await session.navigate(step.url);
      else if (step.type === "fill")
        await session.prewarmSelector(
          "fill",
          step.selector,
          undefined,
          step.value,
        );
      else if (step.type === "click")
        await session.prewarmSelector("click", step.selector);
      else
        await session.prewarmSelector("wait_for", step.selector, step.timeout);
    }
    signal.throwIfAborted();
  } catch {
    throw new PrewarmError();
  }
}
