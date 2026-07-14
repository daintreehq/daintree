import { Menu } from "electron";
import { projectStore } from "./services/ProjectStore.js";
import { getWindowRegistry } from "./window/windowRef.js";

// Stable ids for the File-menu items gated on "is a project open". Live mutation
// through Menu.getApplicationMenu().getMenuItemById() is the only way to keep
// them fresh without rebuilding the menu — a rebuild dismisses an open menu on
// macOS/Windows and briefly re-registers accelerators.
export const PROJECT_MENU_ITEM_IDS = ["file-project-settings", "file-close-project"] as const;

/**
 * Which project the process-global application menu should reflect.
 *
 * The menu bar is process-global but project state is per-window, so the answer
 * is "whatever the focused window shows". `projectStore.getCurrentProjectId()`
 * is a global most-recently-switched pointer, NOT per-window state (#5541 /
 * #6016 / #11101), so it is only ever a fallback for windows that genuinely have
 * no per-window state to read.
 *
 * The candidate is then validated against the project rows, because a raw
 * ProjectViewManager id is not proof that a project is open:
 *   - scratch workspaces share the PVM and surface an id with no project row;
 *   - closing a project marks its row "closed" but leaves the window's PVM
 *     binding pointing at it, so the id outlives the open project.
 * Only "closed" is rejected (mirroring getOpenProjectById in ipc/projectContext.ts):
 * project status is process-global, so a project visible in a non-focused window
 * is legitimately "background" rather than "active".
 */
export function resolveProjectIdForApplicationMenu(): string | null {
  const registry = getWindowRegistry();
  // No window layer at all (early boot, legacy hosts): the global pointer is the
  // only signal there is.
  if (!registry) return validateOpenProject(projectStore.getCurrentProjectId());

  const primary = registry.getPrimary();
  // A registry with no focused window means the app is windowless (macOS keeps
  // the menu bar alive). Nothing is on screen, so nothing is open — do NOT fall
  // back to the global pointer here, or the gate stays stuck enabled.
  if (!primary) return null;

  const pvm = primary.services.projectViewManager;
  if (pvm) {
    // A cold switch flips `activeProjectId` to the incoming workspace while the
    // outgoing project's view stays on screen as the anti-flash bridge until the
    // paint gate settles. If that bridge names an open project, a project IS
    // still displayed — so answer with it rather than the not-yet-visible
    // incoming id, which would blink the gates off mid-switch.
    const bridged = validateOpenProject(pvm.getOutgoingBridgeProjectId());
    if (bridged) return bridged;

    return validateOpenProject(pvm.getActiveProjectId());
  }

  // Window without a ProjectViewManager: no per-window state exists, so the
  // global pointer is the best available answer.
  return validateOpenProject(projectStore.getCurrentProjectId());
}

function validateOpenProject(projectId: string | null): string | null {
  if (!projectId) return null;
  const project = projectStore.getProjectById(projectId);
  if (!project) return null;
  return project.status === "closed" ? null : projectId;
}

/**
 * Re-evaluate the project gate and push it onto the live menu items.
 *
 * Best-effort by construction: callers invoke this from a `finally` after a
 * project switch, so a throw here would REPLACE the original rejection and mask
 * the real failure. A cosmetic menu update must never do that — swallow and log.
 */
export function refreshProjectMenuState(): void {
  try {
    const menu = Menu.getApplicationMenu();
    if (!menu) return;

    const enabled = resolveProjectIdForApplicationMenu() !== null;
    for (const id of PROJECT_MENU_ITEM_IDS) {
      const item = menu.getMenuItemById(id);
      if (!item) continue;
      item.enabled = enabled;
    }
  } catch (err) {
    console.error("[MAIN] Failed to refresh the File-menu project gates:", err);
  }
}
