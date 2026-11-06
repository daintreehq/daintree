/**
 * What an agent terminal does once its agent reports `done` for the request
 * Daintree is waiting on (#16171). `keep` is the default and leaves the pane
 * where it is; it is never stored.
 */
export type TerminalWhenDone = "keep" | "background" | "close";

export const TERMINAL_WHEN_DONE_CHOICES = [
  "keep",
  "background",
  "close",
] as const satisfies readonly TerminalWhenDone[];

/** A terminal armed with a choice other than `keep`. */
export interface TerminalWhenDoneEntry {
  terminalId: string;
  choice: Exclude<TerminalWhenDone, "keep">;
}

/** Main's push when a terminal's choice changes, `keep` when it is no longer armed. */
export interface TerminalWhenDoneChange {
  terminalId: string;
  choice: TerminalWhenDone;
}

/**
 * Main asking a view to apply a terminal's choice to its pane: move it to the
 * background, or remove it once Main has closed its terminal and captured its
 * session.
 */
export interface TerminalWhenDoneFinishRequest {
  terminalId: string;
  action: "background" | "remove";
}

/** Main asking a view whether someone is using a pane, before moving it. */
export interface TerminalWhenDoneInUseQuery {
  requestId: string;
  terminalId: string;
}

export interface TerminalWhenDoneInUseReply {
  requestId: string;
  inUse: boolean;
}
