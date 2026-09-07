/**
 * One row of the workspace discovery catalog (#12307).
 *
 * Identity only. `Daintree-Workspace-Id` lets an MCP client bind a session to
 * one workspace, but nothing on the wire told a client what those ids are, so
 * external callers recovered them by hashing candidate paths — which
 * `generateProjectId` (`electron/services/projectStorePaths.ts`) explicitly is
 * not: a relocated project keeps the id it was minted with, and `mintProjectId`
 * falls back to `randomBytes(32)` on collision, so some ids were never
 * derivable at all. This is the lookup that replaces the hash.
 *
 * Deliberately five fields. Everything a caller needs to pick a workspace and
 * bind to it, and nothing about what is happening inside one — the same line
 * drawn on `agent.listPresets`.
 */
export interface WorkspaceListEntry {
  /** The stored id, verbatim — what `Daintree-Workspace-Id` expects. */
  workspaceId: string;
  /** The recorded absolute folder path. Not probed: a missing folder still lists. */
  path: string;
  /** Display name. */
  name: string;
  /**
   * Derived from the id's shape, not from a persisted column — the two id
   * spaces are disjoint (`shared/utils/workspaceIds.ts`), so `kind` is a
   * reading of existing data rather than a new concept.
   */
  kind: "project" | "scratch";
  /**
   * Whether any window currently holds a view for this workspace, cached and
   * backgrounded views included.
   *
   * An observation, not a routing promise. It does not separate a wrong id from
   * a closed workspace — catalog membership does that, since a structurally
   * valid unknown id completes the binding handshake and only fails on the
   * calls after it. Two live views are ambiguous and still get refused.
   */
  hasLiveView: boolean;
}
