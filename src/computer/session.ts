export type ExecutionTarget = "browser" | "windows";

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
};

export interface ComputerScreenshot {
  bytes: Uint8Array;
  contentType: string;
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
