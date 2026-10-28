export type WorkflowStep =
  | { type: "navigate"; url: string }
  | { type: "type"; text: string }
  | { type: "press_keys"; keys: string[] }
  | { type: "click"; x: number; y: number }
  | { type: "ai"; instruction: string };
export type ResolvedWorkflow = { steps: WorkflowStep[] };

export function parseWorkflow(input: unknown): ResolvedWorkflow {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid workflow");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 30
  )
    throw new Error("Workflow requires 1 to 30 steps");
  const steps = value.steps.map((raw): WorkflowStep => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Invalid workflow step");
    const step = raw as Record<string, unknown>;
    const keys = Object.keys(step);
    const exact = (...names: string[]) =>
      keys.length === names.length &&
      names.every((name) => names.includes(name) && keys.includes(name));
    if (
      step.type === "navigate" &&
      exact("type", "url") &&
      typeof step.url === "string" &&
      step.url.length <= 2048
    ) {
      const url = new URL(step.url);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Invalid URL protocol");
      return { type: "navigate", url: url.href };
    }
    if (
      step.type === "type" &&
      exact("type", "text") &&
      typeof step.text === "string" &&
      step.text.length <= 10000
    )
      return { type: "type", text: step.text };
    if (
      step.type === "ai" &&
      exact("type", "instruction") &&
      typeof step.instruction === "string" &&
      step.instruction.trim().length > 0 &&
      step.instruction.length <= 10000
    )
      return { type: "ai", instruction: step.instruction };
    if (
      step.type === "press_keys" &&
      exact("type", "keys") &&
      Array.isArray(step.keys) &&
      step.keys.length > 0 &&
      step.keys.length <= 10 &&
      step.keys.every(
        (key) => typeof key === "string" && key.length > 0 && key.length <= 40,
      )
    )
      return { type: "press_keys", keys: step.keys as string[] };
    if (
      step.type === "click" &&
      exact("type", "x", "y") &&
      typeof step.x === "number" &&
      Number.isInteger(step.x) &&
      step.x >= 0 &&
      step.x <= 16384 &&
      typeof step.y === "number" &&
      Number.isInteger(step.y) &&
      step.y >= 0 &&
      step.y <= 16384
    )
      return { type: "click", x: step.x, y: step.y };
    throw new Error("Invalid workflow step");
  });
  return { steps };
}
