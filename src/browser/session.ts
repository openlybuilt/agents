export interface BrowserScreenshot {
  bytes: Uint8Array;
  contentType: string;
}

export interface BrowserRecording {
  browserId: string;
  replayId: string;
  download(): Promise<Uint8Array<ArrayBuffer>>;
}

export interface BrowserSession {
  readonly liveViewUrl?: string;
  startRecording(): Promise<BrowserRecording>;
  stopRecording(): Promise<void>;
  screenshot(): Promise<BrowserScreenshot>;
  navigate(url: string): Promise<void>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  scrollPage(deltaX: number, deltaY: number): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  open(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<BrowserSession>;
}
