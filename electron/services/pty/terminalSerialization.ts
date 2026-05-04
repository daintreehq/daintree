import type { IMarker } from "@xterm/headless";
import type { TerminalInfo } from "./types.js";
import { getTerminalSerializerService } from "./TerminalSerializerService.js";

export function serializeTerminal(id: string, terminalInfo: TerminalInfo): string | null {
  try {
    return terminalInfo.serializeAddon!.serialize();
  } catch (error) {
    console.error(`[TerminalProcess] Failed to serialize terminal ${id}:`, error);
    return null;
  }
}

export async function serializeTerminalAsync(
  id: string,
  terminalInfo: TerminalInfo
): Promise<string | null> {
  try {
    const lineCount = terminalInfo.headlessTerminal!.buffer.active.length;
    const serializerService = getTerminalSerializerService();

    if (serializerService.shouldUseAsync(lineCount)) {
      return await serializerService.serializeAsync(id, () =>
        terminalInfo.serializeAddon!.serialize()
      );
    }

    return terminalInfo.serializeAddon!.serialize();
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
    return beforePart || afterPart || addon.serialize();
  } catch {
    return addon.serialize();
  }
}
