import { useState, useEffect } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import { forgeProviderServesRole } from "@shared/utils/forgeProviderRoles";
import type { RemoteInfo } from "@shared/types/ipc/forge";
import type { RegisteredForgeProvider } from "@shared/types/forge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsGroup,
  SettingsInlineError,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsSelect } from "@/components/Settings/SettingsSelect";
import type { SettingsSelectOption } from "@/components/Settings/SettingsSelect";

// Radix Select reserves the empty string, so "auto-detect" needs its own value.
const AUTO_DETECT = "__auto__";
const USE_CODE_FORGE = "__code__";

// A provider that can't run (an installed plugin's) stays listed so a stored
// choice still reads correctly, but can't be picked again.
function providerOption(p: RegisteredForgeProvider): SettingsSelectOption {
  const value = makeForgeProviderId(p.pluginId, p.contribution.id);
  return p.unavailableReason
    ? {
        value,
        label: `${p.contribution.name} (unavailable)`,
        description: p.unavailableReason,
        disabled: true,
      }
    : { value, label: p.contribution.name };
}

function findProvider(
  providers: RegisteredForgeProvider[],
  id: string | null
): RegisteredForgeProvider | undefined {
  if (id === null) return undefined;
  return providers.find((p) => makeForgeProviderId(p.pluginId, p.contribution.id) === id);
}

interface CodeForgeTabProps {
  forgeRemote: string | undefined;
  onForgeRemoteChange: (remote: string | undefined) => void;
  forgeProviderOverride: string | null;
  onForgeProviderOverrideChange: (providerId: string | null) => void;
  issueProviderOverride: string | null;
  onIssueProviderOverrideChange: (providerId: string | null) => void;
  projectPath: string | undefined;
}

export function CodeForgeTab({
  forgeRemote,
  onForgeRemoteChange,
  forgeProviderOverride,
  onForgeProviderOverrideChange,
  issueProviderOverride,
  onIssueProviderOverrideChange,
  projectPath,
}: CodeForgeTabProps) {
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remotesAttempt, setRemotesAttempt] = useState(0);
  const [providersAttempt, setProvidersAttempt] = useState(0);

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
  }, [projectPath, remotesAttempt]);

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
  }, [providersAttempt]);

  if (!projectPath) return null;

  const savedRemoteKnown = !forgeRemote || remotes.some((r) => r.name === forgeRemote);

  // An issues-only provider has nothing to serve as the code forge, and a
  // code-only one nothing to serve as the issues provider.
  const codeProviders = providers.filter((p) => forgeProviderServesRole(p.contribution, "code"));
  const issueProviders = providers.filter((p) => forgeProviderServesRole(p.contribution, "issues"));

  const savedProvider = findProvider(codeProviders, forgeProviderOverride);
  const savedProviderKnown = forgeProviderOverride === null || savedProvider !== undefined;

  const savedIssueProvider = findProvider(issueProviders, issueProviderOverride);
  const savedIssueProviderKnown = issueProviderOverride === null || savedIssueProvider !== undefined;

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
    ...codeProviders.map(providerOption),
    ...(!savedProviderKnown && forgeProviderOverride !== null
      ? [{ value: forgeProviderOverride, label: `${forgeProviderOverride} (unavailable)` }]
      : []),
  ];

  const issueProviderOptions: SettingsSelectOption[] = [
    { value: USE_CODE_FORGE, label: "Use forge provider" },
    ...issueProviders.map(providerOption),
    ...(!savedIssueProviderKnown && issueProviderOverride !== null
      ? [{ value: issueProviderOverride, label: `${issueProviderOverride} (unavailable)` }]
      : []),
  ];

  const remoteDescription =
    "Auto-detect prefers origin, then any other remote a forge provider recognizes";
  const providerDescription =
    "Overrides the default provider for this project. Auto-detect uses the default provider from global Code forge settings, then the remote's hostname";
  const issueProviderDescription =
    "Where this project's issues come from, such as an issue tracker paired with the forge. Pull requests and CI stay with the forge provider";

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
                <SettingsInlineError
                  action={
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setRemotesAttempt((n) => n + 1)}
                      className="-my-1 shrink-0"
                    >
                      Retry
                    </Button>
                  }
                >
                  {error}
                </SettingsInlineError>
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
                <SettingsInlineError
                  action={
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setProvidersAttempt((n) => n + 1)}
                      className="-my-1 shrink-0"
                    >
                      Retry
                    </Button>
                  }
                >
                  {providersError}
                </SettingsInlineError>
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
            error={savedProvider?.unavailableReason}
            isModified={forgeProviderOverride !== null}
            onReset={() => onForgeProviderOverrideChange(null)}
          />
        )}

        {/* Loading and error states are the provider row's; a second copy here
            would repeat the same message and retry. */}
        {!providersLoading && !providersError && (
          <SettingsSelect
            label="Issues provider"
            description={issueProviderDescription}
            controlWidth="wide"
            value={issueProviderOverride ?? USE_CODE_FORGE}
            onValueChange={(value) =>
              onIssueProviderOverrideChange(value === USE_CODE_FORGE ? null : value)
            }
            options={issueProviderOptions}
            error={savedIssueProvider?.unavailableReason}
            isModified={issueProviderOverride !== null}
            onReset={() => onIssueProviderOverrideChange(null)}
          />
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}
