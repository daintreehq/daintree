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

// Brand words whose inner capital is part of the name, not a word boundary.
const BRAND_WORDS = ["GitHub", "GitLab", "JavaScript", "TypeScript", "YouTube", "OpenAI"];

export function humanizeComponentName(componentName: string): string {
  // `PanelDialog:terminal`, `PluginView:acme.dashboard` — the suffix is an id.
  const base = componentName.split(":")[0]!.trim();
  // Already words (a plugin label like "GitHub list"): its casing is the
  // author's, so leave it exactly as written.
  if (/\s/.test(base)) return base;
  const brands = new Map<string, string>();
  const shielded = BRAND_WORDS.reduce((text, brand, i) => {
    const token = `\u0000${i}\u0000`;
    if (!text.includes(brand)) return text;
    brands.set(token.toLowerCase(), brand);
    return text.split(brand).join(` ${token} `);
  }, base);
  const words = shielded
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  return [words[0]!, ...words.slice(1).map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))]
    .map((w) => brands.get(w.toLowerCase()) ?? w)
    .join(" ");
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
