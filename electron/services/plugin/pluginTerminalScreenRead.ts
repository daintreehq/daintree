import { panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import {
  PLUGIN_TERMINAL_SCREEN_MAX_BYTES,
  PLUGIN_TERMINAL_SCREEN_RATE_PER_SECOND,
} from "../../../shared/config/pluginBudgets.js";
import { tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import type { PluginTerminalScreenResult } from "../../../shared/types/plugin.js";
import { isAssistantTerminalRecord } from "../assistantTerminal.js";
import type { PtyClient } from "../PtyClient.js";

type ScreenReadPtyClient = Pick<
  PtyClient,
  "getTerminalProjectId" | "getTerminalAsync" | "getSerializedStateAsync"
>;

/**
 * Read one terminal's current screen as plain text for `host.terminals.readScreen`.
 *
 * `scopeProjectId` is the host's binding: a bound host reads only its own
 * project's terminals, an unbound one (`null`) any user terminal. Every id the
 * caller may not read — unknown, foreign, assistant, non-PTY — answers the same
 * `not-found`, so a project plugin cannot probe another project's ids.
 *
 * The read is screen-only (`tailRows: 0`) and never falls back to a whole-buffer
 * serialize, so a grid of cards polling every second costs one screen's worth of
 * serializing per card regardless of scrollback. The text is never logged.
 */
export async function readPluginTerminalScreen(
  ptyClient: ScreenReadPtyClient | null,
  terminalId: string,
  scopeProjectId: string | null,
  lines: number
): Promise<PluginTerminalScreenResult> {
  if (!ptyClient) return { status: "unavailable" };
  // A tracked owner that is some other project settles it with no RPC at all.
  const trackedOwner = ptyClient.getTerminalProjectId(terminalId);
  if (scopeProjectId !== null && trackedOwner !== null && trackedOwner !== scopeProjectId) {
    return { status: "not-found" };
  }
  // Re-resolved every call: terminal ids are reused across respawns, so an
  // earlier answer says nothing about what holds the id now.
  const record = await ptyClient.getTerminalAsync(terminalId);
  if (!record) {
    // `getTerminalAsync` folds an RPC failure into `null`. A terminal this
    // client still tracks did not vanish — the host just did not answer.
    return trackedOwner !== null ? { status: "unavailable" } : { status: "not-found" };
  }
  if (!isReadable(record, scopeProjectId)) return { status: "not-found" };
  // `isExited`, not `!hasPty`: the latter also covers a kill still waiting on
  // its exit, which is not yet an exited terminal.
  if (record.isExited === true) return { status: "exited" };

  const snapshot = await ptyClient.getSerializedStateAsync(terminalId, { tailRows: 0 });
  // Check the id again after the read: the two RPCs resolve it separately, so
  // a respawn in between could hand back a different terminal's screen, and an
  // exit in between serves the preserved whole buffer rather than the screen.
  const after = await ptyClient.getTerminalAsync(terminalId);
  if (!after) return { status: "unavailable" };
  if (!isReadable(after, scopeProjectId) || after.spawnedAt !== record.spawnedAt) {
    return { status: "not-found" };
  }
  if (after.isExited === true) return { status: "exited" };
  if (!snapshot) return { status: "unavailable" };
  const tail = tailCapturedOutput(activeScreenData(snapshot.data), lines, true);
  const clipped = clipToUtf8Bytes(tail.content, PLUGIN_TERMINAL_SCREEN_MAX_BYTES);
  return {
    status: "ok",
    text: clipped.text,
    lineCount: clipped.text.length === 0 ? 0 : clipped.text.split("\n").length,
    truncated: tail.truncated || clipped.clipped,
  };
}

type ScreenReadRecord = NonNullable<Awaited<ReturnType<PtyClient["getTerminalAsync"]>>>;

function isReadable(record: ScreenReadRecord, scopeProjectId: string | null): boolean {
  if (scopeProjectId !== null && record.projectId !== scopeProjectId) return false;
  // A record with no `kind` is a plain terminal from an older pty-host entry.
  if (record.kind !== undefined && !panelKindHasPty(record.kind)) return false;
  return !isAssistantTerminalRecord(record);
}

const ALT_SCREEN_ENTER = "\x1b[?1049h";

/**
 * The serializer writes the normal screen first and, while a TUI holds the
 * alternate screen, its own switch into it followed by that screen. Only what
 * follows the switch is on screen; the normal rows beneath are not. Cell
 * content is re-encoded rather than replayed, so the switch is always the
 * serializer's own.
 */
export function activeScreenData(serialized: string): string {
  const index = serialized.lastIndexOf(ALT_SCREEN_ENTER);
  return index === -1 ? serialized : serialized.slice(index + ALT_SCREEN_ENTER.length);
}

/**
 * Keep the newest content of `text` within `maxBytes` of UTF-8: whole lines are
 * dropped from the top first, and a single line still too long keeps its end.
 * Clips on code-point boundaries so no character is split.
 */
export function clipToUtf8Bytes(
  text: string,
  maxBytes: number
): { text: string; clipped: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, clipped: false };
  const lines = text.split("\n");
  let bytes = 0;
  let start = lines.length;
  while (start > 0) {
    const cost = Buffer.byteLength(lines[start - 1]!, "utf8") + (start < lines.length ? 1 : 0);
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    start--;
  }
  if (start < lines.length) return { text: lines.slice(start).join("\n"), clipped: true };
  const chars = Array.from(lines[lines.length - 1]!);
  let kept = 0;
  let index = chars.length;
  while (index > 0) {
    const cost = Buffer.byteLength(chars[index - 1]!, "utf8");
    if (kept + cost > maxBytes) break;
    kept += cost;
    index--;
  }
  return { text: chars.slice(index).join(""), clipped: true };
}

/**
 * Per-plugin-instance admission for `host.terminals.readScreen`, keyed on the
 * loaded plugin's record: a reload installs a new record and so a fresh window,
 * and an unloaded record is collected with its history. Fails fast — a rejected
 * call accrues no debt and queues nothing.
 */
const screenReadWindows = new WeakMap<object, number[]>();

export function admitPluginTerminalScreenRead(
  instance: object,
  now: number,
  limit: number = PLUGIN_TERMINAL_SCREEN_RATE_PER_SECOND
): boolean {
  let stamps = screenReadWindows.get(instance);
  if (!stamps) {
    stamps = [];
    screenReadWindows.set(instance, stamps);
  }
  const cutoff = now - 1000;
  let expired = 0;
  while (expired < stamps.length && stamps[expired]! <= cutoff) expired++;
  if (expired > 0) stamps.splice(0, expired);
  if (stamps.length >= limit) return false;
  stamps.push(now);
  return true;
}
