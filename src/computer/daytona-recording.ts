import {
  COMPUTER_CLEANUP_MS,
  RECORDING_EXPORT_MS,
} from "./recording-timeouts.js";
import { setTimeout as delay } from "node:timers/promises";
import { DaytonaApi, DaytonaError } from "./daytona-api.js";
import type { ComputerRecording } from "./session.js";

export class DaytonaRecording {
  private id?: string;
  private starting?: Promise<ComputerRecording>;
  private finishing?: Promise<void>;
  private cleanup?: AbortSignal;
  private exporting?: AbortSignal;
  private size?: number;
  private stopped = false;

  constructor(
    private readonly api: DaytonaApi,
    private readonly base: URL,
    private readonly vmId: string,
  ) {}

  get cleanupSignal(): AbortSignal {
    return (this.cleanup ??= AbortSignal.timeout(
      RECORDING_EXPORT_MS + COMPUTER_CLEANUP_MS,
    ));
  }

  private get exportSignal(): AbortSignal {
    return (this.exporting ??= AbortSignal.any([
      this.cleanupSignal,
      AbortSignal.timeout(RECORDING_EXPORT_MS),
    ]));
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
      download: async (signal) => {
        if (!this.stopped) throw new DaytonaError("Windows recording export");
        return this.api.download(
          this.base,
          "computeruse/recordings/" +
            encodeURIComponent(this.id!) +
            "/download",
          AbortSignal.any([this.exportSignal, signal]),
          this.size,
        );
      },
    };
  }

  finish(pending = Promise.resolve(), signal?: AbortSignal): Promise<void> {
    if (this.finishing) return this.finishing;
    const deadline = AbortSignal.any([
      this.exportSignal,
      ...(signal ? [signal] : []),
    ]);
    return (this.finishing = (async () => {
      deadline.throwIfAborted();
      let abort: () => void = () => undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          abort = () =>
            reject(new DaytonaError("Windows recording finalization"));
          deadline.addEventListener("abort", abort, { once: true });
          pending.then(resolve, reject);
        });
      } finally {
        deadline.removeEventListener("abort", abort);
      }
      if (!this.id) return;
      let recording = await this.api.request(
        this.base,
        "computeruse/recordings/stop",
        deadline,
        "Windows recording stop",
        { id: this.id },
        "POST",
        RECORDING_EXPORT_MS,
      );
      while (recording.status !== "completed") {
        if (
          !["recording", "processing", "stopping"].includes(
            String(recording.status),
          )
        )
          throw new DaytonaError("Windows recording completion");
        await delay(100, undefined, { signal: deadline });
        recording = await this.api.request(
          this.base,
          "computeruse/recordings/" + encodeURIComponent(this.id),
          deadline,
          "Windows recording completion",
          undefined,
          "GET",
          RECORDING_EXPORT_MS,
        );
      }
      if (
        recording.id !== this.id ||
        (recording.sizeBytes !== undefined &&
          (typeof recording.sizeBytes !== "number" ||
            !Number.isSafeInteger(recording.sizeBytes) ||
            recording.sizeBytes < 16))
      )
        throw new DaytonaError("Windows recording export");
      this.size = recording.sizeBytes as number | undefined;
      this.stopped = true;
    })());
  }
}
