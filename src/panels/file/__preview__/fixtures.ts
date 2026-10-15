/**
 * The repository the file pane's picker searches in its preview. Plain data, so the
 * screenshot spec can import it under Playwright's Node loader.
 *
 * Shaped to put pressure where a file picker breaks: same-named files in different
 * folders (`index.ts`, `README.md`, `settings.ts`), paths deep enough to clip in a
 * narrow pane, and a long file name that has to give way somewhere.
 */

export const PROJECT_ROOT = "/Users/dev/acme-platform";

export const FIXTURE_FILES: readonly string[] = [
  ".editorconfig",
  ".github/workflows/ci.yml",
  ".gitignore",
  "CHANGELOG.md",
  "README.md",
  "docs/README.md",
  "docs/architecture/settings-persistence.md",
  "docs/guides/getting-started.md",
  "electron/main.ts",
  "electron/services/settings/SettingsStore.ts",
  "electron/services/settings/index.ts",
  "electron/services/settings/migrations/0004-split-workspace-settings.ts",
  "package.json",
  "packages/sdk/README.md",
  "packages/sdk/src/index.ts",
  "shared/config/settings.ts",
  "shared/types/settings.ts",
  "src/App.tsx",
  "src/components/Settings/AgentSettings.tsx",
  "src/components/Settings/GeneralSettings.tsx",
  "src/components/Settings/SettingsDialog.tsx",
  "src/components/Settings/index.ts",
  "src/components/Settings/integrations/providers/GitHubIntegrationSettingsPanel.tsx",
  "src/components/Settings/sections/WorkspaceSettingsSection.tsx",
  "src/components/Settings/useSettingsSearch.ts",
  "src/hooks/useSettings.ts",
  "src/index.ts",
  "src/main.tsx",
  "src/store/settingsStore.ts",
  "tsconfig.json",
  "vite.config.ts",
];

/** A repository big enough that an empty query hits the picker's 50-row cap. */
export const MANY_FILES: readonly string[] = [
  ...FIXTURE_FILES,
  ...Array.from(
    { length: 90 },
    (_, i) => `src/components/icons/generated/Icon${String(i + 1).padStart(3, "0")}.tsx`
  ),
];

/**
 * A stand-in for `files:search`: case-insensitive substring over the path, file-name
 * hits ahead of folder hits, alphabetical within each. An empty query lists the
 * first files alphabetically, as the real one does.
 */
export function searchFixture(
  query: string,
  limit: number,
  files: readonly string[] = FIXTURE_FILES
): string[] {
  const q = query.trim().toLowerCase();
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  if (!q) return sorted.slice(0, limit);
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  const byName = sorted.filter((p) => name(p).includes(q));
  const byPath = sorted.filter((p) => !name(p).includes(q) && p.toLowerCase().includes(q));
  return [...byName, ...byPath].slice(0, limit);
}

export const FAILURE_MESSAGE =
  "EACCES: permission denied, scandir '/Users/dev/acme-platform/.cache'";
