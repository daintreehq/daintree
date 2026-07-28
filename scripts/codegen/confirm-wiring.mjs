#!/usr/bin/env node
// Audits confirm-dialog wiring for danger:"confirm" actions.
//
// For each action in CONFIRMED_WIRED, verifies that at least one source file
// contains both a ConfirmDialog-family component reference AND the action ID as
// a text token. Actions in BYPASS_WIRED use non-ConfirmDialog patterns (deferred-
// promise stores, IPC bypasses, agent-only gates) and are exempt from the scan.
//
// Usage:
//   node scripts/codegen/confirm-wiring.mjs     # exits 0 (ok) or 1 (violations)
//
// The check is registered as `npm run check:confirm-wiring` and gates `npm run check`.
// The companion test in src/services/actions/__tests__/actionDefinitions.quality.test.ts
// asserts the static classification (every EXPECTED_CONFIRM_DANGER action is in
// CONFIRMED_WIRED or BYPASS_WIRED). This script verifies the dynamic side: that
// the listed call sites still exist in the source tree.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Project } from "ts-morph";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..", "..");
const TSCONFIG_PATH = path.join(REPO_ROOT, "tsconfig.json");

// Mirror of EXPECTED_CONFIRM_DANGER from actionDefinitions.quality.test.ts.
// Keep in sync when adding/removing destructive actions.
const EXPECTED_CONFIRM_DANGER = new Set([
  "git.push",
  "git.pullRebase",
  "terminal.kill",
  "terminal.killAll",
  "terminal.restart",
  "terminal.restartAll",
  "terminal.arm",
  "worktree.delete",
  "worktree.sessions.endAll",
  "worktree.sessions.trashAll",
  "worktree.sessions.restartAll",
  "worktree.sessions.clearHistory",
  "fleet.kill",
  "fleet.trash",
  "fleet.restart",
  "fleet.deleteNamedFleet",
  "worktree.resource.teardown",
  "portal.links.remove",
  "keybinding.resetAll",
  "logs.clear",
  "project.remove",
  "recipe.delete",
  "recipe.run",
  "devPreview.restartAndClearCache",
  "devPreview.reinstallAndRestart",
  "artifact.applyPatch",
  "agentSettings.reset",
  "forge.createPR",
  "forge.closePR",
  "forge.reopenPR",
  "forge.mergePR",
  "forge.convertPRToDraft",
  "forge.markPRReadyForReview",
  "forge.commentOnPR",
  "forge.editPR",
  "forge.closeIssue",
  "forge.editIssue",
  "session.bookmarkAndClose",
  "session.bookmark.delete",
]);

// Actions with a ConfirmDialog-family component co-located in the same source file
// as the action ID string. The script verifies each action has at least one such file.
// Mirror of CONFIRMED_WIRED in actionDefinitions.quality.test.ts.
const CONFIRMED_WIRED = [
  "terminal.kill",
  "terminal.killAll",
  "terminal.restart",
  "terminal.restartAll",
  "worktree.delete",
  "worktree.sessions.endAll",
  "worktree.sessions.trashAll",
  "worktree.sessions.restartAll",
  "worktree.sessions.clearHistory",
  "worktree.resource.teardown",
  "fleet.kill",
  "fleet.trash",
  "fleet.restart",
  "fleet.deleteNamedFleet",
  "portal.links.remove",
  "keybinding.resetAll",
  "logs.clear",
  "recipe.delete",
  "devPreview.restartAndClearCache",
  "devPreview.reinstallAndRestart",
];

// Actions whose confirmation uses a non-ConfirmDialog-family pattern. These are
// documented in docs/architecture/destructive-action-safeguards.md Known Bypasses
// and are excluded from the co-location scan.
// Mirror of BYPASS_WIRED in actionDefinitions.quality.test.ts.
const BYPASS_WIRED = new Set([
  "git.push", // deferred-promise via gitPushConfirmStore; GitPushConfirmDialog resolves it
  "git.pullRebase", // IPC bypass in ReviewHubContent.tsx; ConfirmDialog wired but ID not co-located
  "project.remove", // confirm in ProjectSwitcherPalette.tsx; action ID not co-located
  "terminal.arm", // agent/MCP-only confirm gate (#11346); palette-hidden, user arming goes through the fleet ribbon (not ActionService), so no user-side ConfirmDialog to co-locate
  "recipe.run", // agent-dispatch only; no user-side ConfirmDialog (danger:"confirm" gates MCP only)
  "artifact.applyPatch", // ConfirmDialog in ArtifactOverlay.tsx; dispatch in useArtifacts.ts (ID not co-located)
  "agentSettings.reset", // agent/MCP-only; palette-hidden, configured from Settings via client (danger:"confirm" gates agent dispatch only)
  // Forge PR write actions are agent/MCP-only (issue #10654); danger:"confirm"
  // gates agent dispatch — no user-side ConfirmDialog to co-locate.
  "forge.createPR",
  "forge.closePR",
  "forge.reopenPR",
  "forge.mergePR",
  "forge.convertPRToDraft",
  "forge.markPRReadyForReview",
  "forge.commentOnPR",
  "forge.editPR",
  "forge.closeIssue", // agent/MCP-only forge write (#10653); danger:"confirm" gates agent dispatch only, no user-side ConfirmDialog
  "forge.editIssue", // agent/MCP-only forge write (#10653); danger:"confirm" gates agent dispatch only, no user-side ConfirmDialog
  // Session bookmarks (#11288): Phase 1 is programmatic/MCP-only and palette-hidden;
  // confirmation is the explicit `confirmed: true` arg. The Phase-2 pane dialog
  // will add a co-located ConfirmDialog; until then there is none to scan.
  "session.bookmarkAndClose",
  "session.bookmark.delete",
]);

// Text tokens identifying a ConfirmDialog-family component in a source file.
// A file is considered "confirm-bearing" when its full text contains any of these.
const CONFIRM_TOKENS = [
  "ConfirmDialog",
  "WorktreeDeleteDialog",
  "DevPreviewDestructiveConfirmDialog",
  "TerminalDestructiveActionConfirmDialog",
  "GitPushConfirmDialog",
  "ForcePushConfirmDialog",
  "PortalCloseConfirmDialog",
];

/**
 * Run the confirm-wiring audit.
 * @returns {Promise<{ok: boolean, missingWiring: string[], unaccounted: string[], wiringMap: Map<string, string[]>}>}
 */
export async function checkConfirmWiring() {
  const project = new Project({
    tsConfigFilePath: TSCONFIG_PATH,
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([
    path.join(REPO_ROOT, "src/**/*.{ts,tsx}"),
    path.join(REPO_ROOT, "shared/**/*.{ts,tsx}"),
  ]);

  const sourceFiles = project.getSourceFiles().filter((sf) => {
    const fp = sf.getFilePath();
    return !fp.includes("/__tests__/") && !fp.includes("/__snapshots__/") && !fp.endsWith(".d.ts");
  });

  // Build a map: actionId → list of source file paths where the action ID is
  // co-located with a ConfirmDialog-family component.
  /** @type {Map<string, string[]>} */
  const wiringMap = new Map(CONFIRMED_WIRED.map((id) => [id, []]));

  for (const sf of sourceFiles) {
    const text = sf.getFullText();

    const hasConfirmToken = CONFIRM_TOKENS.some((token) => text.includes(token));
    if (!hasConfirmToken) continue;

    const relPath = path.relative(REPO_ROOT, sf.getFilePath());

    for (const id of CONFIRMED_WIRED) {
      if (text.includes(`"${id}"`)) {
        wiringMap.get(id).push(relPath);
      }
    }
  }

  // Actions in CONFIRMED_WIRED whose co-located call site is no longer detectable.
  const missingWiring = CONFIRMED_WIRED.filter((id) => wiringMap.get(id).length === 0);

  // Actions in EXPECTED_CONFIRM_DANGER not accounted for in either list.
  const unaccounted = [...EXPECTED_CONFIRM_DANGER].filter(
    (id) => !CONFIRMED_WIRED.includes(id) && !BYPASS_WIRED.has(id)
  );

  const ok = missingWiring.length === 0 && unaccounted.length === 0;
  return { ok, missingWiring, unaccounted, wiringMap };
}

async function main() {
  let result;
  try {
    result = await checkConfirmWiring();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { ok, missingWiring, unaccounted } = result;

  if (ok) {
    console.log(
      `[confirm-wiring] OK — all ${CONFIRMED_WIRED.length} CONFIRMED_WIRED actions have co-located ConfirmDialog wiring`
    );
    return;
  }

  if (missingWiring.length > 0) {
    console.error(
      `[confirm-wiring] ${missingWiring.length} CONFIRMED_WIRED action(s) have no detectable ConfirmDialog co-location:`
    );
    for (const id of missingWiring) {
      console.error(`  - ${id}`);
    }
    console.error(
      `  Fix: restore the ConfirmDialog at the call site, or move the action to BYPASS_WIRED with a documented reason.`
    );
  }

  if (unaccounted.length > 0) {
    console.error(
      `[confirm-wiring] ${unaccounted.length} EXPECTED_CONFIRM_DANGER action(s) not in CONFIRMED_WIRED or BYPASS_WIRED:`
    );
    for (const id of unaccounted) {
      console.error(`  - ${id}`);
    }
    console.error(
      `  Fix: add to CONFIRMED_WIRED (if it has a ConfirmDialog call site) or BYPASS_WIRED (with a documented reason).`
    );
  }

  process.exit(1);
}

const isMain =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href ||
  (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));

if (isMain) {
  main();
}
