export type PrewarmStep =
  | { type: "goto"; url: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "click"; selector: string }
  | { type: "wait_for"; selector: string; timeout: number };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const text = (value: unknown, max = 2048): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function parsePrewarm(value: unknown): PrewarmStep[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 30)
    throw new Error("Invalid prewarming");
  const steps = value.map((step): PrewarmStep => {
    if (!object(step)) throw new Error("Invalid prewarming step");
    if (
      step.type === "goto" &&
      exact(step, ["type", "url"]) &&
      text(step.url)
    ) {
      const url = new URL(step.url);
      if (url.protocol === "https:" && !url.username && !url.password)
        return { type: "goto", url: url.href };
    }
    if (
      step.type === "fill" &&
      exact(step, ["type", "selector", "value"]) &&
      text(step.selector) &&
      text(step.value, 10000)
    )
      return { type: "fill", selector: step.selector, value: step.value };
    if (
      step.type === "click" &&
      exact(step, ["type", "selector"]) &&
      text(step.selector)
    )
      return { type: "click", selector: step.selector };
    if (
      step.type === "wait_for" &&
      exact(step, ["type", "selector", "timeout"]) &&
      text(step.selector) &&
      Number.isInteger(step.timeout) &&
      (step.timeout as number) >= 1 &&
      (step.timeout as number) <= 30000
    )
      return {
        type: "wait_for",
        selector: step.selector,
        timeout: step.timeout as number,
      };
    throw new Error("Invalid prewarming step");
  });
  if (steps[0]?.type !== "goto" || steps.at(-1)?.type !== "wait_for")
    throw new Error(
      "Prewarming must open a page and verify the signed-in screen",
    );
  return steps;
}
