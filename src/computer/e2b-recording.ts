import { randomUUID } from "node:crypto";
import type { CommandHandle, Sandbox } from "@e2b/desktop";
import type { ComputerRecording } from "./session.js";

// This adapter is intentionally not registered until live recording is verified.
export class E2BRecording {
  private readonly id = randomUUID();
  private readonly path = `/tmp/openly-recording-${this.id}.mp4`;
  private process?: CommandHandle<undefined>;
  private completion?: Promise<void>;
  private stopped = false;

  constructor(private readonly sandbox: Sandbox) {}

  async start(): Promise<ComputerRecording> {
    if (this.process) throw new Error("Recording already started");
    const { width, height } = await this.sandbox.getScreenSize();
    if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new Error("Invalid desktop dimensions");
    }
    this.process = await this.sandbox.commands.run(
      'ffmpeg -hide_banner -loglevel error -y -f x11grab -framerate 10 -video_size "$SCREEN_SIZE" -i "$DISPLAY" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$RECORDING_PATH"',
      {
        background: true,
        stdin: true,
        retainOutput: false,
        timeoutMs: 0,
        envs: {
          DISPLAY: this.sandbox.display,
          SCREEN_SIZE: `${width}x${height}`,
          RECORDING_PATH: this.path,
        },
      },
    );
    // Attach a rejection handler immediately while retaining the original result.
    this.completion = this.process.wait().then(() => undefined);
    void this.completion.catch(() => undefined);
    return {
      browserId: this.sandbox.sandboxId,
      replayId: this.id,
      download: (signal) => this.download(signal),
    };
  }

  async stop(signal: AbortSignal): Promise<void> {
    if (!this.process || !this.completion)
      throw new Error("Recording not started");
    if (this.stopped) return;
    signal.throwIfAborted();
    await this.process.sendStdin("q\n", { signal });
    await this.waitForCompletion(signal);
    this.stopped = true;
  }

  private async waitForCompletion(signal: AbortSignal): Promise<void> {
    const completion = this.completion;
    if (!completion) throw new Error("Recording not started");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      completion
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private async download(
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (!this.stopped) throw new Error("Recording has not finished");
    return this.sandbox.files.read(this.path, { format: "stream", signal });
  }
}
