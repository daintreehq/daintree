import { useCallback, useRef, useState } from "react";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { usePluginArchiveInstallStore } from "@/store/pluginArchiveInstallStore";
import { PluginInstallConfirmDialog } from "./PluginInstallConfirmDialog";

/**
 * Confirmation gate for a `.dntr` archive the user double-clicked (#11280).
 *
 * Singleton driven by the archive-install queue and mounted in
 * `ModalHostLayer`, sibling to the other plugin dialogs. The disclosure itself
 * is {@link PluginInstallConfirmDialog}, shared with URL installs; this owns the
 * queue and the install. Only `plugin.installFromPath` — on approval — reaches
 * the installer, and it re-runs every trust gate in main.
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

  return (
    <PluginInstallConfirmDialog
      request={
        current === null
          ? null
          : {
              key: current.intentId,
              manifest: current.manifest,
              source: { kind: "archive", fileName: current.archiveFileName },
            }
      }
      onConfirm={() => void handleConfirm()}
      onClose={() => {
        if (current !== null) dismiss(current.intentId);
      }}
      isInstalling={isInstalling}
      error={error}
    />
  );
}
