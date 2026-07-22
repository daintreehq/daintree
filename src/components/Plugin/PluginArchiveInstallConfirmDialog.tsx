import { useCallback, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { usePluginArchiveInstallStore } from "@/store/pluginArchiveInstallStore";
import type { PendingPluginArchiveInstall } from "@/store/pluginArchiveInstallStore";

// Read-time gate: a double-clicked archive opens this dialog without the user
// asking for it, so the primary button stays disabled long enough that a click
// already in flight can't approve an install the user never read.
const CONFIRM_COOLDOWN_MS = 1_200;

/**
 * Confirmation gate for a `.dntr` archive the user double-clicked (#11280).
 *
 * Singleton driven by the archive-install queue and mounted in
 * `ModalHostLayer`, sibling to the other plugin dialogs. Nothing has been
 * written to disk when this opens: main read the manifest out of the archive
 * without extracting it, so the identity and capabilities below are the
 * archive's actual declared contents rather than a filename and a count. Only
 * `plugin.installFromPath` — on approval — reaches the installer, and it
 * re-runs every trust gate in main.
 *
 * Manifest strings are attacker-controlled (anything can be typed into a
 * `plugin.json`), so every one renders as a plain React text node; React's
 * interpolation escaping is the sanitisation.
 */
export function PluginArchiveInstallConfirmDialog() {
  const current = usePluginArchiveInstallStore((state) => state.current);
  const resolveCurrent = usePluginArchiveInstallStore((state) => state.resolveCurrent);

  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a second confirm landing while `installFromPath` is in
  // flight: without it a double-click would resolve the current intent and
  // immediately approve whichever archive the queue promotes next.
  const inFlightRef = useRef(false);

  const dismiss = useCallback(() => {
    setError(null);
    setIsInstalling(false);
    inFlightRef.current = false;
    resolveCurrent();
  }, [resolveCurrent]);

  const handleConfirm = useCallback(async () => {
    if (inFlightRef.current || current === null) return;
    inFlightRef.current = true;
    setIsInstalling(true);
    setError(null);

    const label = current.manifest.displayName || current.manifest.name;
    try {
      const result = await window.electron.plugin.installFromPath(current.archivePath);
      if (result.status === "installed") {
        notify({
          type: "success",
          title: "Plugin installed",
          message: `${label} v${current.manifest.version} is ready to use.`,
        });
        dismiss();
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

  return (
    <ConfirmDialog
      isOpen={true}
      onClose={isInstalling ? undefined : dismiss}
      title={`Install '${label}'?`}
      description={`This writes v${current.manifest.version} from "${current.archiveFileName}" into Daintree's plugins folder, replacing any installed plugin with the ID ${current.manifest.name}. Plugins run with full Node.js privileges — there's no sandbox and no signature check.`}
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
      <ArchivePreview intent={current} />
      {error !== null && (
        <p className="mt-3 text-xs text-status-error" role="alert">
          {error}
        </p>
      )}
    </ConfirmDialog>
  );
}

function ArchivePreview({ intent }: { intent: PendingPluginArchiveInstall }) {
  const { manifest, archiveFileName } = intent;
  const authors = manifest.authors
    .map((author) => (author.role ? `${author.name} (${author.role})` : author.name))
    .join(", ");

  return (
    <dl className="mt-3 space-y-1.5 text-xs text-daintree-text/70">
      <PreviewRow label="Archive" value={archiveFileName} />
      <PreviewRow label="Plugin ID" value={manifest.name} />
      <PreviewRow label="Version" value={`v${manifest.version}`} />
      <PreviewRow label="Authors" value={authors || "Not declared"} />
      <PreviewRow
        label="Capabilities"
        value={manifest.capabilities.join(", ") || "None declared"}
      />
    </dl>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-daintree-text/50">{label}</dt>
      <dd className="min-w-0 break-words text-daintree-text">{value}</dd>
    </div>
  );
}
