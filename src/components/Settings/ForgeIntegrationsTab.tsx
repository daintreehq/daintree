import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ForgeProviderEntry,
  ForgeProviderResolutionVia,
  ResolvedForgeProvider,
} from "@shared/types";
import type { RemoteInfo } from "@shared/types/ipc/forge";
import { SettingsSection } from "./SettingsSection";
import { SettingsEmptyRow, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { Badge } from "@/components/ui/badge";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
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
const AUTO_DETECT_LABEL = "Auto-detect";

interface ForgeSettings {
  defaultProviderId: string | null;
}

const DEFAULT_SETTINGS: ForgeSettings = { defaultProviderId: null };

interface RemoteRouting {
  remote: RemoteInfo;
  resolved: ResolvedForgeProvider;
  /** The resolution call itself failed — not the same answer as "no provider matches". */
  failed?: boolean;
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

/** Why a remote resolved the way it did, in the words of the precedence it follows. */
const VIA_LABEL: Record<ForgeProviderResolutionVia, string> = {
  override: "project setting",
  default: "default provider",
  hostname: "hostname",
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
          return { remote, resolved: { entry: null, resolvedVia: null }, failed: true };
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
        description: "The first installed provider whose hostname matches the remote",
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
        return { remote, resolved: { entry: null, resolvedVia: null }, failed: true };
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
    <div className="space-y-8">
      <SettingsSection
        title="Provider routing"
        description="A project uses its own provider setting first, then the default below, then whichever provider recognizes the remote's hostname"
      >
        <SettingsGroup id="forge-default-provider">
          <SettingsSelect
            label="Default provider"
            description={
              providers.length === 0 && !loading
                ? "No forge plugins are installed yet. Install one that contributes a forge provider to choose a default"
                : "For every project without its own provider setting"
            }
            value={selectValue}
            onValueChange={(value) => {
              void handleChange(value);
            }}
            options={options}
            disabled={loading}
            placeholder={loading ? "Loading…" : AUTO_DETECT_LABEL}
            error={error ?? undefined}
          />
        </SettingsGroup>
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
  const groupLabel = activeProjectName ? `${activeProjectName} remotes` : "Active project remotes";
  const shell = (children: ReactNode) => (
    <SettingsGroup label={groupLabel} id="forge-active-project-routing">
      {children}
    </SettingsGroup>
  );

  if (!activeProjectId) {
    return shell(
      <SettingsEmptyRow>Open a project to see which provider each remote uses</SettingsEmptyRow>
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
    return shell(<SettingsEmptyRow>Loading remotes…</SettingsEmptyRow>);
  }

  if (error) {
    return shell(
      <SettingsEmptyRow>
        <span className="text-status-error">{error}</span>
      </SettingsEmptyRow>
    );
  }

  if (remotes.length === 0) {
    return shell(
      <SettingsEmptyRow>
        Add a git remote to {activeProjectName ?? "this project"} to route its issues and pull
        requests
      </SettingsEmptyRow>
    );
  }

  const liveRemoteName = findLiveRemoteName(remotes, forgeRemote, providers);
  const noProviders = providersInstalled === 0 && !providersLoading;

  return shell(
    remotes.map(({ remote, resolved, failed }) => (
      <SettingsRow
        key={remote.name}
        label={remote.name}
        accessory={
          remote.name === liveRemoteName ? (
            <Badge size="xs">{forgeRemote ? "In use" : "In use · auto-detected"}</Badge>
          ) : undefined
        }
        description={
          <span className="block font-mono truncate" title={remote.fetchUrl}>
            {remote.fetchUrl}
          </span>
        }
        control={<RoutingResult resolved={resolved} failed={failed} noProviders={noProviders} />}
      />
    ))
  );
}

/** The provider a remote routes to and why, as plain text on the row's rail. */
function RoutingResult({
  resolved,
  failed,
  noProviders,
}: {
  resolved: ResolvedForgeProvider;
  failed?: boolean;
  noProviders: boolean;
}) {
  if (failed) {
    return <span className="text-xs text-status-error">Couldn&apos;t resolve</span>;
  }
  if (resolved.entry === null || resolved.resolvedVia === null) {
    return (
      <span className="text-right text-xs">
        <span className="block text-text-primary">No provider</span>
        <span className="block text-text-secondary">
          {noProviders ? "Install a forge plugin" : "Set one in Project settings"}
        </span>
      </span>
    );
  }
  return (
    <span className="text-right text-xs">
      <span className="block text-sm text-text-primary">{resolved.entry.contribution.name}</span>
      <span className="block text-text-secondary">by {VIA_LABEL[resolved.resolvedVia]}</span>
    </span>
  );
}
