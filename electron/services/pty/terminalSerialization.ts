import type { IMarker } from "@xterm/headless";
import type { TerminalInfo } from "./types.js";
import type { SerializedTerminalSnapshot } from "../../../shared/types/terminal.js";
import { getTerminalSerializerService } from "./TerminalSerializerService.js";

/**
 * Bundle a serialized payload with the grid that produced it (#11552).
 *
 * Must be called in the same tick as the `addon.serialize()` that produced
 * `data`: a geometry sampled a tick earlier can describe a grid the buffer has
 * already left, and replaying a snapshot at the wrong width commits real
 * newlines into cell data that no later reflow can undo.
 */
function withGeometry(
  data: string | null,
  grid: { cols: number; rows: number }
): SerializedTerminalSnapshot | null {
  if (data === null) return null;
  return { data, cols: grid.cols, rows: grid.rows };
}

export function serializeTerminal(
  id: string,
  terminalInfo: TerminalInfo
): SerializedTerminalSnapshot | null {
  // Preserved exited terminal — the headless xterm is disposed and the final
  // buffer lives as a cached snapshot. Empty data is a valid snapshot. Stamp
  // the access time so eviction (issue #10839) treats it as currently-viewed.
  if (terminalInfo.preservedSnapshot !== undefined) {
    terminalInfo.preservedSnapshotLastAccessedAt = Date.now();
    return terminalInfo.preservedSnapshot;
  }
  // Non-preserved disposed terminal — disposeHeadless() clears the addon and
  // the headless instance together. No snapshot to produce; return null without
  // logging a spurious error.
  const addon = terminalInfo.serializeAddon;
  const headless = terminalInfo.headlessTerminal;
  if (!addon || !headless) return null;
  try {
    return withGeometry(addon.serialize(), headless);
  } catch (error) {
    console.error(`[TerminalProcess] Failed to serialize terminal ${id}:`, error);
    return null;
  }
}

export async function serializeTerminalAsync(
  id: string,
  terminalInfo: TerminalInfo
): Promise<SerializedTerminalSnapshot | null> {
  // Preserved snapshot served — stamp access time so eviction (issue #10839)
  // treats it as currently-viewed.
  if (terminalInfo.preservedSnapshot !== undefined) {
    terminalInfo.preservedSnapshotLastAccessedAt = Date.now();
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
      // The serialize callback runs on a later tick; disposeHeadless() may clear
      // the addon in between. Re-check identity so a disposed terminal yields
      // null instead of throwing (which would re-log a spurious failure). The
      // geometry is read inside this deferred callback so it describes the grid
      // the payload was actually produced from.
      return await serializerService.serializeAsync(id, () =>
        terminalInfo.serializeAddon === addon ? withGeometry(addon.serialize(), headless) : null
      );
    }

    return withGeometry(addon.serialize(), headless);
  } catch (error) {
    console.error(`[TerminalProcess] Failed to serialize terminal ${id}:`, error);
    return null;
  }
}

export function serializeForPersistence(
  terminalInfo: TerminalInfo,
  restoreBannerStart: IMarker | null,
  restoreBannerEnd: IMarker | null
): SerializedTerminalSnapshot | null {
  const addon = terminalInfo.serializeAddon;
  const terminal = terminalInfo.headlessTerminal;
  if (!addon || !terminal) return null;

  const startMarker = restoreBannerStart;
  const endMarker = restoreBannerEnd;

  if (!startMarker || !endMarker || startMarker.line < 0 || endMarker.line < 0) {
    return withGeometry(addon.serialize(), terminal);
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

    if (beforePart && afterPart) return withGeometry(beforePart + "\r\n" + afterPart, terminal);
    return withGeometry(beforePart || afterPart || null, terminal);
  } catch {
    return withGeometry(addon.serialize(), terminal);
  }
}
