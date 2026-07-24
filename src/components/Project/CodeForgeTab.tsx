import { useState, useEffect } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import type { RemoteInfo } from "@shared/types/ipc/forge";
import type { RegisteredForgeProvider } from "@shared/types/forge";

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

  const savedProviderKnown =
    forgeProviderOverride === null ||
    providers.some(
      (p) => makeForgeProviderId(p.pluginId, p.contribution.id) === forgeProviderOverride
    );

  return (
    <div id="project-code-forge-remote" className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-daintree-text mb-1">Forge remote</label>
        <p className="text-xs text-daintree-text/60 mb-2">
          Select which git remote to use for forge integration (issues, PRs, and pulse data).
          Auto-detect prefers a remote a forge provider recognises, favouring upstream over origin.
        </p>
        {loading ? (
          <div className="text-sm text-daintree-text/60">Loading remotes...</div>
        ) : error ? (
          <div className="text-sm text-status-error">{error}</div>
        ) : (
          <select
            value={forgeRemote || ""}
            onChange={(e) => onForgeRemoteChange(e.target.value || undefined)}
            className="w-full px-3 py-2 bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] text-sm text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent"
          >
            <option value="">Auto-detect</option>
            {remotes.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
                {r.parsedRepo ? ` — ${r.parsedRepo.owner}/${r.parsedRepo.repo}` : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-daintree-text mb-1">Forge provider</label>
        <p className="text-xs text-daintree-text/60 mb-2">
          Pin this project to a specific forge provider. Auto-detects from the remote URL when no
          override is set.
        </p>
        {providersLoading ? (
          <div className="text-sm text-daintree-text/60">Loading providers...</div>
        ) : providersError ? (
          <div className="text-sm text-status-error">{providersError}</div>
        ) : (
          <select
            value={forgeProviderOverride ?? ""}
            onChange={(e) =>
              onForgeProviderOverrideChange(e.target.value === "" ? null : e.target.value)
            }
            className="w-full px-3 py-2 bg-daintree-bg border border-daintree-border rounded-[var(--radius-md)] text-sm text-daintree-text focus:outline-hidden focus:ring-2 focus:ring-daintree-accent"
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
              <option value={forgeProviderOverride}>{forgeProviderOverride} (unavailable)</option>
            ) : null}
          </select>
        )}
      </div>
    </div>
  );
}
