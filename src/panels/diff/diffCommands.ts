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
}

const COMMANDS: ReadonlySet<string> = new Set<DiffCommand>([
  "nextChange",
  "previousChange",
  "nextFile",
  "previousFile",
  "toggleViewed",
]);

function isDiffCommandDetail(detail: unknown): detail is DiffCommandDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const { id, command } = detail as Record<string, unknown>;
  return typeof id === "string" && typeof command === "string" && COMMANDS.has(command);
}

/** Runs `onCommand` for each command addressed to panel `id`. */
export function useDiffCommands(id: string, onCommand: (command: DiffCommand) => void): void {
  const handle = useEffectEvent(onCommand);
  useEffect(() => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (!isDiffCommandDetail(detail) || detail.id !== id) return;
      handle(detail.command);
    };
    window.addEventListener(DIFF_COMMAND_EVENT, listener);
    return () => window.removeEventListener(DIFF_COMMAND_EVENT, listener);
  }, [id]);
}
