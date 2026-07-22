import { useCallback, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, FileArchive, Users } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { usePluginArchiveInstallStore } from "@/store/pluginArchiveInstallStore";
import type { PendingPluginArchiveInstall } from "@/store/pluginArchiveInstallStore";
import { BUILT_IN_PLUGIN_CAPABILITIES } from "@shared/types/plugin";
import type { BuiltInPluginCapability, PluginAuthor } from "@shared/types/plugin";
import { CAPABILITY_META, CapabilityRow, type CapabilitySeverity } from "./capabilityMeta";
import { PluginGlyphTile, pluginIconForIdentity } from "./pluginIcons";

// Read-time gate: a double-clicked archive opens this dialog without the user
// asking for it, so the primary button stays disabled long enough that a click
// already in flight can't approve an install the user never read.
const CONFIRM_COOLDOWN_MS = 1_200;

// The manifest's displayName is attacker-controlled and only clamped to 200
// chars on main — far more than a dialog title can absorb (an unbroken run
// clips against the title edge). The identity card carries the full plugin ID,
// so the title only needs a recognisable prefix.
const TITLE_LABEL_MAX = 60;

/**
 * Confirmation gate for a `.dntr` archive the user double-clicked (#11280).
 *
 * Singleton driven by the archive-install queue and mounted in
 * `ModalHostLayer`, sibling to the other plugin dialogs. Nothing has been
 * written to disk when this opens: main read the manifest out of the archive
 * without extracting it, so the identity and permissions below are the
 * archive's actual declared contents rather than a filename and a count. Only
 * `plugin.installFromPath` — on approval — reaches the installer, and it
 * re-runs every trust gate in main.
 *
 * The body reuses the plugin manager's visual grammar (`PluginGlyphTile`,
 * `CapabilityRow`) so a capability reads identically at install time and in
 * the detail pane afterwards.
 *
 * Manifest strings are attacker-controlled (anything can be typed into a
 * `plugin.json`), so every one renders as a plain React text node; React's
 * interpolation escaping is the sanitisation.
 */
export function PluginArchiveInstallConfirmDialog() {
  const current = usePluginArchiveInstallStore((state) => state.current);
  const drop = usePluginArchiveInstallStore((state) => state.drop);

  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a second confirm landing while `installFromPath` is in
  // flight: without it a double-click would resolve the current intent and
  // immediately approve whichever archive the queue promotes next.
  const inFlightRef = useRef(false);

  // Always resolve by id, never "whatever is current". An install that settles
  // after this component remounted (ErrorBoundary reset) would otherwise
  // advance — and silently discard — the archive promoted in the meantime.
  const dismiss = useCallback(
    (intentId: string) => {
      setError(null);
      setIsInstalling(false);
      inFlightRef.current = false;
      drop(intentId);
    },
    [drop]
  );

  const handleConfirm = useCallback(async () => {
    if (inFlightRef.current || current === null) return;
    inFlightRef.current = true;
    setIsInstalling(true);
    setError(null);

    const { intentId, archivePath, manifest } = current;
    const label = manifest.displayName || manifest.name;
    try {
      const result = await window.electron.plugin.installFromPath(archivePath);
      if (result.status === "installed") {
        notify({
          type: "success",
          title: "Plugin installed",
          message: `${label} v${manifest.version} is ready to use.`,
          // One-shot: the user just approved this in a modal, so the toast
          // closes the loop without leaving an inbox row behind. `settings` is
          // a passive kind, so the priority override is load-bearing — without
          // it the transient toast would resolve to inbox-only and fire nowhere.
          transient: true,
          priority: "high",
          context: { eventKind: "settings" },
        });
        dismiss(intentId);
        return;
      }
      // Anything other than `installed` — including the `cancelled` /
      // `invalid-url` / `not-implemented` shapes a path install shouldn't
      // produce — is a failure. The dialog stays open with the reason inline so
      // the confirm button is the retry.
      setError(
        result.status === "failed"
          ? (result.errors[0]?.message ?? "The archive couldn't be installed.")
          : "The archive couldn't be installed."
      );
    } catch (err) {
      setError(formatErrorMessage(err, "the install failed unexpectedly"));
    } finally {
      setIsInstalling(false);
      inFlightRef.current = false;
    }
  }, [current, dismiss]);

  if (current === null) {
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

  const label = current.manifest.displayName || current.manifest.name;
  // Code-point slicing, not .slice on code units — a clamp landing inside a
  // surrogate pair would render a replacement glyph in the title.
  const labelPoints = [...label];
  const titleLabel =
    labelPoints.length > TITLE_LABEL_MAX
      ? `${labelPoints.slice(0, TITLE_LABEL_MAX).join("")}…`
      : label;

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={isInstalling ? undefined : () => dismiss(current.intentId)}
      // min-w-0 + break-words: the heading is a flex row, so an unbroken
      // attacker-controlled run would otherwise refuse to shrink and clip
      // against the dialog edge; the clamp above bounds the wrapped height.
      title={<span className="min-w-0 break-words">{`Install '${titleLabel}'?`}</span>}
      description="Installing writes this archive into Daintree's plugins folder, replacing any installed plugin with the same ID. Plugins run with full Node.js privileges — there's no sandbox and no signature check."
      confirmLabel="Install plugin"
      cancelLabel="Cancel"
      onConfirm={() => void handleConfirm()}
      isConfirmLoading={isInstalling}
      variant="destructive"
      hasPreview={true}
      confirmCooldownMs={CONFIRM_COOLDOWN_MS}
      cooldownKey={current.intentId}
      zIndex="nested"
    >
      {/* pt-3 + space-y-4: evens the vertical rhythm — the Body's space-y-3
          leaves the description closer to the card than the header is to the
          description, and the denser blocks below need the larger step. */}
      <div className="pt-3 space-y-4">
        <ArchiveIdentityCard intent={current} />
        <ArchivePermissions capabilities={current.manifest.capabilities} />
        {error !== null && (
          <div
            role="alert"
            className="flex items-start gap-2 px-2.5 py-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20"
          >
            <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
            <p className="text-[11px] text-status-danger break-words min-w-0">{error}</p>
          </div>
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

/**
 * Who this archive claims to be — the same identity block the catalog and
 * detail pane render (icon tile, display name, id), plus the two facts unique
 * to install time: the version being written and the file it came from.
 */
function ArchiveIdentityCard({ intent }: { intent: PendingPluginArchiveInstall }) {
  const { manifest, archiveFileName } = intent;
  const label = manifest.displayName || manifest.name;

  return (
    <div className="rounded-[var(--radius-md)] border border-tint/[0.08] bg-tint/[0.04] px-3.5 py-3">
      <div className="flex items-center gap-3 min-w-0">
        <PluginGlyphTile icon={pluginIconForIdentity(manifest.name, manifest.category)} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-daintree-text truncate">{label}</span>
            <span className="inline-block shrink-0 px-1.5 py-0.5 rounded-sm text-[10px] font-mono tabular-nums bg-overlay-subtle border border-daintree-border/50 text-daintree-text/60 max-w-[10rem] truncate">
              v{manifest.version}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] font-mono text-daintree-text/45 truncate">
            {manifest.name}
          </div>
        </div>
      </div>
      <div className="mt-3 pt-2.5 border-t border-tint/[0.08] space-y-1.5">
        <div className="flex items-start gap-1.5 text-[11px] text-daintree-text/50">
          <FileArchive className="w-3 h-3 shrink-0 mt-[1.5px] text-daintree-text/35" aria-hidden />
          <span className="font-mono break-all min-w-0">{archiveFileName}</span>
        </div>
        <div className="flex items-start gap-1.5 text-[11px] text-daintree-text/50">
          <Users className="w-3 h-3 shrink-0 mt-[1.5px] text-daintree-text/35" aria-hidden />
          {manifest.authors.length > 0 ? (
            <span className="break-words min-w-0">{formatAuthors(manifest.authors)}</span>
          ) : (
            <span className="italic text-daintree-text/35">No authors declared</span>
          )}
        </div>
      </div>
    </div>
  );
}

const SEVERITY_RANK: Record<CapabilitySeverity, number> = { danger: 0, warning: 1, neutral: 2 };

/**
 * What this archive asks to do, in the exact rows the detail pane's
 * Permissions tab uses — risk first, so the reason to hesitate is the first
 * thing read. Filtered through the built-in list (not the raw manifest array)
 * so duplicates collapse and ordering never depends on declaration order.
 */
function ArchivePermissions({ capabilities }: { capabilities: readonly string[] }) {
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
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-daintree-text/40">
        Permissions
      </h4>
      {granted.length === 0 ? (
        <p className="text-xs text-daintree-text/40">No special permissions</p>
      ) : (
        <>
          {worst === "danger" && (
            <div className="flex items-start gap-2 px-2.5 py-2 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
              <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
              <p className="text-[11px] text-status-danger break-words">
                Can run arbitrary commands on your machine
              </p>
            </div>
          )}
          {worst === "warning" && (
            <div className="flex items-start gap-2 px-2.5 py-2 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20">
              <AlertTriangle className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5" />
              <p className="text-[11px] text-status-warning break-words">
                Requests sensitive permissions — review before installing
              </p>
            </div>
          )}
          <ul className="space-y-2 pt-0.5">
            {granted.map((capability: BuiltInPluginCapability) => (
              <CapabilityRow key={capability} capability={capability} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
