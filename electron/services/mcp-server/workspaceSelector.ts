import type { McpWorkspaceSelectorRejectionCode } from "./shared.js";
import { MCP_WORKSPACE_ID_HEADER } from "../../../shared/config/mcpClientConfigs.js";
import { MCP_WORKSPACE_ID_QUERY_PARAM } from "./shared.js";

export interface WorkspaceSelectorRejection {
  code: McpWorkspaceSelectorRejectionCode;
  message: string;
}

export type WorkspaceSelectorParse =
  /** No selector sent — the session keeps the legacy focused-window routing. */
  | { kind: "absent" }
  /** Exactly one unambiguous workspace id was requested. */
  | { kind: "selector"; workspaceId: string }
  /** The request named a workspace, but not unambiguously. No session is created. */
  | { kind: "reject"; rejection: WorkspaceSelectorRejection };

/**
 * Normalize one raw selector value. Returns `false` when the value is present
 * but malformed.
 *
 * An empty or whitespace-only value is malformed, not absent. A client that
 * sends the field at all believes it is scoping itself; treating a blank one as
 * "no selector" would hand it an unbound, focus-following session while it
 * thought otherwise — the exact silent misrouting this selector removes. A
 * templated config that interpolated nothing is the obvious way to produce one.
 *
 * A comma is rejected rather than split: Node folds repeated instances of most
 * headers into one comma-joined string, so `a,b` is indistinguishable from a
 * client that sent the header twice with different workspaces. Both are exactly
 * the ambiguity this selector exists to remove, so neither gets a guess.
 */
function normalizeSelectorValue(raw: string): string | false {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes(",")) return false;
  return trimmed;
}

/**
 * Read the workspace selector off a new session's request (#11789).
 *
 * Pure so the whole precedence matrix is testable without a server: the caller
 * passes the raw header value and every query-param occurrence, and gets back
 * one of three outcomes. Nothing here interprets the id — it stays opaque, and
 * is deliberately never parsed as a path or branched on by id format.
 *
 * The header and the query param are equal-authority spellings of one selector,
 * so supplying both is fine when they agree and fatal when they don't. There is
 * no precedence order, because silently preferring one would let a stale value
 * in a copied config override an explicit one on the URL.
 */
export function parseWorkspaceSelector(
  headerValue: string | string[] | undefined,
  queryValues: readonly string[]
): WorkspaceSelectorParse {
  let fromHeader: string | null = null;
  if (Array.isArray(headerValue)) {
    // Node only produces an array for headers it is not allowed to fold, so a
    // repeated selector arrives intact here rather than comma-joined.
    if (headerValue.length > 1) {
      return {
        kind: "reject",
        rejection: {
          code: "WORKSPACE_SELECTOR_INVALID",
          message: `The ${MCP_WORKSPACE_ID_HEADER} header was sent more than once. Send it exactly once.`,
        },
      };
    }
    headerValue = headerValue[0];
  }
  if (typeof headerValue === "string") {
    const normalized = normalizeSelectorValue(headerValue);
    if (normalized === false) {
      return {
        kind: "reject",
        rejection: {
          code: "WORKSPACE_SELECTOR_INVALID",
          message: `The ${MCP_WORKSPACE_ID_HEADER} header must name exactly one workspace id. Send one, or omit the header entirely to follow the focused window.`,
        },
      };
    }
    fromHeader = normalized;
  }

  if (queryValues.length > 1) {
    return {
      kind: "reject",
      rejection: {
        code: "WORKSPACE_SELECTOR_INVALID",
        message: `The ${MCP_WORKSPACE_ID_QUERY_PARAM} query parameter was sent more than once. Send it exactly once.`,
      },
    };
  }
  let fromQuery: string | null = null;
  if (queryValues.length === 1) {
    const normalized = normalizeSelectorValue(queryValues[0]);
    if (normalized === false) {
      return {
        kind: "reject",
        rejection: {
          code: "WORKSPACE_SELECTOR_INVALID",
          message: `The ${MCP_WORKSPACE_ID_QUERY_PARAM} query parameter must name exactly one workspace id. Send one, or omit the parameter entirely to follow the focused window.`,
        },
      };
    }
    fromQuery = normalized;
  }

  if (fromHeader !== null && fromQuery !== null && fromHeader !== fromQuery) {
    return {
      kind: "reject",
      rejection: {
        code: "WORKSPACE_SELECTOR_MISMATCH",
        message: `The ${MCP_WORKSPACE_ID_HEADER} header and the ${MCP_WORKSPACE_ID_QUERY_PARAM} query parameter named different workspaces. Send one, or send both with the same value.`,
      },
    };
  }

  const workspaceId = fromHeader ?? fromQuery;
  if (workspaceId === null) return { kind: "absent" };
  return { kind: "selector", workspaceId };
}
