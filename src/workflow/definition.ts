import type { ExecutionTarget, ProviderId } from "../computer/session.js";

export type WorkflowStep =
  | { type: "navigate"; url: string }
  | { type: "type"; text: string; target?: string; region?: string }
  | { type: "wait"; seconds: number }
  | ({
      type: "scroll";
      direction: "up" | "down" | "left" | "right";
    } & ({ pixels: number } | { wheelTicks: number }))
  | { type: "press_keys"; keys: string[] }
  | { type: "click"; x: number; y: number }
  | { type: "click"; target: string }
  | { type: "ai"; instruction: string };
export type ResolvedWorkflow = {
  executionTarget: ExecutionTarget;
  provider?: ProviderId;
  steps: WorkflowStep[];
};

export function parseWorkflow(input: unknown): ResolvedWorkflow {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid workflow");
  const value = input as Record<string, unknown>;
  const executionTarget =
    value.executionTarget === undefined ? "browser" : value.executionTarget;
  if (executionTarget !== "browser" && executionTarget !== "windows")
    throw new Error("Invalid execution target");
  const provider = value.provider;
  if (
    provider !== undefined &&
    provider !== "onkernel" &&
    provider !== "daytona"
  )
    throw new Error("Invalid computer provider");
  if (
    provider !== undefined &&
    provider !== (executionTarget === "browser" ? "onkernel" : "daytona")
  )
    throw new Error("Computer provider does not support this execution target");
  if (
    Object.keys(value).some(
      (key) => !["steps", "executionTarget", "provider"].includes(key),
    ) ||
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
      typeof step.text === "string" &&
      step.text.length <= 10000 &&
      (exact("type", "text") ||
        (typeof step.target === "string" &&
          step.target.trim().length > 0 &&
          step.target.length <= 1000 &&
          (exact("type", "text", "target") ||
            (exact("type", "text", "target", "region") &&
              typeof step.region === "string" &&
              step.region.trim().length > 0 &&
              step.region.length <= 200))))
    )
      return {
        type: "type",
        text: step.text,
        ...(typeof step.target === "string" ? { target: step.target } : {}),
        ...(typeof step.region === "string" ? { region: step.region } : {}),
      };
    if (
      step.type === "scroll" &&
      (step.direction === "up" ||
        step.direction === "down" ||
        step.direction === "left" ||
        step.direction === "right")
    ) {
      if (
        executionTarget === "windows" &&
        exact("type", "direction", "wheelTicks") &&
        typeof step.wheelTicks === "number" &&
        Number.isInteger(step.wheelTicks) &&
        step.wheelTicks >= 1 &&
        step.wheelTicks <= 100
      )
        return {
          type: "scroll",
          direction: step.direction,
          wheelTicks: step.wheelTicks,
        };
      if (
        executionTarget === "browser" &&
        exact("type", "direction", "pixels") &&
        typeof step.pixels === "number" &&
        Number.isInteger(step.pixels) &&
        step.pixels >= 1 &&
        step.pixels <= 100000
      )
        return {
          type: "scroll",
          direction: step.direction,
          pixels: step.pixels,
        };
    }
    if (
      step.type === "wait" &&
      exact("type", "seconds") &&
      typeof step.seconds === "number" &&
      Number.isFinite(step.seconds) &&
      step.seconds > 0 &&
      step.seconds <= 600
    )
      return { type: "wait", seconds: step.seconds };
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
      exact("type", "target") &&
      typeof step.target === "string" &&
      step.target.trim().length > 0 &&
      step.target.length <= 10000
    )
      return { type: "click", target: step.target };
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
  return {
    executionTarget,
    ...(provider === undefined ? {} : { provider }),
    steps,
  };
}
