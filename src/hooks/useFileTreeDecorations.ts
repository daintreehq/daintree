import { useMemo } from "react";
import type { FileDecoration } from "@shared/types/forge";
import { useFileDecorations } from "./useFileDecorations";

/**
 * Stable empty result shared across disabled/empty calls so consumers' deps
 * don't thrash on a fresh object identity.
 */
const EMPTY: Readonly<Record<string, FileDecoration>> = Object.freeze({});

/**
 * General-purpose, opt-in file-decoration consumer for a file list rendered
 * **outside** the Review Hub diff view — the only other `useFileDecorations`
 * mount until now (`ReviewHubContent`).
 *
 * A lint / leak / status plugin declares a decoration provider for a scope
 * (e.g. `tree:project`); any path-list surface can pass that same scope here
 * with the paths it currently renders to badge those rows. The host merges
 * every provider registered for the scope, so the consumer need not know which
 * plugin supplies the badge — it renders whatever it gets via
 * {@link import("../components/Plugin/FileDecorationBadge").FileDecorationBadge}.
 *
 * Kept cheap and opt-in: when `enabled` is false (the default caller passes
 * when no plugin contributes to the scope) or `scope` is empty, the underlying
 * pull/subscription is skipped entirely and a stable empty map is returned, so
 * dropping this into a list that no plugin decorates costs nothing.
 */
export function useFileTreeDecorations(
  scope: string,
  paths: string[],
  enabled = true
): Record<string, FileDecoration> {
  const activeScope = enabled ? scope : "";
  // When disabled, also collapse the path set so the inner hook's effect never
  // fires a fetch. `useFileDecorations` already early-outs on an empty scope,
  // but passing an empty array keeps the memo identity stable too.
  const activePaths = useMemo(
    () => (enabled && scope.length > 0 ? paths : []),
    [enabled, scope, paths]
  );
  const decorations = useFileDecorations(activeScope, activePaths);
  return enabled ? decorations : EMPTY;
}
