import { randomUUID } from "node:crypto";
import { Sandbox } from "@superserve/sdk";
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

// Not registered: recording, safe live view, and real sandbox behavior remain unverified.
export class SuperserveSession implements ComputerSession {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly sandbox: Sandbox,
    private readonly signal?: AbortSignal,
  ) {}

  static async open(
    apiKey: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SuperserveSession> {
    if (!apiKey.trim()) throw new Error("A Superserve API key is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new RangeError("Invalid session time budget");
    signal?.throwIfAborted();
    // Retain the ID even if cancellation arrives during creation, so it can be deleted.
    const sandbox = await Sandbox.create({
      apiKey,
      name: `openly-${randomUUID()}`,
      fromTemplate: "superserve/desktop",
      previewAccess: "private",
      timeoutSeconds: Math.ceil(
        (timeoutMs + RECORDING_RESOURCE_GRACE_MS) / 1000,
      ),
      autoDeleteSeconds: 0,
    });
    const session = new SuperserveSession(sandbox, signal);
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

  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed)
      return Promise.reject(new Error("Desktop session is closing or closed"));
    if (this.signal?.aborted) return Promise.reject(this.signal.reason);
    const result = this.tail.then(() => {
      this.signal?.throwIfAborted();
      return action();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  startRecording(): Promise<ComputerRecording> {
    return Promise.reject(new Error("Superserve recording is not implemented"));
  }
  stopRecording(): Promise<void> {
    return Promise.reject(new Error("Superserve recording is not implemented"));
  }
  screenshot(): Promise<ComputerScreenshot> {
    return this.run(async () => {
      const screenshot = await this.sandbox.desktop.screenshot({
        format: "png",
      });
      return { bytes: screenshot.data, contentType: "image/png" };
    });
  }
  navigate(): Promise<void> {
    return Promise.reject(
      new Error("Superserve browser navigation is not implemented"),
    );
  }
  click(x: number, y: number): Promise<void> {
    coordinate(x);
    coordinate(y);
    return this.run(() => this.sandbox.desktop.click(x, y));
  }
  type(text: string): Promise<void> {
    return this.run(() => this.sandbox.desktop.write(text));
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
          key.split("+").some((part) => !part.trim()),
      )
    )
      throw new Error("Invalid key combination");
    return this.run(async () => {
      for (const key of keys) await this.sandbox.desktop.press(key.trim());
    });
  }
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    coordinate(x);
    coordinate(y);
    if (![deltaX, deltaY].every(Number.isSafeInteger))
      throw new RangeError("Invalid scroll amount");
    return this.run(async () => {
      await this.sandbox.desktop.moveMouse(x, y);
      await this.sandbox.desktop.scroll({ dx: deltaX, dy: deltaY });
    });
  }
  scrollPage(): Promise<void> {
    return Promise.reject(
      new Error("Superserve pixel scrolling is not verified"),
    );
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
