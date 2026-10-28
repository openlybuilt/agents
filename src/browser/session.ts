export interface BrowserScreenshot {
  bytes: Uint8Array;
  contentType: string;
}

export interface BrowserSession {
  readonly liveViewUrl?: string;
  screenshot(): Promise<BrowserScreenshot>;
  navigate(url: string): Promise<void>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  pressKeys(keys: string[]): Promise<void>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  open(options?: { signal?: AbortSignal }): Promise<BrowserSession>;
}
