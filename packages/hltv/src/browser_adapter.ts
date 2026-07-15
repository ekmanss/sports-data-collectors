export interface HltvResponseAdapter {
  status(): number;
}

export interface HltvLocatorAdapter {
  filter(options: { hasText: string }): HltvLocatorAdapter;
  count(): Promise<number>;
  click(): Promise<void>;
}

export interface HltvPageAdapter {
  addInitScript(script: string): Promise<void>;
  close(): Promise<void>;
  evaluate<T>(pageFunction: string | (() => T | Promise<T>)): Promise<T>;
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded'; timeout: number },
  ): Promise<HltvResponseAdapter | null>;
  isClosed(): boolean;
  locator(selector: string): HltvLocatorAdapter;
  url(): string;
  waitForTimeout(milliseconds: number): Promise<void>;
}

export interface HltvBrowserAdapter {
  newPage(): Promise<HltvPageAdapter>;
  close(): Promise<void>;
}
