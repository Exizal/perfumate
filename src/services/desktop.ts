/** Functions the desktop (Electron) build exposes through its preload script. Absent in a browser. */
export interface DesktopBridge {
  version: string;
  pickFolder(): Promise<string | null>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  joinPath(...parts: string[]): string;
}

export function desktop(): DesktopBridge | null {
  return (globalThis as { desktop?: DesktopBridge }).desktop ?? null;
}
