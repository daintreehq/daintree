export const KILL_TERMINAL_TITLE = "Kill terminal?";
export const KILL_TERMINAL_CONFIRM_LABEL = "Kill terminal";

export function killTerminalDescription(name?: string): string {
  const trimmed = name?.trim();
  return trimmed
    ? `${trimmed} will be terminated and cannot be recovered.`
    : "The terminal will be terminated and cannot be recovered.";
}
