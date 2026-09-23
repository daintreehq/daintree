/**
 * `componentName` is a diagnostic identifier — it tags Sentry events and names
 * the error-store source — so it stays a code name. The fallback shows people a
 * name they would recognise instead: an explicit `displayName` when the caller
 * has one, else a known region's everyday name, else the identifier split into
 * words ("GitPushConfirmDialog" → "Git push confirm dialog").
 */
const KNOWN_NAMES: Record<string, string> = {
  App: "Daintree",
  ContentGrid: "Panel grid",
  MainContent: "Main view",
  ContentDock: "Dock",
  PortalDock: "Side dock",
  ReviewPane: "Review panel",
  FilePane: "File viewer",
  DiffPane: "Diff viewer",
  FileBrowserPane: "File browser",
  DevPreviewPane: "Dev preview",
  WorktreeCard: "Worktree card",
};

export function humanizeComponentName(componentName: string): string {
  // `PanelDialog:terminal`, `PluginView:acme.dashboard` — the suffix is an id.
  const base = componentName.split(":")[0]!.trim();
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  return [
    words[0]!,
    ...words.slice(1).map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase())),
  ].join(" ");
}

export function resolveBoundaryDisplayName(
  displayName: string | undefined,
  componentName: string | undefined,
  fallback: string
): string {
  const explicit = displayName?.trim();
  if (explicit) return explicit;
  if (!componentName) return fallback;
  const known = KNOWN_NAMES[componentName];
  if (known) return known;
  return humanizeComponentName(componentName) || fallback;
}
