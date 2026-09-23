import { useState, useEffect } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import type { RemoteInfo } from "@shared/types/ipc/forge";
import type { RegisteredForgeProvider } from "@shared/types/forge";
import { FIELD_INPUT } from "@/components/Worktree/views";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { cn } from "@/lib/utils";

interface CodeForgeTabProps {
  forgeRemote: string | undefined;
  onForgeRemoteChange: (remote: string | undefined) => void;
  forgeProviderOverride: string | null;
  onForgeProviderOverrideChange: (providerId: string | null) => void;
  projectPath: string | undefined;
}

export function CodeForgeTab({
  forgeRemote,
  onForgeRemoteChange,
  forgeProviderOverride,
  onForgeProviderOverrideChange,
  projectPath,
}: CodeForgeTabProps) {
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [providers, setProviders] = useState<RegisteredForgeProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) return;

    let cancelled = false;
    setLoading(true);
    setError(null);

    window.electron.project
      .listRemotes(projectPath)
      .then((result) => {
        if (!cancelled) {
          setRemotes(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(formatErrorMessage(err, "Failed to load git remotes"));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    // Sequence overlapping fetches: rapid enable/disable toggles can leave an
    // older getForgeProviders() response resolving after a newer one, and the
    // stale list must not win.
    let requestSeq = 0;

    const loadProviders = () => {
      const seq = ++requestSeq;
      setProvidersLoading(true);
      setProvidersError(null);

      window.electron.plugin
        .getForgeProviders()
        .then((result) => {
          if (!cancelled && seq === requestSeq) {
            setProviders(result);
            setProvidersLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled && seq === requestSeq) {
            setProvidersError(formatErrorMessage(err, "Failed to load forge providers"));
            setProvidersLoading(false);
          }
        });
    };

    loadProviders();
    // Refetch when a plugin is enabled/disabled at runtime so the provider
    // list reflects live forge-provider registry changes (e.g. toggling the
    // built-in GitHub plugin) without a remount. `provenance-changed` is the
    // same broadcast PluginsTab/usePluginManager listen to.
    const unsubscribe = window.electron.plugin.onProvenanceChanged(loadProviders);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!projectPath) return null;

  const savedRemoteKnown = !forgeRemote || remotes.some((r) => r.name === forgeRemote);

  const savedProviderKnown =
    forgeProviderOverride === null ||
    providers.some(
      (p) => makeForgeProviderId(p.pluginId, p.contribution.id) === forgeProviderOverride
    );

  return (
    <SettingsSection
      id="project-code-forge-remote"
      title="Remote and provider"
      description="Which remote and provider this project's issues, pull requests, and pulse data come from"
    >
      <SettingsGroup>
        <SettingsRow
          label="Forge remote"
          description="Auto-detect prefers origin, then any other remote a forge provider recognizes"
          control={({ labelId, descriptionId }) =>
            loading ? (
              <span className="text-sm text-text-secondary">Loading remotes…</span>
            ) : error ? (
              <span className="text-sm text-status-error">{error}</span>
            ) : (
              <select
                id="forge-remote-select"
                value={forgeRemote || ""}
                onChange={(e) => onForgeRemoteChange(e.target.value || undefined)}
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                className={cn(FIELD_INPUT, SETTINGS_CONTROL_WIDTH.wide, "pr-8")}
              >
                <option value="">Auto-detect</option>
                {remotes.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                    {r.parsedRepo ? ` — ${r.parsedRepo.owner}/${r.parsedRepo.repo}` : ""}
                  </option>
                ))}
                {!savedRemoteKnown && forgeRemote ? (
                  <option value={forgeRemote}>{forgeRemote} (unavailable)</option>
                ) : null}
              </select>
            )
          }
        />

        <SettingsRow
          label="Forge provider"
          description="Pins this project to one provider. Auto-detects from the remote URL when unset."
          control={({ labelId, descriptionId }) =>
            providersLoading ? (
              <span className="text-sm text-text-secondary">Loading providers…</span>
            ) : providersError ? (
              <span className="text-sm text-status-error">{providersError}</span>
            ) : (
              <select
                id="forge-provider-select"
                value={forgeProviderOverride ?? ""}
                onChange={(e) =>
                  onForgeProviderOverrideChange(e.target.value === "" ? null : e.target.value)
                }
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                className={cn(FIELD_INPUT, SETTINGS_CONTROL_WIDTH.wide, "pr-8")}
              >
                <option value="">Auto-detect</option>
                {providers.map((p) => {
                  const providerId = makeForgeProviderId(p.pluginId, p.contribution.id);
                  return (
                    <option key={providerId} value={providerId}>
                      {p.contribution.name}
                    </option>
                  );
                })}
                {!savedProviderKnown && forgeProviderOverride !== null ? (
                  <option value={forgeProviderOverride}>
                    {forgeProviderOverride} (unavailable)
                  </option>
                ) : null}
              </select>
            )
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
