/**
 * The workspace this renderer view was created for — a project id or a scratch
 * id (ProjectViewManager is keyed on opaque ids and seeds either kind).
 *
 * This is the only view-local workspace identity in the renderer, and it is
 * immutable for the life of the WebContents: main seeds it at view creation and
 * verifies the handshake on load. `useScratchStore`'s `currentScratch`, by
 * contrast, is broadcast to *every* view (including cached ones), so it says
 * what the user is looking at globally — never which workspace *this* view owns.
 * Anything that must not act on a sibling view's state has to key off this.
 */
export function getViewWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;

  // Seeded by preload via additionalArguments (#9162). The `?projectId=` query
  // fallback covers the initial-window load (createWindow.ts still passes it)
  // and any test/shell view without the bootstrap global.
  const seeded = window.__DAINTREE_INITIAL_PROJECT__?.id;
  if (seeded) return seeded;

  try {
    return new URL(window.location.href).searchParams.get("projectId");
  } catch {
    return null;
  }
}
