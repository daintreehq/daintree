import { z } from "zod";

// Shared by the file-browser openers' metadata in worktreeContextActions.ts and
// their runs in worktreeContextActions.impl.ts.

/**
 * Args shared by both file-browser openers. The two actions differ mainly in the
 * surface they present on, so a caller that knows what it wants to browse
 * names it identically either way — and `revealPath` in particular must not
 * become the thing that picks a surface, since revealing the root passes no
 * path while still carrying a `revealKind` (#11666).
 */
const fileBrowserArgsObject = z.object({
  // `.min(1)`, unlike the other worktree actions: an empty string here is not a
  // harmless falsy worktree — it would slip past the unknown-worktree
  // guard and open the workspace root instead of failing.
  worktreeId: z.string().min(1).optional(),
  /**
   * Path to select and scroll into view on open, relative to the worktree or
   * workspace root — the same base `browserSelectedPath` is stored against,
   * not the tree's current scoped root. Every caller computes it that way,
   * and a path relative to a scope the caller cannot see would be
   * unresolvable from outside the panel.
   */
  revealPath: z.string().optional(),
  /**
   * What `revealPath` points at. A directory is also expanded so its
   * children are visible; the caller knows (it validated the path),
   * and re-statting here would be a second round-trip for one bit.
   */
  revealKind: z.enum(["file", "directory"]).optional(),
});

export const fileBrowserArgsSchema = fileBrowserArgsObject.optional();

/**
 * The persistent opener also answers to the dock launcher, which forwards the
 * placement it advertised in its heading (`launchPanelKind`). Declared only
 * here: the dialog opener has no placement to take, and `ActionService` drops
 * undeclared fields, so a shared schema would silently strand a dock request in
 * the grid — the heading promising one surface and the panel landing on the
 * other (#11917).
 */
export const fileBrowserPanelArgsSchema = fileBrowserArgsObject
  .extend({
    location: z
      .enum(["grid", "dock"])
      .optional()
      .describe("Surface to open on (default: grid). `dock` parks it as a chip in the sidebar."),
    activateDockOnCreate: z
      .boolean()
      .optional()
      .describe("Open the dock popover immediately (default: false). Ignored unless docking."),
    rootPath: z
      .string()
      .optional()
      .describe(
        "Folder to root the tree at, relative to the worktree or workspace root (e.g. `content`). Absolute paths and `..` are rejected. An existing browser is rescoped to it; `.` or an empty string resets to the base folder; omit to leave the scope alone. `revealPath` must sit inside it."
      ),
  })
  .optional();

export type FileBrowserArgs = z.infer<typeof fileBrowserArgsSchema>;
export type FileBrowserPanelArgs = z.infer<typeof fileBrowserPanelArgsSchema>;
