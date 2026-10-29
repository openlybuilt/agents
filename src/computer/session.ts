export type ExecutionTarget = "browser" | "windows";

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
  download(): Promise<Uint8Array<ArrayBuffer>>;
}

export interface ComputerSession {
  readonly liveViewUrl?: string;
  startRecording(): Promise<ComputerRecording>;
  stopRecording(): Promise<void>;
  screenshot(): Promise<ComputerScreenshot>;
  navigate(url: string): Promise<void>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  scrollPage(deltaX: number, deltaY: number): Promise<void>;
  close(): Promise<void>;
}

export interface ComputerProvider {
  open(options?: ComputerOpenOptions): Promise<ComputerSession>;
}
