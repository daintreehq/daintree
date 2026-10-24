import { useEffect, useMemo, useState } from "react";
import { isProjectPluginRunning } from "@/components/Settings/projectPluginsShared";
import { useProjectStore } from "@/store/projectStore";
import { logError } from "@/utils/logger";
import type { ProjectPluginInfo } from "@shared/types/plugin";

/** What a running project plugin's own settings still need, as the overview reports it. */
export interface SettingsGaps {
  /** Required settings with nothing stored, as `{ id, label }`, in manifest order. */
  missing: { id: string; label: string }[];
  /** `mustExist` paths whose stored value no longer resolves on disk. */
  brokenPaths: { id: string; label: string }[];
  /** The check itself couldn't be made, so the two lists above can't be trusted. */
  failed: boolean;
}

const PATH_TYPES = new Set(["path", "directory", "file"]);

/**
 * The setup gaps of each running project plugin that declares required settings
 * or paths that must exist: the same required-settings read the plugin's own
 * setup strip makes, plus a probe of each stored `mustExist` path. Keyed by
 * instance id, and re-read whenever that plugin's settings change.
 */
export function usePluginSettingsGaps(
  plugins: readonly ProjectPluginInfo[],
  folderTrusted: boolean
): { gaps: ReadonlyMap<string, SettingsGaps>; recheck: () => void } {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const [gaps, setGaps] = useState<ReadonlyMap<string, SettingsGaps>>(() => new Map());
  const [attempt, setAttempt] = useState(0);
  const candidates = useMemo(
    () =>
      plugins.flatMap((p) => {
        if (p.instanceId === undefined || !isProjectPluginRunning(p, folderTrusted)) return [];
        const defs = p.settings ?? [];
        const paths = defs.filter(
          (def) => def.mustExist === true && PATH_TYPES.has(def.type ?? "string")
        );
        if (!defs.some((def) => def.required === true) && paths.length === 0) return [];
        return [
          {
            id: p.instanceId,
            required: defs.some((def) => def.required === true),
            paths: paths.map((def) => ({
              id: def.id,
              label: def.label ?? def.id,
              scope: def.scope ?? "user",
              fallback: typeof def.default === "string" ? def.default : "",
            })),
          },
        ];
      }),
    [plugins, folderTrusted]
  );

  useEffect(() => {
    const bridge = window.electron?.plugin;
    const targets = candidates;
    setGaps(new Map());
    if (targets.length === 0 || typeof bridge?.getRequiredSettingsStatus !== "function") return;
    let cancelled = false;
    // Each read stands on its own: one that fails marks the result incomplete
    // without discarding what the others found, so a known gap keeps its Set up.
    const check = async (target: (typeof targets)[number]): Promise<SettingsGaps> => {
      const gaps: SettingsGaps = { missing: [], brokenPaths: [], failed: false };
      const noteFailure = (err: unknown) => {
        gaps.failed = true;
        logError(`Failed to check settings for ${target.id}`, err);
      };
      if (target.required) {
        try {
          const status = await bridge.getRequiredSettingsStatus(target.id, projectId);
          gaps.missing = status.missing.map((id) => ({ id, label: status.labels[id] ?? id }));
          if (status.unreadable.length > 0) gaps.failed = true;
        } catch (err) {
          noteFailure(err);
        }
      }
      const scopes = [...new Set(target.paths.map((path) => path.scope))];
      for (const scope of scopes) {
        if (scope !== "user" && projectId === null) continue;
        let values: Record<string, unknown>;
        try {
          ({ values } = await bridge.getSettingValues(target.id, scope, projectId));
        } catch (err) {
          noteFailure(err);
          continue;
        }
        for (const path of target.paths.filter((p) => p.scope === scope)) {
          // The value the plugin actually uses: what is stored, else its default —
          // the same one its settings form checks.
          const stored = values[path.id];
          const effective = typeof stored === "string" ? stored : path.fallback;
          if (effective === "") continue;
          try {
            if (!(await bridge.pathExists(target.id, effective))) gaps.brokenPaths.push(path);
          } catch (err) {
            noteFailure(err);
          }
        }
      }
      return gaps;
    };
    const read = (target: (typeof targets)[number]) => {
      check(target)
        .then((next) => {
          if (!cancelled) setGaps((prev) => new Map(prev).set(target.id, next));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setGaps((prev) =>
            new Map(prev).set(target.id, { missing: [], brokenPaths: [], failed: true })
          );
          logError(`Failed to check settings for ${target.id}`, err);
        });
    };
    targets.forEach(read);
    const unsubscribe = bridge.onSettingsChanged?.((payload) => {
      const target = targets.find((t) => t.id === payload.pluginId);
      if (target) read(target);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [candidates, projectId, attempt]);

  return { gaps, recheck: () => setAttempt((n) => n + 1) };
}
