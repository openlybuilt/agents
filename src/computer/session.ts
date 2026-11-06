export type ExecutionTarget = "browser" | "windows";
export type ProviderId = "onkernel" | "daytona";

export class HorizontalScrollUnavailableError extends Error {
  constructor() {
    super("Windows horizontal scrolling is unavailable; use up or down");
  }
}

export class ComputerSessionCleanupError extends Error {
  constructor() {
    super("Computer session cleanup could not be confirmed");
  }
}

export type ComputerOpenOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  executionTarget?: ExecutionTarget;
  provider?: ProviderId;
};

export interface ComputerScreenshot {
  bytes: Uint8Array;
  contentType: string;
}

export class ClickOutsideScreenshotError extends Error {
  constructor() {
    super("Click coordinates are outside the computer screen");
  }
}

export function validateClickCoordinates(
  screenshot: ComputerScreenshot,
  x: number,
  y: number,
): void {
  const bytes = Buffer.from(screenshot.bytes);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Expected a PNG computer screenshot");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error("Invalid screenshot dimensions");
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= width ||
    y >= height
  )
    throw new ClickOutsideScreenshotError();
}

export interface ComputerRecording {
  browserId: string;
  replayId: string;
  download(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export interface ComputerSession {
  readonly liveViewUrl?: string;
  startRecording(): Promise<ComputerRecording>;
  stopRecording(signal?: AbortSignal): Promise<void>;
  screenshot(): Promise<ComputerScreenshot>;
  navigate(url: string): Promise<void>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  scrollPage(deltaX: number, deltaY: number): Promise<void>;
  scrollWheel?(deltaX: number, deltaY: number): Promise<void>;
  close(signal?: AbortSignal): Promise<void>;
}

export interface ComputerProvider {
  open(options?: ComputerOpenOptions): Promise<ComputerSession>;
}
