import Kernel, { NotFoundError } from "@onkernel/sdk";
import type {
  BrowserProvider,
  BrowserScreenshot,
  BrowserSession,
} from "./session.js";

function coordinate(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("Coordinates must be non-negative integers");
  }
}

class OnKernelSession implements BrowserSession {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private replayId?: string;

  constructor(
    private readonly client: Kernel,
    private readonly id: string,
    readonly liveViewUrl?: string,
  ) {}

  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed) {
      return Promise.reject(new Error("Browser session is closing or closed"));
    }
    const result = this.tail.then(action);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  startRecording(): Promise<void> {
    return this.run(async () => {
      const replay = await this.client.browsers.replays.start(this.id, {
        record_audio: false,
      });
      this.replayId = replay.replay_id;
    });
  }

  finishRecording(): Promise<Uint8Array> {
    return this.run(async () => {
      if (!this.replayId) throw new Error("Recording was not started");
      await this.client.browsers.replays.stop(this.replayId, { id: this.id });
      const response = await this.client.browsers.replays.download(
        this.replayId,
        { id: this.id },
      );
      const limit = 100 * 1024 * 1024;
      if (!response.ok || !response.body)
        throw new Error("Recording download failed");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw new Error("Recording exceeds size limit");
        }
        chunks.push(value);
      }
      if (!size) throw new Error("Recording is empty");
      return Buffer.concat(chunks);
    });
  }

  screenshot(): Promise<BrowserScreenshot> {
    return this.run(async () => {
      const response = await this.client.browsers.computer.captureScreenshot(
        this.id,
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
      const result = await this.client.browsers.playwright.execute(this.id, {
        code: `await page.goto(${JSON.stringify(parsed.href)}, { waitUntil: "domcontentloaded", timeout: 30000 });`,
        timeout_sec: 35,
      });
      if (!result.success) throw new Error("Browser navigation failed");
    });
  }

  click(x: number, y: number): Promise<void> {
    coordinate(x);
    coordinate(y);
    return this.run(() =>
      this.client.browsers.computer.clickMouse(this.id, { x, y }),
    );
  }

  type(text: string): Promise<void> {
    return this.run(() =>
      this.client.browsers.computer.typeText(this.id, { text }),
    );
  }

  pressKeys(keys: string[]): Promise<void> {
    if (keys.length === 0 || keys.some((key) => !key)) {
      throw new Error("At least one non-empty key is required");
    }
    return this.run(() =>
      this.client.browsers.computer.pressKey(this.id, { keys }),
    );
  }

  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    coordinate(x);
    coordinate(y);
    if (!Number.isInteger(deltaX) || !Number.isInteger(deltaY)) {
      throw new RangeError("Scroll amounts must be integers");
    }
    return this.run(() =>
      this.client.browsers.computer.scroll(this.id, {
        x,
        y,
        delta_x: deltaX,
        delta_y: deltaY,
      }),
    );
  }

  scrollPage(deltaX: number, deltaY: number): Promise<void> {
    if (
      ![deltaX, deltaY].every(
        (n) => Number.isInteger(n) && Math.abs(n) <= 100000,
      )
    )
      throw new RangeError("Invalid page scroll amount");
    return this.run(async () => {
      const result = await this.client.browsers.playwright.execute(this.id, {
        code: `await page.evaluate(() => window.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" }));`,
        timeout_sec: 10,
      });
      if (!result.success) throw new Error("Page scroll failed");
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(async () => {
      try {
        await this.client.browsers.deleteByID(this.id);
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

export class OnKernelProvider implements BrowserProvider {
  private readonly client: Kernel;

  constructor(apiKey: string) {
    if (!apiKey.trim()) throw new Error("An OnKernel API key is required");
    this.client = new Kernel({ apiKey, maxRetries: 0 });
  }

  async open(options: { signal?: AbortSignal } = {}): Promise<BrowserSession> {
    options.signal?.throwIfAborted();
    // Do not abort an in-flight create: its eventual ID is needed for cleanup.
    const browser = await this.client.browsers.create({
      headless: false,
      timeout_seconds: 60,
    });
    const session = new OnKernelSession(
      this.client,
      browser.session_id,
      browser.browser_live_view_url,
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
