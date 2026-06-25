import type { IMarker } from "@xterm/headless";
import type { TerminalInfo } from "./types.js";
import { getTerminalSerializerService } from "./TerminalSerializerService.js";

export function serializeTerminal(id: string, terminalInfo: TerminalInfo): string | null {
  // Preserved exited terminal — the headless xterm is disposed and the final
  // buffer lives as a cached string. Empty string is a valid snapshot.
  if (terminalInfo.preservedSnapshot !== undefined) {
    return terminalInfo.preservedSnapshot;
  }
  // Non-preserved disposed terminal — disposeHeadless() clears the addon. No
  // snapshot to produce; return null without logging a spurious error.
  const addon = terminalInfo.serializeAddon;
  if (!addon) return null;
  try {
    return addon.serialize();
  } catch (error) {
    console.error(`[TerminalProcess] Failed to serialize terminal ${id}:`, error);
    return null;
  }
}

export async function serializeTerminalAsync(
  id: string,
  terminalInfo: TerminalInfo
): Promise<string | null> {
  if (terminalInfo.preservedSnapshot !== undefined) {
    return terminalInfo.preservedSnapshot;
  }
  // Non-preserved disposed terminal — disposeHeadless() clears both fields
  // together. No snapshot to produce; return null without logging a spurious
  // error. Snap to locals so the guard and every dereference stay consistent.
  const headless = terminalInfo.headlessTerminal;
  const addon = terminalInfo.serializeAddon;
  if (!headless || !addon) return null;
  try {
    const lineCount = headless.buffer.active.length;
    const serializerService = getTerminalSerializerService();

    if (serializerService.shouldUseAsync(lineCount)) {
      return await serializerService.serializeAsync(id, () => addon.serialize());
    }

    return addon.serialize();
  } catch (error) {
    console.error(`[TerminalProcess] Failed to serialize terminal ${id}:`, error);
    return null;
  }
}

export function serializeForPersistence(
  terminalInfo: TerminalInfo,
  restoreBannerStart: IMarker | null,
  restoreBannerEnd: IMarker | null
): string | null {
  const addon = terminalInfo.serializeAddon;
  const terminal = terminalInfo.headlessTerminal;
  if (!addon || !terminal) return null;

  const startMarker = restoreBannerStart;
  const endMarker = restoreBannerEnd;

  if (!startMarker || !endMarker || startMarker.line < 0 || endMarker.line < 0) {
    return addon.serialize();
  }

  try {
    const bufLen = terminal.buffer.active.length;
    const bannerStart = startMarker.line;
    const bannerEnd = endMarker.line;

    const beforePart =
      bannerStart > 0 ? addon.serialize({ range: { start: 0, end: bannerStart - 1 } }) : "";
    const afterPart =
      bannerEnd < bufLen - 1
        ? addon.serialize({ range: { start: bannerEnd, end: bufLen - 1 } })
        : "";

    if (beforePart && afterPart) return beforePart + "\r\n" + afterPart;
    return beforePart || afterPart || null;
  } catch {
    return addon.serialize();
  }
}
