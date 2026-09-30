import type { ActionDispatchResult } from "../types/actions.js";

const NO_PANEL_SUFFIX = " — pass an `id` from the terminal listing.";
const NO_PANEL_PATTERN = /^[\w.]+: no panel with id ".*"$/s;

/**
 * "No panel with id" for a terminal-taking action: the id is not in the view
 * that received the call. The one message every miss reads as, whether the id
 * never existed or — for a caller not entitled to know — lives elsewhere.
 */
export function formatNoPanelMessage(actionId: string, terminalId: string): string {
  return `${actionId}: no panel with id "${terminalId}"${NO_PANEL_SUFFIX}`;
}

function isNoPanelMessage(message: unknown): boolean {
  return (
    typeof message === "string" &&
    message.endsWith(NO_PANEL_SUFFIX) &&
    NO_PANEL_PATTERN.test(message.slice(0, -NO_PANEL_SUFFIX.length))
  );
}

export interface TerminalInOtherProjectDetails {
  terminalId: string;
  projectId: string;
  /** Whether any window still holds a live view of `projectId`. */
  viewResident: boolean;
}

/** The plain `details` `ActionService` emits with `TERMINAL_IN_OTHER_PROJECT`. */
export interface TerminalInOtherProjectErrorDetails extends TerminalInOtherProjectDetails {
  actionId: string;
}

/**
 * Thrown when a named terminal is not in this view but is running in another
 * project's (#13120), so a caller can tell "alive elsewhere" from "gone".
 *
 * The class is the authentication, as with `PartialSuccessError`: only in-repo
 * code can construct it, and `ActionService` maps it to
 * `TERMINAL_IN_OTHER_PROJECT`. The fields are copied into plain `details`
 * there, because custom `Error` properties do not survive structured clone.
 */
export class TerminalInOtherProjectError extends Error {
  readonly actionId: string;
  readonly terminalId: string;
  readonly projectId: string;
  readonly viewResident: boolean;

  constructor(actionId: string, details: TerminalInOtherProjectDetails) {
    const where = details.viewResident
      ? "its project's view"
      : "its project, whose view is not open (switch to it first)";
    super(
      `${actionId}: terminal "${details.terminalId}" is not in this project; it is running in ` +
        `project "${details.projectId}" and can only be acted on from ${where}.`
    );
    this.name = "TerminalInOtherProjectError";
    this.actionId = actionId;
    this.terminalId = details.terminalId;
    this.projectId = details.projectId;
    this.viewResident = details.viewResident;
  }

  toDetails(): TerminalInOtherProjectErrorDetails {
    return {
      actionId: this.actionId,
      terminalId: this.terminalId,
      projectId: this.projectId,
      viewResident: this.viewResident,
    };
  }
}

/**
 * Collapse `TERMINAL_IN_OTHER_PROJECT` into the ordinary miss for a caller bound
 * to one view — a project-bound plugin or a routed MCP session. Those callers
 * get one answer for "never existed" and "another project's", for the same
 * reason `RESOURCE_NOT_OWNED` is uniform (#12980): telling them apart would let
 * a scoped caller probe ids for the shape of workspaces it was never granted.
 * Applied in main, where binding is known; the renderer cannot see it.
 *
 * Both kinds of miss leave with no `details`. An ordinary miss carries the
 * renderer's thrown `Error`, whose `stack` survives the structured clone to a
 * plugin worker, so a replacement minted here would be told apart by its stack
 * alone — dropping it from both is the only shape that is identical.
 */
export function maskTerminalInOtherProject(result: ActionDispatchResult): ActionDispatchResult {
  // Renderer replies cross IPC unvalidated, so a malformed one passes through.
  if (!result || result.ok || !result.error) return result;
  const { code, message } = result.error;
  if (code === "EXECUTION_ERROR" && isNoPanelMessage(message)) {
    return { ok: false, error: { code, message } };
  }
  if (code !== "TERMINAL_IN_OTHER_PROJECT") return result;
  const details = result.error.details as Partial<TerminalInOtherProjectErrorDetails> | undefined;
  return {
    ok: false,
    error: {
      code: "EXECUTION_ERROR",
      message: formatNoPanelMessage(
        typeof details?.actionId === "string" ? details.actionId : "terminal.close",
        typeof details?.terminalId === "string" ? details.terminalId : ""
      ),
    },
  };
}
