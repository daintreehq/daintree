import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Route } from "lucide-react";
import type {
  ForgeProviderEntry,
  ForgeProviderResolutionVia,
  ResolvedForgeProvider,
} from "@shared/types";
import type { RemoteInfo } from "@shared/types/ipc/forge";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useProjectStore } from "@/store";
import { useDohertyGate } from "@/hooks";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import { resolveForgeRemote } from "@shared/utils/forgeRemoteSelection";
import { extractHostname, hostnameMatchesAny } from "@shared/utils/forgeHostnames";
import { logError } from "@/utils/logger";

// Non-empty sentinel because Radix's `SelectItem` rejects an empty string value
// (it reserves `""` to clear the selection and show the placeholder). Mapped
// to `null` at the IPC boundary in `handleChange`.
const AUTO_DETECT_VALUE = "__auto-detect__";
const AUTO_DETECT_LABEL = "No global default (auto-detect from hostname)";

interface ForgeSettings {
  defaultProviderId: string | null;
}

const DEFAULT_SETTINGS: ForgeSettings = { defaultProviderId: null };

interface RemoteRouting {
  remote: RemoteInfo;
  resolved: ResolvedForgeProvider;
}

/**
 * Which remote the project actually routes through (#11408) — the same
 * selection main and the workspace host run, replayed here so the panel can
 * label it.
 *
 * `isSupportedRemote` must mirror main's `listMatchingProviders(url).length > 0`
 * EXACTLY, which is a hostname match against the registered providers and
 * nothing more. Using each row's full `resolved.entry` instead would be a
 * stricter test (it also applies the override/global-default chain) and the
 * panel would then label a different remote than main actually uses.
 */
function findLiveRemoteName(
  rows: RemoteRouting[],
  forgeRemote: string | null,
  providers: ForgeProviderEntry[]
): string | null {
  const { remote } = resolveForgeRemote({
    remotes: rows.map(({ remote: r }) => ({ name: r.name, fetchUrl: r.fetchUrl })),
    forgeRemote,
    isSupportedRemote: (url) => {
      const hostname = extractHostname(url);
      if (hostname === null) return false;
      return providers.some((p) => hostnameMatchesAny(hostname, p.contribution.matches));
    },
  });
  return remote?.name ?? null;
}

const TOOLTIP_COPY: Record<ForgeProviderResolutionVia, string> = {
  override: "Resolved from this project's provider override.",
  default: "Resolved by the global default provider.",
  hostname: "Resolved by matching the remote hostname.",
};

const BADGE_LABEL: Record<ForgeProviderResolutionVia, string> = {
  override: "Override",
  default: "Default",
  hostname: "Hostname",
};

export function ForgeIntegrationsTab() {
  const [settings, setSettings] = useState<ForgeSettings>(DEFAULT_SETTINGS);
  const [providers, setProviders] = useState<ForgeProviderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const writeSeqRef = useRef(0);

  const activeProject = useProjectStore((s) => s.currentProject);
  const activeProjectId = activeProject?.id;
  const activeProjectPath = activeProject?.path;

  const [remotes, setRemotes] = useState<RemoteRouting[]>([]);
  const [forgeRemote, setForgeRemote] = useState<string | null>(null);
  const [remotesLoading, setRemotesLoading] = useState(false);
  const [remotesError, setRemotesError] = useState<string | null>(null);
  // Mirror project id + remotes into refs so a `reresolveRemotes` call that was
  // dispatched on project A doesn't run with A's id against B's remotes after
  // an active-project switch lands between the settings write and its reply.
  // `reresolveRemotes` reads both refs and is itself stable, so the callback
  // captured by `handleChange` always picks up the current values.
  const activeProjectIdRef = useRef<string | undefined>(activeProjectId);
  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);
  const remotesRef = useRef<RemoteRouting[]>([]);
  useEffect(() => {
    remotesRef.current = remotes;
  }, [remotes]);
  // Records the project whose remotes the current state reflects. Set inside the
  // load effect, so during the render frame *before* that effect commits
  // `remotesLoading=true` it still holds the previous project's id. That frame —
  // on initial mount and on every project switch — is exactly when `remotes` is
  // `[]` but no load flag is set yet; comparing it to `activeProjectId` lets us
  // treat the pre-effect window as pending and avoid painting a false empty
  // state for the freshly selected project (#9990).
  const remotesLoadedForRef = useRef<string | undefined>(undefined);
  // Defer the "Loading remotes…" text past the Doherty threshold so fast IPC
  // resolutions don't flash a loading state for sub-400ms work.
  const showRemotesLoading = useDohertyGate(remotesLoading);
  // Raw, un-gated "a load is or is about to be in flight" signal. Covers both
  // the active load (`remotesLoading`) and the pre-effect render frame where the
  // active project just changed but the load effect hasn't committed yet.
  const remotesPending =
    remotesLoading || (activeProjectId != null && remotesLoadedForRef.current !== activeProjectId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([window.electron.forge.getSettings(), window.electron.forge.getProviders()])
      .then(([loadedSettings, loadedProviders]) => {
        if (cancelled) return;
        setSettings(loadedSettings);
        setProviders(loadedProviders);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatErrorMessage(err, "Couldn't load forge integrations"));
        logError("Failed to load forge integration settings", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load remotes + per-remote resolution whenever the active project changes.
  // Single effect keyed on [activeProjectId, activeProjectPath] avoids the
  // ordered-effects trap from #4958 where separate effects sharing a `cancelled`
  // flag could fire out of expected order.
  useEffect(() => {
    if (!activeProjectId || !activeProjectPath) {
      remotesLoadedForRef.current = activeProjectId;
      setRemotes([]);
      setRemotesLoading(false);
      setRemotesError(null);
      return;
    }
    remotesLoadedForRef.current = activeProjectId;
    let cancelled = false;
    setRemotesLoading(true);
    setRemotesError(null);
    setRemotes([]);

    (async () => {
      try {
        const loadedRemotes = await window.electron.project.listRemotes(activeProjectPath);
        if (cancelled) return;
        if (loadedRemotes.length === 0) {
          setRemotes([]);
          setForgeRemote(null);
          return;
        }
        // Which remote this project routes through depends on its `forgeRemote`
        // setting; a read failure just means "auto-detect" (#11408).
        const projectSettings = await window.electron.project
          .getSettings(activeProjectId)
          .catch(() => null);
        if (cancelled) return;
        setForgeRemote(projectSettings?.forgeRemote ?? projectSettings?.githubRemote ?? null);
        const resolutions = await Promise.allSettled(
          loadedRemotes.map((remote) =>
            window.electron.forge.resolveProvider(activeProjectId, remote.fetchUrl)
          )
        );
        if (cancelled) return;
        const next: RemoteRouting[] = loadedRemotes.map((remote, idx) => {
          const result = resolutions[idx];
          if (result?.status === "fulfilled") {
            return { remote, resolved: result.value };
          }
          return { remote, resolved: { entry: null, resolvedVia: null } };
        });
        setRemotes(next);
      } catch (err) {
        if (cancelled) return;
        setRemotesError(formatErrorMessage(err, "Couldn't read git remotes"));
        logError("Failed to load forge routing for active project", err);
      } finally {
        if (!cancelled) setRemotesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeProjectPath]);

  const selectValue = settings.defaultProviderId ?? AUTO_DETECT_VALUE;

  const options = useMemo<SettingsSelectOption[]>(() => {
    const base: SettingsSelectOption[] = [
      {
        value: AUTO_DETECT_VALUE,
        label: AUTO_DETECT_LABEL,
        description:
          "Pick the first installed provider whose hostname matches the project's git remote.",
      },
      ...providers.map((entry) => {
        const matches = entry.contribution.matches.join(", ");
        return {
          value: makeForgeProviderId(entry.pluginId, entry.contribution.id),
          label: entry.contribution.name,
          description: matches ? `Matches: ${matches}` : undefined,
        };
      }),
    ];
    const storedId = settings.defaultProviderId;
    if (
      storedId !== null &&
      storedId.length > 0 &&
      !providers.some(
        (entry) => makeForgeProviderId(entry.pluginId, entry.contribution.id) === storedId
      )
    ) {
      base.push({
        value: storedId,
        label: `Unknown provider (${storedId})`,
        description: "The plugin that registered this provider is not currently loaded.",
        disabled: true,
      });
    }
    return base;
  }, [providers, settings.defaultProviderId]);

  // Re-resolve all remotes after a settings write succeeds. Changing the
  // global default can shift the `resolvedVia` badge for remotes whose origin
  // currently resolves via "hostname" — the default tier now wins.
  const reresolveRemotes = useCallback(async () => {
    const currentProjectId = activeProjectIdRef.current;
    if (!currentProjectId) return;
    const currentRemotes = remotesRef.current.map((r) => r.remote);
    if (currentRemotes.length === 0) return;
    const resolutions = await Promise.allSettled(
      currentRemotes.map((remote) =>
        window.electron.forge.resolveProvider(currentProjectId, remote.fetchUrl)
      )
    );
    // Bail if the active project switched mid-flight — the project-change
    // effect already re-resolves remotes for the new project, so applying
    // these results would overwrite the correct ones.
    if (activeProjectIdRef.current !== currentProjectId) return;
    setRemotes(
      currentRemotes.map((remote, idx) => {
        const result = resolutions[idx];
        if (result?.status === "fulfilled") {
          return { remote, resolved: result.value };
        }
        return { remote, resolved: { entry: null, resolvedVia: null } };
      })
    );
  }, []);

  const handleChange = useCallback(
    async (value: string) => {
      const next = value === AUTO_DETECT_VALUE ? null : value;
      const seq = ++writeSeqRef.current;
      let previous: ForgeSettings | undefined;
      setSettings((current) => {
        previous = current;
        return { defaultProviderId: next };
      });
      setError(null);
      try {
        const result = await window.electron.forge.setDefaultProvider(next);
        if (seq !== writeSeqRef.current) return;
        setSettings({ defaultProviderId: result.defaultProviderId });
        // Refresh per-remote routing so the badges reflect the new default.
        void reresolveRemotes();
      } catch (err) {
        if (seq !== writeSeqRef.current) return;
        if (previous) setSettings(previous);
        setError(formatErrorMessage(err, "Couldn't save forge integrations"));
        logError("Failed to save default forge provider", err);
      }
    },
    [reresolveRemotes]
  );

  return (
    <div className="space-y-6">
      <SettingsSection
        icon={GitBranch}
        title="Default forge provider"
        description="Pick the forge provider used for newly opened projects. The per-project setting still wins when set; otherwise the resolver falls back to hostname auto-match."
        id="forge-default-provider"
      >
        <SettingsSelect
          label="Default provider"
          description={
            providers.length === 0 && !loading
              ? "No forge plugins are installed yet. Install a plugin that contributes a forge provider to choose a default."
              : undefined
          }
          scope="global"
          value={selectValue}
          onValueChange={(value) => {
            void handleChange(value);
          }}
          options={options}
          disabled={loading}
          placeholder={loading ? "Loading…" : AUTO_DETECT_LABEL}
          error={error ?? undefined}
        />
      </SettingsSection>

      <SettingsSection
        icon={Route}
        title="Active project routing"
        description="Shows which forge provider each git remote of the active project resolves to and why."
        id="forge-active-project-routing"
      >
        <ProjectRoutingPanel
          activeProjectName={activeProject?.name}
          activeProjectId={activeProjectId}
          providersInstalled={providers.length}
          providers={providers}
          providersLoading={loading}
          remotes={remotes}
          forgeRemote={forgeRemote}
          loading={showRemotesLoading}
          pending={remotesPending}
          error={remotesError}
        />
      </SettingsSection>
    </div>
  );
}

interface ProjectRoutingPanelProps {
  activeProjectName: string | undefined;
  activeProjectId: string | undefined;
  providersInstalled: number;
  /** Registered providers, used to replay main's hostname-match test. */
  providers: ForgeProviderEntry[];
  // Whether the top-level provider/settings load is still in flight. Used to
  // avoid asserting "no plugins installed" before the provider list resolves.
  providersLoading: boolean;
  remotes: RemoteRouting[];
  /** The project's selected forge remote name, or null for auto-detect. */
  forgeRemote: string | null;
  loading: boolean;
  // Raw (un-gated) loading flag. `loading` is the Doherty-gated flag that only
  // flips true past the 400ms threshold; during the sub-400ms window a load is
  // in flight but `loading` is still false and `remotes` has been reset to [],
  // which would otherwise flash the "no remotes" empty state on every load.
  pending: boolean;
  error: string | null;
}

function ProjectRoutingPanel({
  activeProjectName,
  activeProjectId,
  providersInstalled,
  providers,
  providersLoading,
  remotes,
  forgeRemote,
  loading,
  pending,
  error,
}: ProjectRoutingPanelProps) {
  if (!activeProjectId) {
    return (
      <p className="text-xs text-daintree-text/50">Open a project to view its forge routing.</p>
    );
  }

  // Sub-400ms in-flight window: a load is running but the Doherty gate hasn't
  // surfaced the loading text yet. Render nothing rather than the false empty
  // state. Scoped to remotes.length === 0 so an in-place refetch never blanks
  // an already-resolved list.
  if (pending && !loading && remotes.length === 0) {
    return null;
  }

  if (loading) {
    return <p className="text-xs text-daintree-text/40">Loading remotes…</p>;
  }

  if (error) {
    return <p className="text-xs text-status-error">{error}</p>;
  }

  if (remotes.length === 0) {
    return (
      <p className="text-xs text-daintree-text/50">
        {activeProjectName ?? "This project"} has no git remotes configured.
      </p>
    );
  }

  const liveRemoteName = findLiveRemoteName(remotes, forgeRemote, providers);

  return (
    <div className="space-y-2">
      {providersInstalled === 0 && !providersLoading && (
        <p className="text-xs text-daintree-text/50">
          No forge plugins are installed. Each remote shows as unmatched until a provider plugin is
          installed.
        </p>
      )}
      <ul className="space-y-2">
        {remotes.map(({ remote, resolved }) => (
          <li
            key={remote.name}
            className="flex items-center gap-3 justify-between rounded-[var(--radius-md)] border border-daintree-border/50 bg-overlay-subtle px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-daintree-text">{remote.name}</span>
                {remote.name === liveRemoteName && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium border border-daintree-border/60 text-daintree-text/70 cursor-default"
                        tabIndex={0}
                      >
                        Active
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {forgeRemote
                        ? "This project is set to use this remote for issues, PRs, and pulse data."
                        : "Auto-detected as this project's forge remote for issues, PRs, and pulse data."}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <p
                className="text-xs text-daintree-text/50 font-mono truncate"
                title={remote.fetchUrl}
              >
                {remote.fetchUrl}
              </p>
            </div>
            <RoutingBadge resolved={resolved} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoutingBadge({ resolved }: { resolved: ResolvedForgeProvider }) {
  if (resolved.entry === null || resolved.resolvedVia === null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-sm text-[10px] font-medium border border-daintree-border/60 text-daintree-text/50 cursor-default"
            tabIndex={0}
          >
            No match
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">
          No provider matches this remote. Install a plugin or pick a global default that covers
          this hostname.
        </TooltipContent>
      </Tooltip>
    );
  }
  const providerName = resolved.entry.contribution.name;
  const via = resolved.resolvedVia;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm text-[10px] font-medium border border-daintree-border/60 bg-status-info/10 text-daintree-text/80 cursor-default"
          tabIndex={0}
        >
          <span>{providerName}</span>
          <span className="text-daintree-text/50 uppercase tracking-wide">{BADGE_LABEL[via]}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">{TOOLTIP_COPY[via]}</TooltipContent>
    </Tooltip>
  );
}
