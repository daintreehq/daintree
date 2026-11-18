import { useEffect, useEffectEvent } from "react";

/**
 * The diff viewer's keyboard commands travel from their actions to the one
 * diff viewer they address as a window event, so the action catalog never
 * imports the viewer (or the lazy diff renderer behind it) to reach its state.
 */
export const DIFF_COMMAND_EVENT = "daintree:diff-command";

export type DiffCommand =
  "nextChange" | "previousChange" | "nextFile" | "previousFile" | "toggleViewed";

export interface DiffCommandDetail {
  /** The diff panel the command is for; every other one ignores it. */
  id: string;
  command: DiffCommand;
  /** Pressed as a key, so the focused control it was pressed on can say what it means. */
  fromKeyboard?: boolean;
}

const COMMANDS: ReadonlySet<string> = new Set<DiffCommand>([
  "nextChange",
  "previousChange",
  "nextFile",
  "previousFile",
  "toggleViewed",
]);

function isDiffCommandDetail(detail: unknown): detail is DiffCommandDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    "id" in detail &&
    typeof detail.id === "string" &&
    "command" in detail &&
    typeof detail.command === "string" &&
    COMMANDS.has(detail.command)
  );
}

/**
 * Sends `command` to panel `id`. False when no mounted diff viewer took it: the
 * panel is unmounted (a background tab of a group) or isn't one.
 */
export function sendDiffCommand(detail: DiffCommandDetail): boolean {
  const event = new CustomEvent<DiffCommandDetail>(DIFF_COMMAND_EVENT, {
    detail,
    cancelable: true,
  });
  return !window.dispatchEvent(event);
}

/** Runs `onCommand` for each command addressed to panel `id`, and claims it. */
export function useDiffCommands(
  id: string,
  onCommand: (command: DiffCommand, fromKeyboard: boolean) => void
): void {
  const handle = useEffectEvent(onCommand);
  useEffect(() => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!isDiffCommandDetail(detail) || detail.id !== id) return;
      event.preventDefault();
      handle(detail.command, detail.fromKeyboard === true);
    };
    window.addEventListener(DIFF_COMMAND_EVENT, listener);
    return () => window.removeEventListener(DIFF_COMMAND_EVENT, listener);
  }, [id]);
}
