import type { ExecutionTarget, ProviderId } from "./session.js";

export const providerIds = ["onkernel", "daytona"] as const;
export const executionTargets = ["browser", "windows"] as const;

const supportedTargets: Record<ProviderId, readonly ExecutionTarget[]> = {
  onkernel: ["browser"],
  daytona: ["windows"],
};
const defaults: Record<ExecutionTarget, ProviderId> = {
  browser: "onkernel",
  windows: "daytona",
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerIds.some((id) => id === value);
}
export function supportsTarget(
  id: ProviderId,
  target: ExecutionTarget,
): boolean {
  return supportedTargets[id].includes(target);
}
export function defaultProvider(target: ExecutionTarget): ProviderId {
  return defaults[target];
}
