import {
  RECORDING_EXPORT_MS,
  RECORDING_RESOURCE_GRACE_MS,
} from "./recording-timeouts.js";
import Kernel, { NotFoundError } from "@onkernel/sdk";
import { ExecutionTargetUnavailableError } from "./providers.js";
import type {
  ComputerOpenOptions,
  ComputerProvider,
  ComputerRecording,
  ComputerScreenshot,
  ComputerSession,
} from "./session.js";

function coordinate(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("Coordinates must be non-negative integers");
  }
}

class OnKernelSession implements ComputerSession {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private replayId?: string;
  private replayStopped = false;

  constructor(
    private readonly client: Kernel,
    private readonly id: string,
    readonly liveViewUrl?: string,
    private readonly recordingSeconds = 600,
    private readonly signal?: AbortSignal,
  ) {}

  startRecording(): Promise<ComputerRecording> {
    return this.run(async () => {
      const replay = await this.client.browsers.replays.start(
        this.id,
        {
          record_audio: false,
          framerate: 10,
          max_duration_in_seconds: this.recordingSeconds,
        },
        {
          signal: AbortSignal.any([
            AbortSignal.timeout(15000),
            ...(this.signal ? [this.signal] : []),
          ]),
        },
      );
      this.replayId = replay.replay_id;
      return {
        browserId: this.id,
        replayId: replay.replay_id,
        download: (signal) => this.downloadRecording(signal),
      };
    });
  }

  stopRecording(signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      if (!this.replayId) throw new Error("Recording was not started");
      if (this.replayStopped) return;
      await this.client.browsers.replays.stop(
        this.replayId,
        { id: this.id },
        {
          signal: AbortSignal.any([
            AbortSignal.timeout(signal ? RECORDING_EXPORT_MS : 15000),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      this.replayStopped = true;
    }, true);
  }

  private async downloadRecording(
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!this.replayId || !this.replayStopped)
      throw new Error("Recording has not finished");
    const response = await this.client.browsers.replays.download(
      this.replayId,
      { id: this.id },
      { signal, headers: { "accept-encoding": "identity" } },
    );
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error("Recording download failed");
    }
    return response.body;
  }

  private run<T>(action: () => Promise<T>, cleanup = false): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error("Browser session is closing or closed"));
    }
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

  screenshot(): Promise<ComputerScreenshot> {
    return this.run(async () => {
      const response = await this.client.browsers.computer.captureScreenshot(
        this.id,
        {},
        { signal: this.signal },
      );
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
      };
    });
  }

  navigate(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Navigation requires an HTTP or HTTPS URL");
    }
    return this.run(async () => {
      const result = await this.client.browsers.playwright.execute(
        this.id,
        {
          code: `await page.goto(${JSON.stringify(parsed.href)}, { waitUntil: "domcontentloaded", timeout: 30000 });`,
          timeout_sec: 35,
        },
        { signal: this.signal },
      );
      if (!result.success) throw new Error("Browser navigation failed");
    });
  }

  click(x: number, y: number): Promise<void> {
    coordinate(x);
    coordinate(y);
    return this.run(() =>
      this.client.browsers.computer.clickMouse(
        this.id,
        { x, y },
        { signal: this.signal },
      ),
    );
  }

  type(text: string): Promise<void> {
    return this.run(() =>
      this.client.browsers.computer.typeText(
        this.id,
        { text },
        { signal: this.signal },
      ),
    );
  }

  pressKeys(keys: string[]): Promise<void> {
    if (keys.length === 0 || keys.some((key) => !key)) {
      throw new Error("At least one non-empty key is required");
    }
    return this.run(() =>
      this.client.browsers.computer.pressKey(
        this.id,
        { keys },
        { signal: this.signal },
      ),
    );
  }

  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    coordinate(x);
    coordinate(y);
    if (!Number.isInteger(deltaX) || !Number.isInteger(deltaY)) {
      throw new RangeError("Scroll amounts must be integers");
    }
    return this.run(() =>
      this.client.browsers.computer.scroll(
        this.id,
        { x, y, delta_x: deltaX, delta_y: deltaY },
        { signal: this.signal },
      ),
    );
  }

  scrollPage(deltaX: number, deltaY: number): Promise<void> {
    if (
      ![deltaX, deltaY].every(
        (amount) => Number.isInteger(amount) && Math.abs(amount) <= 100000,
      )
    )
      throw new RangeError("Invalid page scroll amount");
    return this.run(async () => {
      const result = await this.client.browsers.playwright.execute(
        this.id,
        {
          code: `await page.evaluate(() => window.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" }));`,
          timeout_sec: 10,
        },
        { signal: this.signal },
      );
      if (!result.success) throw new Error("Page scroll failed");
    });
  }

  close(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(async () => {
      try {
        await this.client.browsers.deleteByID(this.id, {
          signal: AbortSignal.any([
            AbortSignal.timeout(15000),
            ...(signal ? [signal] : []),
          ]),
        });
        this.closed = true;
      } catch (error) {
        if (error instanceof NotFoundError) {
          this.closed = true;
          return;
        }
        this.closing = false;
        this.closePromise = undefined;
        throw error;
      }
    });
    return this.closePromise;
  }
}

export class OnKernelProvider implements ComputerProvider {
  private readonly client: Kernel;

  constructor(apiKey: string) {
    if (!apiKey.trim()) throw new Error("An OnKernel API key is required");
    this.client = new Kernel({ apiKey, maxRetries: 0 });
  }

  async open(options: ComputerOpenOptions = {}): Promise<ComputerSession> {
    options.signal?.throwIfAborted();
    if (options.executionTarget && options.executionTarget !== "browser")
      throw new ExecutionTargetUnavailableError(options.executionTarget);
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw new RangeError("Invalid browser session time budget");
    // Do not abort an in-flight create: its eventual ID is needed for cleanup.
    const browser = await this.client.browsers.create({
      headless: false,
      timeout_seconds: Math.ceil(
        ((options.timeoutMs ?? 600000) + RECORDING_RESOURCE_GRACE_MS) / 1000,
      ),
    });
    const session = new OnKernelSession(
      this.client,
      browser.session_id,
      browser.browser_live_view_url,
      Math.ceil((options.timeoutMs ?? 600000) / 1000) + 60,
      options.signal,
    );
    if (options.signal?.aborted) {
      try {
        await session.close();
      } catch (error) {
        throw new AggregateError(
          [options.signal.reason, error],
          "Cancelled browser cleanup failed",
        );
      }
      options.signal.throwIfAborted();
    }
    return session;
  }
}
