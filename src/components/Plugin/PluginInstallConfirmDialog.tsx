import { useEffect, useState } from "react";
import { Callout } from "@/components/ui/Callout";
import { FileArchive, Globe, Package, Users } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { BUILT_IN_PLUGIN_CAPABILITIES } from "@shared/types/plugin";
import type {
  BuiltInPluginCapability,
  LoadedPluginInfo,
  PluginArchiveManifestPreview,
  PluginAuthor,
} from "@shared/types/plugin";
import { pluralNoun, pluralize } from "@/lib/pluralize";
import { CAPABILITY_META, CapabilityRow, type CapabilitySeverity } from "./capabilityMeta";
import { PluginGlyphTile, pluginIconForIdentity } from "./pluginIcons";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { Badge } from "@/components/ui/badge";
import { useRemoteTrustSentence } from "./remotePluginTrust";
import { classifyArchiveReplacement, type ArchiveReplacementKind } from "./archiveReplacement";

// Read-time gate: a double-clicked archive opens this dialog without the user
// asking for it, and a URL's review lands when its download finishes, so the
// primary button stays disabled long enough that a click already in flight
// can't approve an install the user never read.
const CONFIRM_COOLDOWN_MS = 1_200;

// The manifest's displayName is attacker-controlled and only clamped to 200
// chars on main — far more than a dialog title can absorb (an unbroken run
// clips against the title edge). The identity card carries the full plugin ID,
// so the title only needs a recognisable prefix.
const TITLE_LABEL_MAX = 60;

const PRIVILEGE_WARNING =
  "Plugins run with full Node.js privileges — there's no sandbox and no signature check.";

// An archive installs into the user folder, so it is app-wide, not scoped to one
// project; a single grant answers for every project.
const SCOPE_WARNING =
  "It's installed for the whole app, not a single project, so it can be available in every project and a permission grant can apply to all of them.";

const INSTALL_DESCRIPTION = `Installing writes this archive into Daintree's plugins folder, replacing any installed plugin with the same ID. ${PRIVILEGE_WARNING} ${SCOPE_WARNING}`;

// A URL install is bound to installing fresh when nothing is installed under
// its id (#16776), so it never replaces one that turned up meanwhile.
const URL_INSTALL_DESCRIPTION = `Installing writes this archive into Daintree's plugins folder. ${PRIVILEGE_WARNING} ${SCOPE_WARNING}`;

// An installed copy the plugin manager can't list, because it didn't load.
const UNLISTED_REPLACEMENT_DESCRIPTION = `Installing replaces the copy of this plugin that's installed but couldn't be loaded. ${PRIVILEGE_WARNING} ${SCOPE_WARNING}`;

function replacementSentence(
  kind: ArchiveReplacementKind,
  installed: string,
  archive: string
): string {
  switch (kind) {
    case "upgrade":
      return `Installing replaces the installed v${installed} with this newer v${archive}.`;
    case "reinstall":
      return `v${installed} is already installed. Installing replaces it with this archive's copy of the same version.`;
    case "downgrade":
      return `This archive is older than the installed version. Installing replaces v${installed} with the older v${archive}.`;
    case "replace":
      return `Installing replaces the installed v${installed} with this archive's v${archive}.`;
  }
}

const REPLACEMENT_TAG: Record<ArchiveReplacementKind, string | null> = {
  upgrade: "Update",
  reinstall: "Reinstall",
  downgrade: "Downgrade",
  replace: null,
};

interface InstalledVersionLookup {
  /** The first read for this archive hasn't settled, so the copy can't say yet. */
  pending: boolean;
  /** `null` when nothing is installed under the archive's id, or the read failed. */
  installedVersion: string | null;
  /** No read for this archive has answered: `installedVersion` is a guess. */
  failed: boolean;
  /** Read again, after a failure. */
  retry: () => void;
}

/**
 * The installed plugin an approval would replace: a global, non-builtin row
 * under the archive's id. Disabled, blocklisted and load-errored installs still
 * count — their folder is what the installer swaps. A builtin is refused by the
 * installer instead, and a project plugin lives elsewhere.
 */
function findInstalledRow(
  list: readonly LoadedPluginInfo[],
  pluginId: string
): LoadedPluginInfo | undefined {
  return list.find(
    (row) => row.origin === "global" && !row.isBuiltin && row.instanceId === pluginId
  );
}

/**
 * What's installed under the current archive's id, read through
 * `plugin.list()` — which, like the install itself, answers for the host in a
 * window attached to one, so the comparison is against the machine the install
 * lands on. Keyed per review, not per plugin id: two queued archives of one
 * plugin each read what the previous approval left installed.
 *
 * `paused` holds the last answer while this dialog's own install runs: the
 * install's provenance push arrives before its reply, and re-reading there
 * would relabel the archive a reinstall just before the dialog closes.
 */
function useInstalledVersion(
  requestKey: string | null,
  pluginId: string | null,
  paused: boolean
): InstalledVersionLookup {
  const key = requestKey === null || pluginId === null ? null : `${requestKey}\u0000${pluginId}`;
  const [lookup, setLookup] = useState<{
    key: string;
    installedVersion: string | null;
    failed: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const canRead = typeof window.electron?.plugin?.list === "function";

  useEffect(() => {
    if (key === null || pluginId === null || paused) return;
    const plugin = window.electron?.plugin;
    if (typeof plugin?.list !== "function") return;

    let active = true;
    let started = 0;
    let committed = 0;
    const read = () => {
      const seq = ++started;
      // `Promise.resolve().then` so a bridge that throws synchronously settles
      // the read like a rejection instead of escaping the effect.
      Promise.resolve()
        .then(() => plugin.list())
        .then(
          (list) => {
            if (!active || seq < committed) return;
            committed = seq;
            setLookup({
              key,
              installedVersion: findInstalledRow(list, pluginId)?.manifest.version ?? null,
              failed: false,
            });
          },
          () => {
            // A failed first read releases an opened archive's confirm with
            // today's copy, and holds a URL install's (see `failed`); a failed
            // refresh keeps the answer already shown.
            if (!active) return;
            setLookup((prev) =>
              prev?.key === key ? prev : { key, installedVersion: null, failed: true }
            );
          }
        );
    };

    const off =
      typeof plugin.onProvenanceChanged === "function" ? plugin.onProvenanceChanged(read) : null;
    read();
    return () => {
      active = false;
      off?.();
    };
  }, [key, pluginId, paused, attempt]);

  const settled = lookup !== null && lookup.key === key ? lookup : null;
  return {
    pending: key !== null && canRead && settled === null,
    installedVersion: settled?.installedVersion ?? null,
    failed: settled?.failed ?? false,
    retry: () => setAttempt((n) => n + 1),
  };
}

/** Where the archive under review came from, as its identity card names it. */
export type PluginInstallConfirmSource =
  | { kind: "archive"; fileName: string }
  | {
      kind: "url";
      label: string;
      /** The installer would find this plugin installed, listed or not. */
      installedOnDisk: boolean;
    }
  | {
      /** A community catalog release (#16779), named by its repository. */
      kind: "catalog";
      /** The listed repository, as `github.com/{owner}/{repo}`. */
      repoLabel: string;
      installedOnDisk: boolean;
    };

export interface PluginInstallConfirmRequest {
  /** One per review: re-arms the cooldown and keys the installed-version read. */
  key: string;
  manifest: PluginArchiveManifestPreview;
  source: PluginInstallConfirmSource;
}

/** What the dialog showed when the user approved. */
export interface PluginInstallApproval {
  /** The dialog said this replaces an installed plugin, rather than installing fresh. */
  replacesInstalled: boolean;
}

interface PluginInstallConfirmDialogProps {
  /** The archive under review, or null when there is none. */
  request: PluginInstallConfirmRequest | null;
  onConfirm: (approval: PluginInstallApproval) => void;
  onClose: () => void;
  /** The approved install is running in this dialog. */
  isInstalling?: boolean;
  /** Why the approved install failed, shown inline so the confirm is the retry. */
  error?: string | null;
}

/**
 * The install-time disclosure of a `.dntr` archive, shared by every route that
 * asks before installing: an archive opened from the operating system (#11280)
 * and a URL install (#16776). Nothing has been installed when this opens: main
 * read the manifest out of the archive without extracting it, so the identity
 * and permissions below are the archive's actual declared contents rather than
 * a filename and a count.
 *
 * The body reuses the plugin manager's visual grammar (`PluginGlyphTile`,
 * `CapabilityRow`) so a capability reads identically at install time and in
 * the detail pane afterwards.
 *
 * Manifest strings are attacker-controlled (anything can be typed into a
 * `plugin.json`), so every one renders as a plain React text node; React's
 * interpolation escaping is the sanitisation.
 *
 * A URL install binds its approval to what this dialog shows: installing fresh
 * when nothing is installed under the id, replacing when something is. So a
 * read that failed holds its confirm (with a retry) instead of reading as "not
 * installed", and a change under an open review re-arms the cooldown so the
 * answer is read against the copy on screen.
 */
export function PluginInstallConfirmDialog({
  request,
  onConfirm,
  onClose,
  isInstalling = false,
  error = null,
}: PluginInstallConfirmDialogProps) {
  const remoteTrust = useRemoteTrustSentence(
    request ? `'${request.manifest.displayName || request.manifest.name}'` : "it"
  );
  const lookup = useInstalledVersion(
    request?.key ?? null,
    request?.manifest.name ?? null,
    isInstalling
  );
  const showLookupHint = useDeferredLoading(lookup.pending, UI_DOHERTY_THRESHOLD);

  if (request === null) {
    return (
      <ConfirmDialog
        isOpen={false}
        title=""
        confirmLabel="Install plugin"
        onConfirm={() => {}}
        variant="destructive"
      />
    );
  }

  // Both download routes confirm by downloading again, so each binds its
  // approval to what this dialog says about the installed copy.
  const bindsInstalledState = request.source.kind !== "archive";
  const lookupFailed = bindsInstalledState && lookup.failed;

  const label = request.manifest.displayName || request.manifest.name;
  // Code-point slicing, not .slice on code units — a clamp landing inside a
  // surrogate pair would render a replacement glyph in the title.
  const labelPoints = [...label];
  const titleLabel =
    labelPoints.length > TITLE_LABEL_MAX
      ? `${labelPoints.slice(0, TITLE_LABEL_MAX).join("")}…`
      : label;

  const { installedVersion } = lookup;
  // The list holds only plugins that loaded or were skipped, and the installer
  // counts a folder: an install that no longer loads is in the preview's own
  // probe alone, and the review says it replaces that copy.
  const replacesUnlisted =
    request.source.kind !== "archive" &&
    request.source.installedOnDisk &&
    installedVersion === null &&
    !lookup.pending &&
    !lookup.failed;
  const replacement: ArchiveReplacement | null =
    installedVersion === null
      ? null
      : {
          installedVersion,
          kind: classifyArchiveReplacement(installedVersion, request.manifest.version),
        };
  const effect =
    replacement !== null
      ? `${replacementSentence(replacement.kind, replacement.installedVersion, request.manifest.version)} ${PRIVILEGE_WARNING} ${SCOPE_WARNING}`
      : replacesUnlisted
        ? UNLISTED_REPLACEMENT_DESCRIPTION
        : bindsInstalledState
          ? URL_INSTALL_DESCRIPTION
          : INSTALL_DESCRIPTION;
  const description = remoteTrust ? `${effect} ${remoteTrust}` : effect;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={onClose}
      // min-w-0 + break-words: the heading is a flex row, so an unbroken
      // attacker-controlled run would otherwise refuse to shrink and clip
      // against the dialog edge; the clamp above bounds the wrapped height.
      title={<span className="min-w-0 break-words">{`Install '${titleLabel}'?`}</span>}
      // Versions are author-controlled, and semver admits a 256-character run
      // with nowhere to break — the same clip the title guards against.
      description={
        replacement === null ? description : <span className="break-words">{description}</span>
      }
      confirmLabel="Install plugin"
      cancelLabel="Cancel"
      onConfirm={() => onConfirm({ replacesInstalled: replacement !== null || replacesUnlisted })}
      isConfirmLoading={isInstalling}
      variant="destructive"
      hasPreview={true}
      confirmCooldownMs={CONFIRM_COOLDOWN_MS}
      cooldownKey={
        bindsInstalledState
          ? `${request.key}:${installedVersion ?? (replacesUnlisted ? "unlisted" : "")}`
          : request.key
      }
      // Held until the installed version is known, so a slow read (a cold
      // launch waits out the plugin catalog) can't let an approval land on
      // copy that's about to say this is a downgrade.
      confirmDisabled={lookup.pending || lookupFailed}
      hint={
        lookupFailed
          ? "Couldn't check which version is installed"
          : showLookupHint
            ? "Checking which version is installed…"
            : undefined
      }
      leadingAction={lookupFailed ? { label: "Retry", onClick: lookup.retry } : undefined}
      zIndex="nested"
    >
      {/* pt-3 + space-y-4: evens the vertical rhythm — the Body's space-y-3
          leaves the description closer to the card than the header is to the
          description, and the denser blocks below need the larger step. */}
      <div className="pt-3 space-y-4">
        <ArchiveIdentityCard
          request={request}
          replacement={replacement}
          replacesUnlisted={replacesUnlisted}
        />
        <ArchivePermissions
          capabilities={request.manifest.capabilities}
          permissionBypassAgents={request.manifest.permissionBypassAgents}
        />
        <ArchiveRecipes recipes={request.manifest.recipes} />
        <ArchiveProjectTemplates templates={request.manifest.projectTemplates} />
        {error !== null && (
          <Callout severity="error" role="alert">
            <p>{error}</p>
          </Callout>
        )}
      </div>
    </ConfirmDialog>
  );
}

/** "Jordan Reyes (maintainer), Priya N. +2 more" — capped so ten hostile 100-char authors can't swallow the dialog. */
function formatAuthors(authors: PluginAuthor[]): string {
  const shown = authors.slice(0, 3);
  const names = shown
    .map((author) => (author.role ? `${author.name} (${author.role})` : author.name))
    .join(", ");
  const rest = authors.length - shown.length;
  return rest > 0 ? `${names} +${rest} more` : names;
}

interface ArchiveReplacement {
  installedVersion: string;
  kind: ArchiveReplacementKind;
}

/**
 * Who this archive claims to be — the same identity block the catalog and
 * detail pane render (icon tile, display name, id), plus the facts unique to
 * install time: the version being written, where it came from, and the
 * installed version it replaces.
 */
function ArchiveIdentityCard({
  request,
  replacement,
  replacesUnlisted,
}: {
  request: PluginInstallConfirmRequest;
  replacement: ArchiveReplacement | null;
  replacesUnlisted: boolean;
}) {
  const { manifest, source } = request;
  const label = manifest.displayName || manifest.name;
  const tag = replacement === null ? null : REPLACEMENT_TAG[replacement.kind];

  return (
    <div className="rounded-[var(--radius-md)] border border-tint/[0.08] bg-tint/[0.04] px-3.5 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <PluginGlyphTile icon={pluginIconForIdentity(manifest.name, manifest.category)} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-text-primary truncate">{label}</span>
            <Badge size="xs" tone="outline" className="max-w-[10rem] font-mono tabular-nums">
              <span className="truncate">v{manifest.version}</span>
            </Badge>
          </div>
          <div className="mt-0.5 text-2xs font-mono text-text-secondary truncate">
            {manifest.name}
          </div>
        </div>
      </div>
      <div className="mt-3 pt-2.5 border-t border-tint/[0.08] space-y-1.5">
        {replacement !== null && (
          <div
            className="flex items-start gap-1.5 text-2xs text-text-secondary"
            data-testid="archive-installed-version"
          >
            <Package className="w-3 h-3 shrink-0 mt-[1.5px] text-text-secondary" aria-hidden />
            <span className="break-words min-w-0">
              Replaces installed{" "}
              <span className="font-mono break-all">v{replacement.installedVersion}</span>
            </span>
            {tag !== null && (
              <Badge size="xs" tone={replacement.kind === "downgrade" ? "warning" : "outline"}>
                {tag}
              </Badge>
            )}
          </div>
        )}
        {replacesUnlisted && (
          <div
            className="flex items-start gap-1.5 text-2xs text-text-secondary"
            data-testid="archive-installed-version"
          >
            <Package className="w-3 h-3 shrink-0 mt-[1.5px] text-text-secondary" aria-hidden />
            <span className="break-words min-w-0">
              Replaces an installed copy that couldn&rsquo;t be loaded
            </span>
          </div>
        )}
        <div
          className="flex items-start gap-1.5 text-2xs text-text-secondary"
          data-testid="archive-install-source"
        >
          {source.kind === "archive" ? (
            <FileArchive className="w-3 h-3 shrink-0 mt-[1.5px] text-text-secondary" aria-hidden />
          ) : (
            <Globe className="w-3 h-3 shrink-0 mt-[1.5px] text-text-secondary" aria-hidden />
          )}
          {source.kind === "catalog" ? (
            <span className="break-words min-w-0">
              Community listing from <span className="font-mono break-all">{source.repoLabel}</span>
              . Review checked the source and the bytes, not that the code is safe.
            </span>
          ) : (
            <span className="font-mono break-all min-w-0">
              {source.kind === "url" ? source.label : source.fileName}
            </span>
          )}
        </div>
        <div className="flex items-start gap-1.5 text-2xs text-text-secondary">
          <Users className="w-3 h-3 shrink-0 mt-[1.5px] text-text-secondary" aria-hidden />
          {manifest.authors.length > 0 ? (
            <span className="break-words min-w-0">{formatAuthors(manifest.authors)}</span>
          ) : (
            <span className="italic text-text-placeholder">No authors declared</span>
          )}
        </div>
      </div>
    </div>
  );
}

const SEVERITY_RANK: Record<CapabilitySeverity, number> = { danger: 0, warning: 1, neutral: 2 };

/**
 * Recipes the archive contributes (#11860). A recipe runs shell commands and
 * launches agents, but needs no capability to declare — so this block is the
 * only place the user sees them before approving. Kept separate from
 * Permissions rather than folded in: these are contributions, not grants, and
 * showing them as permissions would misdescribe both.
 */
function ArchiveRecipes({ recipes }: { recipes: { count: number; names: string[] } }) {
  if (recipes.count === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className={SECTION_LABEL_CLASS}>Recipes</h4>
      <p className="text-xs text-text-secondary">
        Adds {recipes.count} launch {recipes.count === 1 ? "recipe" : "recipes"}, available in every
        project. Each starts terminals that run commands or agents.
      </p>
      {/* Every name, bounded by the viewport rather than by the data. The list
          used to arrive pre-truncated at ten with "+N more" underneath, which
          on a D2 confirm counts executable content the user can't read before
          approving it (#12001). A scrollable region with no focusable children
          has to be keyboard-reachable in its own right (WCAG 2.1.1), and the
          fades are what say the list continues. */}
      <ScrollShadow
        className="max-h-[132px]"
        scrollClassName="scroll-py-6"
        tabIndex={0}
        role="region"
        aria-label={`${recipes.count} contributed ${recipes.count === 1 ? "recipe" : "recipes"}`}
        data-testid="archive-recipe-list"
      >
        <ul className="space-y-1">
          {recipes.names.map((name, index) => (
            <li
              key={`${name}-${index}`}
              className="text-xs text-text-secondary break-words min-w-0"
            >
              {name}
            </li>
          ))}
        </ul>
      </ScrollShadow>
    </div>
  );
}

/**
 * Project templates the archive contributes (#13825). A template writes files
 * only after the Create project dialog lists every one, so the titles are
 * enough here — except for a project plugin inside a template, which asks for
 * trust when that project first opens and so is named before install.
 */
function ArchiveProjectTemplates({
  templates,
}: {
  templates: PluginArchiveManifestPreview["projectTemplates"];
}) {
  if (templates.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className={SECTION_LABEL_CLASS}>Project templates</h4>
      <p className="text-xs text-text-secondary">
        Adds {pluralize(templates.length, "template")} to Create project. A template copies its
        files into a new folder after showing you each one.
      </p>
      <ScrollShadow
        className="max-h-[132px]"
        scrollClassName="scroll-py-6"
        tabIndex={0}
        role="region"
        aria-label={pluralize(templates.length, "contributed template")}
        data-testid="archive-template-list"
      >
        <ul className="space-y-1">
          {templates.map((template, index) => (
            <li
              key={`${template.title}-${index}`}
              className="text-xs text-text-secondary break-words min-w-0"
            >
              {template.title}
              {template.projectPlugins.length > 0 && (
                <span>
                  {" "}
                  — includes {pluralNoun(template.projectPlugins.length, "project plugin")}{" "}
                  {template.projectPlugins.map((name, pluginIndex) => (
                    <span key={`${name}-${pluginIndex}`}>
                      {pluginIndex > 0 && ", "}
                      <span className="font-mono text-text-primary">{name}</span>
                    </span>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      </ScrollShadow>
      {templates.some((template) => template.projectPlugins.length > 0) && (
        <p className="text-xs text-text-secondary">
          A project plugin from a template stays off until you trust it when the new project first
          opens.
        </p>
      )}
    </div>
  );
}

/**
 * What this archive asks to do, in the exact rows the detail pane's
 * Permissions tab uses — risk first, so the reason to hesitate is the first
 * thing read. Filtered through the built-in list (not the raw manifest array)
 * so duplicates collapse and ordering never depends on declaration order.
 */
function ArchivePermissions({
  capabilities,
  permissionBypassAgents,
}: {
  capabilities: readonly string[];
  permissionBypassAgents: readonly string[];
}) {
  const declared = new Set(capabilities);
  const granted = BUILT_IN_PLUGIN_CAPABILITIES.filter((c) => declared.has(c)).sort(
    (a, b) =>
      SEVERITY_RANK[CAPABILITY_META[a].severity] - SEVERITY_RANK[CAPABILITY_META[b].severity]
  );
  const worst: CapabilitySeverity = granted.some((c) => CAPABILITY_META[c].severity === "danger")
    ? "danger"
    : granted.some((c) => CAPABILITY_META[c].severity === "warning")
      ? "warning"
      : "neutral";

  return (
    <div className="space-y-2">
      <h4 className={SECTION_LABEL_CLASS}>Permissions</h4>
      {granted.length === 0 ? (
        <p className="text-xs text-text-secondary">No special permissions</p>
      ) : (
        <>
          {worst === "danger" && (
            <Callout severity="danger">
              <p>Can run arbitrary commands on your machine</p>
            </Callout>
          )}
          {worst === "warning" && (
            <Callout severity="warning">
              <p>Requests sensitive permissions — review before installing</p>
            </Callout>
          )}
          <ul className="space-y-2 pt-0.5">
            {granted.map((capability: BuiltInPluginCapability) => (
              <CapabilityRow
                key={capability}
                capability={capability}
                permissionBypassAgents={permissionBypassAgents}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
