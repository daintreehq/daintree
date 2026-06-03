export const KILL_TERMINAL_TITLE = "Kill terminal?";
export const KILL_TERMINAL_CONFIRM_LABEL = "Kill terminal";

export function killTerminalDescription(name?: string): string {
  return name
    ? `${name} will be terminated and cannot be recovered.`
    : "The terminal will be terminated and cannot be recovered.";
}
