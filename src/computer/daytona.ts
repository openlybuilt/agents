import { randomUUID } from "node:crypto";
import { DaytonaRecording } from "./daytona-recording.js";
import {
  DaytonaApi,
  DaytonaError,
  endpoint,
  record,
  liveView,
  screenshot,
} from "./daytona-api.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  ComputerSessionCleanupError,
  HorizontalScrollUnavailableError,
  type ComputerOpenOptions,
  type ComputerProvider,
  type ComputerRecording,
  type ComputerScreenshot,
  type ComputerSession,
} from "./session.js";

class DaytonaSession implements ComputerSession {
  private readonly name = "virela-windows-" + randomUUID();
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private id?: string;
  private toolbox?: URL;
  private view?: { url: string; token: string };
  private ambiguousCreate = false;
  private closing = false;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private width = 0;
  private height = 0;
  private pointer?: { x: number; y: number };
  private recorder?: DaytonaRecording;

  constructor(
    private readonly transport: DaytonaApi,
    private readonly api: URL,
    private readonly timeoutMs: number,
    signal?: AbortSignal,
  ) {
    this.signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
  }
  get liveViewUrl(): string | undefined {
    return this.view?.url;
  }

  private main(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    method?: string,
    timeoutMs?: number,
  ) {
    return this.transport.request(
      this.api,
      path,
      signal,
      "Windows lifecycle",
      body,
      method,
      timeoutMs,
    );
  }
  private native(path: string, body?: unknown, signal = this.signal) {
    if (!this.toolbox) throw new DaytonaError("Windows desktop initialization");
    return this.transport.request(
      this.toolbox,
      "computeruse/" + path,
      signal,
      "Windows desktop operation",
      body,
    );
  }
  private identify(value: Record<string, unknown>): void {
    if (
      value.name !== this.name ||
      record(value.labels).virela_session !== this.name ||
      typeof value.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.id)
    )
      throw new DaytonaError("Windows allocation validation");
    this.id = value.id;
    this.ambiguousCreate = false;
  }
  private get sandboxPath(): string {
    return "sandbox/" + encodeURIComponent(this.id ?? this.name);
  }

  async initialize(): Promise<this> {
    try {
      this.signal.throwIfAborted();
      this.ambiguousCreate = true;
      const created = await this.main(
        "sandbox",
        AbortSignal.timeout(Math.min(30000, this.timeoutMs)),
        {
          name: this.name,
          snapshot: "windows-medium",
          public: false,
          labels: { managed_by: "virela-agents", virela_session: this.name },
          autoStopInterval: 0,
          autoPauseInterval: 0,
          autoDeleteInterval: 0,
          ttlMinutes: Math.ceil((this.timeoutMs + 120000) / 60000),
        },
        "POST",
        30000,
      );
      this.identify(created);
      let current = created;
      while (current.state !== "started") {
        this.signal.throwIfAborted();
        if (
          [
            "error",
            "build_failed",
            "destroyed",
            "destroying",
            "stopped",
            "stopping",
          ].includes(String(current.state))
        )
          throw new DaytonaError("Windows provisioning");
        await delay(250, undefined, { signal: this.signal });
        current = await this.main(this.sandboxPath, this.signal);
      }
      if (current.sandboxClass !== "windows")
        throw new DaytonaError("Windows sandbox class validation");
      const proxy =
        typeof current.toolboxProxyUrl === "string"
          ? current.toolboxProxyUrl
          : (
              await this.main(
                this.sandboxPath + "/toolbox-proxy-url",
                this.signal,
              )
            ).url;
      if (typeof proxy !== "string")
        throw new DaytonaError("Windows toolbox validation");
      this.toolbox = endpoint(proxy);
      if (this.api.protocol === "https:" && this.toolbox.protocol !== "https:")
        throw new DaytonaError("Windows toolbox validation");
      this.toolbox = new URL(encodeURIComponent(this.id!) + "/", this.toolbox);
      this.recorder = new DaytonaRecording(
        this.transport,
        this.toolbox,
        this.id!,
      );
      await this.native("start", {});
      const ready = AbortSignal.any([this.signal, AbortSignal.timeout(30000)]);
      for (;;) {
        ready.throwIfAborted();
        try {
          const status = await this.native("status", undefined, ready);
          if (status.status === "active" || status.status === "ready") {
            await this.capture(ready);
            break;
          }
        } catch (error) {
          if (
            error instanceof DaytonaError &&
            error.status &&
            error.status < 500
          )
            throw error;
        }
        await delay(250, undefined, { signal: ready });
      }
      const preview = await this.main(
        this.sandboxPath +
          "/ports/6080/signed-preview-url?expiresInSeconds=" +
          Math.ceil((this.timeoutMs + 120000) / 1000),
        this.signal,
      );
      this.view = liveView(preview, this.api.protocol === "https:");
      for (;;) {
        ready.throwIfAborted();
        try {
          const response = await fetch(this.view.url, {
            signal: AbortSignal.any([ready, AbortSignal.timeout(5000)]),
            redirect: "error",
          });
          await response.body?.cancel();
          if (response.ok) break;
          if (![502, 503, 504].includes(response.status))
            throw new DaytonaError(
              "Windows live view readiness",
              response.status,
            );
        } catch (error) {
          if (error instanceof DaytonaError) throw error;
        }
        await delay(250, undefined, { signal: ready });
      }
      this.signal.throwIfAborted();
      return this;
    } catch (error) {
      if (
        error instanceof DaytonaError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        this.ambiguousCreate = false;
      try {
        await this.close();
      } catch {
        throw new ComputerSessionCleanupError();
      }
      throw error;
    }
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error("Computer session is closing or closed"));
    const result = this.tail.then(() => {
      this.signal.throwIfAborted();
      if (this.closing)
        throw new Error("Computer session is closing or closed");
      return action();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private point(x: number, y: number): void {
    if (
      ![x, y].every(Number.isInteger) ||
      x < 0 ||
      y < 0 ||
      x >= this.width ||
      y >= this.height
    )
      throw new RangeError("Invalid desktop coordinates");
  }
  private async capture(signal = this.signal): Promise<ComputerScreenshot> {
    const result = await this.native("screenshot", undefined, signal);
    const image = screenshot(result);
    this.width = image.width;
    this.height = image.height;
    return { bytes: image.bytes, contentType: "image/png" };
  }
  screenshot(): Promise<ComputerScreenshot> {
    return this.run(() => this.capture());
  }
  private async input(text: string, signal = this.signal): Promise<void> {
    const characters = Array.from(text.replace(/\r\n?/g, "\n"));
    for (let offset = 0; offset < characters.length; offset += 250)
      await this.native(
        "keyboard/type",
        { text: characters.slice(offset, offset + 250).join(""), delay: 2 },
        signal,
      );
  }
  type(text: string): Promise<void> {
    if (typeof text !== "string" || text.length > 10000)
      throw new RangeError("Invalid text");
    return this.run(() => this.input(text));
  }
  click(x: number, y: number): Promise<void> {
    this.point(x, y);
    return this.run(async () => {
      await this.native("mouse/click", { x, y, button: "left", double: false });
      this.pointer = { x, y };
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
          !key.trim() ||
          key.length > 40 ||
          key.split("+").some((part) => !part.trim()),
      )
    )
      throw new Error("Invalid keys");
    return this.run(async () => {
      for (const entry of keys) {
        const key = entry.trim();
        await this.native(
          key.includes("+") ? "keyboard/hotkey" : "keyboard/key",
          key.includes("+") ? { keys: key } : { key, modifiers: [] },
        );
      }
    });
  }
  navigate(value: string): Promise<void> {
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new Error("Invalid navigation URL");
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Navigation requires an HTTP or HTTPS URL");
    return this.run(async () => {
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(10000)]);
      await this.native("keyboard/hotkey", { keys: "win+r" }, signal);
      await this.waitForRunDialog(true, signal);
      await this.native("keyboard/hotkey", { keys: "ctrl+a" }, signal);
      await this.input(
        'msedge --no-first-run --no-default-browser-check "' + url.href + '"',
        signal,
      );
      await this.native(
        "keyboard/key",
        { key: "enter", modifiers: [] },
        signal,
      );
      await this.waitForRunDialog(false, signal);
    });
  }
  private async waitForRunDialog(visible: boolean, signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      const { windows } = await this.native(
        "display/windows",
        undefined,
        signal,
      );
      if (!Array.isArray(windows)) throw new DaytonaError("Windows navigation");
      const found = windows.some((item) => {
        const window = record(item);
        return (
          typeof window.title === "string" &&
          window.title.replace(/\p{Cf}/gu, "").trim() === "Run" &&
          (!visible || window.isActive === true)
        );
      });
      if (found === visible) return;
      await delay(100, undefined, { signal });
    }
  }
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    return this.run(() => this.wheel(x, y, deltaX, deltaY));
  }
  scrollWheel(deltaX: number, deltaY: number): Promise<void> {
    return this.run(() => {
      const { x, y } = this.pointer ?? {
        x: Math.floor(this.width / 2),
        y: Math.floor(this.height / 2),
      };
      return this.wheel(x, y, deltaX, deltaY);
    });
  }
  private async wheel(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    this.point(x, y);
    if (
      ![deltaX, deltaY].every(
        (value) => Number.isInteger(value) && Math.abs(value) <= 100,
      )
    )
      throw new RangeError("Invalid wheel amount");
    if (deltaX) throw new HorizontalScrollUnavailableError();
    for (const [amount, negative, positive] of [
      [deltaX, "left", "right"],
      [deltaY, "up", "down"],
    ] as const) {
      if (
        amount &&
        (
          await this.native("mouse/scroll", {
            x,
            y,
            direction: amount < 0 ? negative : positive,
            amount: Math.abs(amount),
          })
        ).success !== true
      )
        throw new DaytonaError("Windows scrolling");
    }
    if (deltaX || deltaY) this.pointer = { x, y };
  }
  scrollPage(_deltaX: number, _deltaY: number): Promise<void> {
    return Promise.reject(
      new Error("Windows does not support page scrolling in pixels"),
    );
  }
  startRecording(): Promise<ComputerRecording> {
    return this.run(() => this.recorder!.start(this.signal));
  }
  stopRecording(): Promise<void> {
    const stopped = this.recorder!.finish(this.tail);
    this.tail = stopped.catch(() => undefined);
    return stopped;
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.controller.abort();
    this.closePromise = (async () => {
      const signal = AbortSignal.timeout(20000);
      if (this.recorder)
        await this.recorder.finish(this.tail).catch(() => undefined);
      else await this.tail;
      if (!this.id && this.ambiguousCreate) {
        const until = Date.now() + 10000;
        for (;;) {
          try {
            this.identify(
              await this.main(this.sandboxPath, signal, undefined, "GET", 3000),
            );
            break;
          } catch (error) {
            if (
              !(error instanceof DaytonaError) ||
              error.status !== 404 ||
              Date.now() >= until
            )
              throw new ComputerSessionCleanupError();
          }
          await delay(250, undefined, { signal });
        }
      }
      if (!this.id) {
        this.closed = true;
        return;
      }
      if (this.view) {
        try {
          await this.main(
            this.sandboxPath +
              "/ports/6080/signed-preview-url/" +
              encodeURIComponent(this.view.token) +
              "/expire",
            signal,
            {},
            "POST",
            3000,
          );
        } catch {}
      }
      try {
        await this.main(this.sandboxPath, signal, undefined, "DELETE", 5000);
      } catch (error) {
        if (!(error instanceof DaytonaError) || error.status !== 404)
          throw error;
      }
      for (;;) {
        try {
          await this.main(this.sandboxPath, signal, undefined, "GET", 3000);
        } catch (error) {
          if (error instanceof DaytonaError && error.status === 404) {
            this.closed = true;
            return;
          }
          throw error;
        }
        await delay(250, undefined, { signal });
      }
    })().catch((error) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
}

export class DaytonaProvider implements ComputerProvider {
  private readonly api: URL;
  private readonly transport: DaytonaApi;
  constructor(apiKey: string, apiUrl = "https://app.daytona.io/api") {
    if (!apiKey.trim()) throw new Error("A Daytona API key is required");
    this.api = endpoint(apiUrl);
    this.transport = new DaytonaApi(apiKey);
  }
  open(options: ComputerOpenOptions = {}): Promise<ComputerSession> {
    if (
      options.executionTarget !== undefined &&
      options.executionTarget !== "windows"
    )
      throw new Error("Daytona requires the Windows execution target");
    const timeoutMs = options.timeoutMs ?? 3600000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000)
      throw new RangeError("Invalid computer session time budget");
    options.signal?.throwIfAborted();
    return new DaytonaSession(
      this.transport,
      this.api,
      timeoutMs,
      options.signal,
    ).initialize();
  }
}
