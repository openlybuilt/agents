import { setTimeout as delay } from "node:timers/promises";
import { DaytonaApi, DaytonaError } from "./daytona-api.js";
import type { ComputerRecording } from "./session.js";

export class DaytonaRecording {
  private id?: string;
  private starting?: Promise<ComputerRecording>;
  private finishing?: Promise<void>;
  private cleanup?: AbortSignal;
  private video?: Uint8Array<ArrayBuffer>;

  constructor(
    private readonly api: DaytonaApi,
    private readonly base: URL,
    private readonly vmId: string,
  ) {}

  get cleanupSignal(): AbortSignal {
    return (this.cleanup ??= AbortSignal.timeout(20000));
  }

  start(signal: AbortSignal): Promise<ComputerRecording> {
    if (this.finishing)
      return Promise.reject(new DaytonaError("Windows recording start"));
    return (this.starting ??= this.begin(signal));
  }

  private async begin(signal: AbortSignal): Promise<ComputerRecording> {
    const recording = await this.api.request(
      this.base,
      "computeruse/recordings/start",
      signal,
      "Windows recording start",
      { label: "virela-" + this.vmId },
    );
    if (
      typeof recording.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(recording.id) ||
      recording.status !== "recording"
    )
      throw new DaytonaError("Windows recording start");
    this.id = recording.id;
    return {
      browserId: this.vmId,
      replayId: this.id,
      download: async () => {
        if (!this.video) throw new DaytonaError("Windows recording export");
        return this.video;
      },
    };
  }

  finish(pending = Promise.resolve()): Promise<void> {
    if (this.finishing) return this.finishing;
    const signal = AbortSignal.any([
      this.cleanupSignal,
      AbortSignal.timeout(10000),
    ]);
    return (this.finishing = (async () => {
      signal.throwIfAborted();
      let abort: () => void = () => undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          abort = () =>
            reject(new DaytonaError("Windows recording finalization"));
          signal.addEventListener("abort", abort, { once: true });
          pending.then(resolve, reject);
        });
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (!this.id) return;
      let recording = await this.api.request(
        this.base,
        "computeruse/recordings/stop",
        signal,
        "Windows recording stop",
        { id: this.id },
        "POST",
        5000,
      );
      while (recording.status !== "completed") {
        if (
          !["recording", "processing", "stopping"].includes(
            String(recording.status),
          )
        )
          throw new DaytonaError("Windows recording completion");
        await delay(100, undefined, { signal });
        recording = await this.api.request(
          this.base,
          "computeruse/recordings/" + encodeURIComponent(this.id),
          signal,
          "Windows recording completion",
        );
      }
      if (
        recording.id !== this.id ||
        (recording.sizeBytes !== undefined &&
          (typeof recording.sizeBytes !== "number" ||
            !Number.isSafeInteger(recording.sizeBytes) ||
            recording.sizeBytes < 1 ||
            recording.sizeBytes > 100 * 1024 * 1024))
      )
        throw new DaytonaError("Windows recording export");
      this.video = await this.api.download(
        this.base,
        "computeruse/recordings/" + encodeURIComponent(this.id) + "/download",
        signal,
      );
    })());
  }
}
