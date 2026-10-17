/**
 * Cap on the command text echoed back by `terminal.sendCommand` (#12337).
 *
 * Bounded because the result advertises an output schema: over the 50 KiB
 * response budget the transport drops `structuredContent` and flags the call
 * `isError`, so an unbounded echo would turn a successful large submission into
 * a reported failure with its own correlation token truncated away.
 */
export const MAX_ECHOED_COMMAND_CHARS = 1024;

export interface TerminalSendCommandReceipt {
  sent: true;
  terminalId: string;
  command: string;
  submissionToken: string;
  message: string;
}

/**
 * The receipt `terminal.sendCommand` returns once a submission is queued.
 * Shared so the renderer action and the host's viewless path answer with the
 * same result, since the action's result schema is part of the MCP contract.
 */
export function buildTerminalSendCommandReceipt(
  terminalId: string,
  command: string,
  submissionToken: string
): TerminalSendCommandReceipt {
  return {
    sent: true,
    terminalId,
    command: command.slice(0, MAX_ECHOED_COMMAND_CHARS),
    submissionToken,
    message: `Submission queued. Do not send this command again; check delivery with the terminal-status capability using this submissionToken.`,
  };
}
