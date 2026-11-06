import { randomUUID } from "node:crypto";
import {
  createDevboxClient,
  type Devbox,
  type DevboxClient,
} from "@namespacelabs/sdk/devbox";
import type {
  ComputerRecording,
  ComputerScreenshot,
  ComputerSession,
} from "./session.js";

// Not registered: keyboard input, streaming recording, and a secure viewer need implementation and live validation.
export class NamespaceSession implements ComputerSession {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly client: DevboxClient,
    private readonly devbox: Devbox,
    private readonly signal?: AbortSignal,
  ) {}

  static async open(
    client: DevboxClient,
    signal?: AbortSignal,
  ): Promise<NamespaceSession> {
    signal?.throwIfAborted();
    // Create stopped first so the returned ID is available when startup is cancelled.
    let devbox: Devbox;
    try {
      devbox = await client.devboxes.create({
        name: `openly-${randomUUID()}`,
        os: "macos",
        access: "private",
        ephemeral: true,
        versionControl: {},
        start: false,
      });
    } catch (error) {
      client.close();
      throw error;
    }
    const session = new NamespaceSession(client, devbox, signal);
    try {
      signal?.throwIfAborted();
      await devbox.start({ signal });
      signal?.throwIfAborted();
      return session;
    } catch (error) {
      try {
        await session.close(AbortSignal.timeout(20000));
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Devbox startup cleanup failed",
        );
      }
      throw error;
    }
  }

  static client(): DevboxClient {
    return createDevboxClient();
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
    return Promise.reject(new Error("Namespace recording is not implemented"));
  }
  stopRecording(): Promise<void> {
    return Promise.reject(new Error("Namespace recording is not implemented"));
  }
  screenshot(): Promise<ComputerScreenshot> {
    return this.run(async () => {
      const shot = await this.devbox.display.screenshot({
        signal: this.signal,
        timeoutMs: 30000,
      });
      return { bytes: shot.png, contentType: "image/png" };
    });
  }
  navigate(url: string): Promise<void> {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Navigation requires an HTTP or HTTPS URL");
    return this.run(async () => {
      const result = await this.devbox.exec(
        ["open", "-a", "Safari", parsed.href],
        { signal: this.signal, timeoutMs: 30000 },
      );
      if (result.exitCode !== 0) throw new Error("Browser navigation failed");
    });
  }
  click(x: number, y: number): Promise<void> {
    if (![x, y].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new RangeError("Invalid coordinate");
    return this.run(() =>
      this.devbox.display.click(x, y, {
        signal: this.signal,
        timeoutMs: 30000,
      }),
    );
  }
  type(): Promise<void> {
    return Promise.reject(
      new Error("Namespace SDK text input is not implemented"),
    );
  }
  pressKeys(): Promise<void> {
    return Promise.reject(
      new Error("Namespace SDK keyboard input is not implemented"),
    );
  }
  scroll(): Promise<void> {
    return Promise.reject(new Error("Namespace scrolling is not implemented"));
  }
  scrollPage(): Promise<void> {
    return Promise.reject(
      new Error("Namespace pixel scrolling is not implemented"),
    );
  }
  close(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(async () => {
      try {
        await this.devbox.delete({ signal });
        this.client.close();
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
