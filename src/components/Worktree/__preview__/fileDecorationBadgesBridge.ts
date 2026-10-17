import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { FileChangeDetail } from "@shared/types/git";
import type { FileDecoration } from "@shared/types/forge";

/**
 * The plugin bridge `useFileDecorations` pulls from, answered from fixtures.
 *
 * Imported before anything else on the page so the shim is on `window` before a
 * store module reads it. Every other bridge namespace degrades to inert; only
 * `plugin.getDecorations` answers for real, and only for the worktree-files
 * scope `FileChangeList` asks for, so the badges arrive through the same seam
 * a provider's would.
 */

export const ROOT = "/Users/dev/helios-dashboard";

export const CHANGES: FileChangeDetail[] = [
  { path: "src/components/charts/Legend.tsx", status: "modified", insertions: 42, deletions: 7 },
  { path: "src/components/charts/Axis.tsx", status: "modified", insertions: 3, deletions: 1 },
  { path: "src/components/charts/Tooltip.tsx", status: "modified", insertions: 18, deletions: 4 },
  { path: "src/lib/format.ts", status: "added", insertions: 24, deletions: 0 },
  { path: "src/lib/credentials.ts", status: "added", insertions: 6, deletions: 0 },
  { path: "README.md", status: "modified", insertions: 2, deletions: 2 },
  { path: "package.json", status: "modified", insertions: 1, deletions: 1 },
];

export const DECORATIONS: Record<string, FileDecoration> = {
  // A link: the review-comments shape a forge provider attaches.
  "src/components/charts/Legend.tsx": {
    badge: "2",
    tooltip: "2 unresolved review comments",
    url: "https://github.com/helios-labs/helios-dashboard/pull/4830/files",
  },
  // Static, neutral.
  "src/components/charts/Tooltip.tsx": { badge: "3", tooltip: "3 lint warnings" },
  // Static, three digits.
  "src/lib/format.ts": { badge: "128", tooltip: "128 type errors" },
  // Static, provider colour, and a tooltip long enough to wrap. The colour pair
  // is the provider's to get right: a status wash under primary text clears
  // 4.5:1 in every theme, where status-coloured text on its own wash does not.
  "src/lib/credentials.ts": {
    badge: "!",
    tooltip:
      "Possible AWS secret access key on line 4. Rotate it before you push; the leak scanner blocks pushes that include it.",
    color: "bg-status-error/20 text-text-primary",
  },
  // A link with a two-digit count.
  "README.md": {
    badge: "12",
    tooltip: "12 unresolved review comments",
    url: "https://github.com/helios-labs/helios-dashboard/pull/4830/files#readme",
  },
};

/** What every shimmed method returns: awaitable and callable, like `previewShims`' own. */
function inert(): unknown {
  const settled = Promise.resolve(undefined);
  return Object.assign(() => undefined, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

const plugin = new Proxy(
  {
    getDecorations: (scope: string, paths: string[]) =>
      Promise.resolve(
        scope === `worktree-files:${ROOT}`
          ? Object.fromEntries(
              paths.filter((p) => p in DECORATIONS).map((p) => [p, DECORATIONS[p]])
            )
          : {}
      ),
    onDecorationsChanged: () => () => {},
  } as Record<string, unknown>,
  { get: (target, key) => (key in target ? Reflect.get(target, key) : () => inert()) }
);

// Only ever a harness: with a real bridge on the window this page is running
// inside the app, and clearing that origin's storage would clear the user's own.
if (!Reflect.get(window, "electron")) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}

installPreviewShims({ plugin });
