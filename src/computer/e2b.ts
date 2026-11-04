import { randomUUID } from "node:crypto";
import { Sandbox } from "@e2b/desktop";
import { E2BRecording } from "./e2b-recording.js";
import { RECORDING_RESOURCE_GRACE_MS } from "./recording-timeouts.js";
import type {
  ComputerRecording,
  ComputerScreenshot,
  ComputerSession,
} from "./session.js";

function coordinate(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Invalid coordinate");
}

// Deliberately unregistered: Linux targets, live view, and recording need validation.
export class E2BSession implements ComputerSession {
  private readonly recording: E2BRecording;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly sandbox: Sandbox,
    private readonly signal?: AbortSignal,
  ) {
    this.recording = new E2BRecording(sandbox);
  }

  static async open(
    apiKey: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<E2BSession> {
    if (!apiKey.trim()) throw new Error("An E2B API key is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Invalid session time budget");
    signal?.throwIfAborted();
    // Do not abort creation: retain the sandbox ID so cancellation can clean it up.
    const sandbox = await Sandbox.create({
      apiKey,
      timeoutMs: timeoutMs + RECORDING_RESOURCE_GRACE_MS,
    });
    const session = new E2BSession(sandbox, signal);
    if (signal?.aborted) {
      try {
        await session.close();
      } catch (error) {
        throw new AggregateError(
          [signal.reason, error],
          "Cancelled desktop cleanup failed",
        );
      }
      signal.throwIfAborted();
    }
    return session;
  }

  private run<T>(action: () => Promise<T>, cleanup = false): Promise<T> {
    if (this.closing || this.closed)
      return Promise.reject(new Error("Desktop session is closing or closed"));
    if (!cleanup && this.signal?.aborted)
      return Promise.reject(this.signal.reason);
    const result = this.tail.then(() => {
      if (!cleanup) this.signal?.throwIfAborted();
      return action();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  startRecording(): Promise<ComputerRecording> {
    return this.run(() => this.recording.start());
  }
  stopRecording(signal?: AbortSignal): Promise<void> {
    return this.run(
      () => this.recording.stop(signal ?? AbortSignal.timeout(15000)),
      true,
    );
  }
  screenshot(): Promise<ComputerScreenshot> {
    return this.run(async () => ({
      bytes: await this.sandbox.screenshot(),
      contentType: "image/png",
    }));
  }
  navigate(url: string): Promise<void> {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Navigation requires an HTTP or HTTPS URL");
    return this.run(async () => {
      const command = await this.sandbox.commands.run(
        'xdg-open "$OPENLY_URL"',
        {
          envs: { OPENLY_URL: parsed.href },
          background: true,
          timeoutMs: 0,
          retainOutput: false,
        },
      );
      await command.disconnect();
    });
  }
  click(x: number, y: number): Promise<void> {
    coordinate(x);
    coordinate(y);
    return this.run(async () => {
      await this.sandbox.moveMouse(x, y);
      await this.sandbox.leftClick();
    });
  }
  type(text: string): Promise<void> {
    if (!/^[\x20-\x7e]*$/.test(text))
      throw new Error("E2B text input currently supports printable ASCII only");
    return this.run(async () => {
      const path = `/tmp/openly-input-${randomUUID()}`;
      try {
        await this.sandbox.files.write(path, text);
        await this.sandbox.commands.run(
          'xdotool type --clearmodifiers -- "$(cat "$OPENLY_INPUT_FILE")"',
          {
            envs: { OPENLY_INPUT_FILE: path },
            retainOutput: false,
          },
        );
      } finally {
        await this.sandbox.files.remove(path);
      }
    });
  }
  pressKeys(keys: string[]): Promise<void> {
    if (
      !Array.isArray(keys) ||
      !keys.length ||
      keys.length > 10 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          key.length > 40 ||
          key.split("+").some((part) => !/^[A-Za-z0-9_]+$/.test(part.trim())),
      )
    )
      throw new Error("Invalid key combination");
    return this.run(async () => {
      for (const key of keys)
        await this.sandbox.press(key.split("+").map((part) => part.trim()));
    });
  }
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    coordinate(x);
    coordinate(y);
    if (deltaX !== 0 || !Number.isSafeInteger(deltaY) || Math.abs(deltaY) > 100)
      throw new Error("E2B supports vertical wheel increments only");
    return this.run(async () => {
      await this.sandbox.moveMouse(x, y);
      if (deltaY)
        await this.sandbox.scroll(deltaY < 0 ? "up" : "down", Math.abs(deltaY));
    });
  }
  scrollPage(): Promise<void> {
    return Promise.reject(new Error("E2B pixel scrolling is unavailable"));
  }
  scrollWheel(deltaX: number, deltaY: number): Promise<void> {
    if (deltaX !== 0 || !Number.isSafeInteger(deltaY) || Math.abs(deltaY) > 100)
      throw new Error("E2B supports vertical wheel increments only");
    return this.run(async () => {
      if (deltaY)
        await this.sandbox.scroll(deltaY < 0 ? "up" : "down", Math.abs(deltaY));
    });
  }
  close(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(async () => {
      try {
        await this.sandbox.kill({ signal });
        this.closed = true;
      } catch (error) {
        this.closing = false;
        this.closePromise = undefined;
        throw error;
      }
    });
    return this.closePromise;
  }
}
