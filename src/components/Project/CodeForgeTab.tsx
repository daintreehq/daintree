import { useState, useEffect } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import type { RemoteInfo } from "@shared/types/ipc/forge";
import type { RegisteredForgeProvider } from "@shared/types/forge";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import type { SettingsSelectOption } from "@/components/Settings/SettingsSelect";

// Radix Select reserves the empty string, so "auto-detect" needs its own value.
const AUTO_DETECT = "__auto__";

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

  const remoteOptions: SettingsSelectOption[] = [
    { value: AUTO_DETECT, label: "Auto-detect" },
    ...remotes.map((r) => ({
      value: r.name,
      label: `${r.name}${r.parsedRepo ? ` — ${r.parsedRepo.owner}/${r.parsedRepo.repo}` : ""}`,
    })),
    ...(!savedRemoteKnown && forgeRemote
      ? [{ value: forgeRemote, label: `${forgeRemote} (unavailable)` }]
      : []),
  ];

  const providerOptions: SettingsSelectOption[] = [
    { value: AUTO_DETECT, label: "Auto-detect" },
    ...providers.map((p) => ({
      value: makeForgeProviderId(p.pluginId, p.contribution.id),
      label: p.contribution.name,
    })),
    ...(!savedProviderKnown && forgeProviderOverride !== null
      ? [{ value: forgeProviderOverride, label: `${forgeProviderOverride} (unavailable)` }]
      : []),
  ];

  const remoteDescription =
    "Auto-detect prefers origin, then any other remote a forge provider recognizes";
  const providerDescription =
    "Overrides the default provider for this project. Auto-detect uses the default provider from global Code forge settings, then the remote's hostname";

  return (
    <SettingsSection
      id="project-code-forge-remote"
      title="Remote and provider"
      description="Which remote and provider this project's issues, pull requests, and pulse data come from"
    >
      <SettingsGroup>
        {loading || error ? (
          <SettingsRow
            label="Forge remote"
            description={remoteDescription}
            control={
              loading ? (
                <span className="text-sm text-text-secondary">Loading remotes…</span>
              ) : (
                <span className="text-sm text-status-error">{error}</span>
              )
            }
          />
        ) : (
          <SettingsSelect
            label="Forge remote"
            description={remoteDescription}
            controlWidth="wide"
            value={forgeRemote || AUTO_DETECT}
            onValueChange={(value) =>
              onForgeRemoteChange(value === AUTO_DETECT ? undefined : value)
            }
            options={remoteOptions}
            isModified={!!forgeRemote}
            onReset={() => onForgeRemoteChange(undefined)}
          />
        )}

        {providersLoading || providersError ? (
          <SettingsRow
            label="Forge provider"
            description={providerDescription}
            control={
              providersLoading ? (
                <span className="text-sm text-text-secondary">Loading providers…</span>
              ) : (
                <span className="text-sm text-status-error">{providersError}</span>
              )
            }
          />
        ) : (
          <SettingsSelect
            label="Forge provider"
            description={providerDescription}
            controlWidth="wide"
            value={forgeProviderOverride ?? AUTO_DETECT}
            onValueChange={(value) =>
              onForgeProviderOverrideChange(value === AUTO_DETECT ? null : value)
            }
            options={providerOptions}
            isModified={forgeProviderOverride !== null}
            onReset={() => onForgeProviderOverrideChange(null)}
          />
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
