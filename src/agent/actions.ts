import type { BrowserSession } from "../browser/session.js";

export type ComputerAction =
  | { name: "navigate"; url: string }
  | { name: "click"; x: number; y: number }
  | { name: "type"; text: string }
  | { name: "press_keys"; keys: string[] }
  | { name: "scroll"; x: number; y: number; deltaX: number; deltaY: number };

export function parseAction(name: string, raw: unknown): ComputerAction {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid action arguments");
  const args = raw as Record<string, unknown>;
  const exact = (...keys: string[]) => {
    if (
      Object.keys(args).length !== keys.length ||
      keys.some((key) => !(key in args))
    ) {
      throw new Error("Invalid action fields");
    }
  };
  const integer = (key: string, min: number, max: number): number => {
    const value = args[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      throw new Error(`Invalid ${key}`);
    }
    return value;
  };
  switch (name) {
    case "navigate": {
      exact("url");
      if (typeof args.url !== "string" || args.url.length > 2048)
        throw new Error("Invalid URL");
      const url = new URL(args.url);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Invalid URL protocol");
      return { name, url: url.href };
    }
    case "click":
      exact("x", "y");
      return { name, x: integer("x", 0, 16384), y: integer("y", 0, 16384) };
    case "type":
      exact("text");
      if (typeof args.text !== "string" || args.text.length > 10000)
        throw new Error("Invalid text");
      return { name, text: args.text };
    case "press_keys":
      exact("keys");
      if (
        !Array.isArray(args.keys) ||
        args.keys.length < 1 ||
        args.keys.length > 10 ||
        args.keys.some(
          (key) => typeof key !== "string" || key.length < 1 || key.length > 40,
        )
      )
        throw new Error("Invalid keys");
      return { name, keys: args.keys as string[] };
    case "scroll":
      exact("x", "y", "deltaX", "deltaY");
      return {
        name,
        x: integer("x", 0, 16384),
        y: integer("y", 0, 16384),
        deltaX: integer("deltaX", -100, 100),
        deltaY: integer("deltaY", -100, 100),
      };
    default:
      throw new Error("Unsupported action");
  }
}

export async function executeAction(
  session: BrowserSession,
  action: ComputerAction,
): Promise<void> {
  switch (action.name) {
    case "navigate":
      return session.navigate(action.url);
    case "click":
      return session.click(action.x, action.y);
    case "type":
      return session.type(action.text);
    case "press_keys":
      return session.pressKeys(action.keys);
    case "scroll":
      return session.scroll(action.x, action.y, action.deltaX, action.deltaY);
  }
}
