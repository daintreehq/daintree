import type { IBuffer } from "@xterm/xterm";

/** Stands above a first line whose start the read couldn't reach. */
export const CLIPPED_LINE_MARKER = "[Earlier terminal output truncated]";

/**
 * The last `maxLines` lines a terminal printed, with xterm's own wraps joined
 * the way its selection joins them, so a path, URL or command reads as one
 * line whatever the pane's width. Line breaks the program wrote stay; blank
 * rows below the output don't count toward `maxLines`. Only the last
 * `maxRows` rows are read, those blank rows included, so neither one enormous
 * line nor a run of empty ones walks the whole scrollback; a line whose start
 * lies past that, or was trimmed off the scrollback, keeps its tail under
 * `CLIPPED_LINE_MARKER`.
 */
export function readTerminalTail(
  buffer: Pick<IBuffer, "length" | "getLine">,
  maxLines: number,
  maxRows: number
): string {
  const rowText = (y: number) => buffer.getLine(y)?.translateToString(true) ?? "";
  const isContinuation = (y: number) => buffer.getLine(y)?.isWrapped === true;

  const floor = Math.max(0, buffer.length - maxRows);
  let end = buffer.length;
  while (end > floor && rowText(end - 1).trim() === "") end--;

  const lines: string[] = [];
  let clipped = false;
  let y = end - 1;
  while (y >= floor && lines.length < maxLines) {
    let head = y;
    while (head > floor && isContinuation(head)) head--;
    if (isContinuation(head)) clipped = true;
    let text = "";
    for (let row = head; row <= y; row++) text += rowText(row);
    lines.push(text);
    y = head - 1;
  }

  const content = lines.reverse().join("\n").trimEnd();
  if (!content || !clipped) return content;
  return `${CLIPPED_LINE_MARKER}\n${content}`;
}
