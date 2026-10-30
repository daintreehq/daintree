import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CANOPY_LOCAL } from "@/components/Canopy/canopyTerms";
import { formatModelBytes } from "@/components/Canopy/CanopyStatusBar";
import { useCanopyStore } from "@/store/canopyStore";
import type { CanopyMode, CanopyModelInfo } from "@shared/types/ipc/canopy";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { SettingsSection } from "./SettingsSection";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";

export function CanopySettingsTab() {
  const snapshot = useCanopyStore((s) => s.snapshot);
  const mode = useCanopyStore((s) => s.mode);
  const applySnapshot = useCanopyStore((s) => s.applySnapshot);
  // One change at a time: the two switches act on one mode, and a second
  // flipped before the first lands would act on the mode the first replaced.
  // Held in a ref, not shown: a change takes a moment, too short to dim for.
  const pending = useRef(false);
  const [failure, setFailure] = useState<{
    run: () => Promise<Parameters<typeof applySnapshot>[0]>;
    message: string;
  } | null>(null);
  const [info, setInfo] = useState<CanopyModelInfo | null>(null);

  // Only what is on this machine: a failed look leaves the row out, nothing more.
  const loadModels = useCallback(() => {
    window.electron.canopy.getModel().then(setInfo, () => setInfo(null));
  }, []);

  // A download finishing changes what is on this machine.
  const modelStatus = snapshot?.model?.status;
  useEffect(() => {
    loadModels();
  }, [loadModels, modelStatus]);

  // A failure keeps the call it ran so Retry can run it again; a callback that
  // named itself as its own retry would be read before it is declared.
  const act = useCallback(
    (run: () => Promise<Parameters<typeof applySnapshot>[0]>) => {
      if (pending.current) return;
      pending.current = true;
      setFailure(null);
      run()
        .then(applySnapshot, (error: unknown) =>
          setFailure({ run, message: formatErrorMessage(error, "Try again in a moment.") })
        )
        .finally(() => {
          pending.current = false;
          loadModels();
        });
    },
    [applySnapshot, loadModels]
  );

  const setMode = useCallback(
    (next: CanopyMode) => act(() => window.electron.canopy.setMode(next)),
    [act]
  );
  const retryModel = useCallback(() => act(() => window.electron.canopy.retryModel()), [act]);
  const removeModels = useCallback(() => act(() => window.electron.canopy.removeModels()), [act]);

  const hidden = mode === "hidden";
  const activated = mode === "on";
  const model = snapshot?.model;
  const installed = info?.installed === true ? info : null;
  const installedSize = installed ? formatModelBytes(installed.bytes) : "";
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Reading"
        description={`One inbox of every agent, read off its screen. ${CANOPY_LOCAL}`}
        id="canopy-activation"
      >
        {failure && (
          <SettingsLoadErrorBanner
            title="Couldn't change Canopy"
            message={failure.message}
            onRetry={() => act(failure.run)}
          />
        )}
        <SettingsGroup>
          {/* Off is the user saying they don't want Canopy: every way in goes,
              this page aside, and nothing is read. */}
          <SettingsSwitchCard
            id="canopy-show"
            title="Show Canopy"
            subtitle="Its toolbar button, shortcut and command palette entry. Hiding it also stops reading."
            isEnabled={!hidden}
            onChange={() => setMode(hidden ? "unset" : "hidden")}
          />
          <SettingsDependents disabled={hidden} reason="Show Canopy to turn it on">
            <SettingsSwitchCard
              id="canopy-read-terminals"
              title="Read agent terminals"
              subtitle="Downloads a small model the first time. When off, Canopy lets the model go and deletes its readings."
              isEnabled={activated}
              onChange={() => setMode(activated ? "unset" : "on")}
            />
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      {activated && model && model.status !== "ready" && (
        <SettingsSection title="Model" id="canopy-model">
          <SettingsGroup>
            <SettingsRow
              id="canopy-model-status"
              label={
                model.status === "downloading"
                  ? "Downloading…"
                  : model.status === "failed"
                    ? "Download failed"
                    : "Not downloaded yet"
              }
              description={
                model.status === "downloading"
                  ? `${formatModelBytes(model.received)} of ${formatModelBytes(model.total)}. Rows show the screen's own words until it's done.`
                  : model.status === "failed"
                    ? model.error
                    : "Canopy downloads it as soon as it's on."
              }
              control={
                model.status === "downloading" ? null : (
                  <Button variant="outline" size="sm" onClick={retryModel}>
                    {model.status === "failed" ? "Retry" : "Download"}
                  </Button>
                )
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}

      {installed && (
        <SettingsSection title="Downloaded model" id="canopy-model-files">
          <SettingsGroup>
            <SettingsRow
              id="canopy-delete-model"
              label={installed.name}
              description={`${installedSize} on this computer${activated ? "" : ". Turning Canopy on again downloads it"}`}
              control={
                <Button variant="ghost-danger" size="sm" onClick={() => setConfirmDelete(true)}>
                  Delete model
                </Button>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}
      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        variant="destructive"
        title={`Delete '${installed?.name ?? ""}'?`}
        description={
          activated
            ? `Frees ${installedSize}. Canopy turns off, and turning it on again downloads the model.`
            : `Frees ${installedSize}. Turning Canopy on again downloads the model.`
        }
        confirmLabel="Delete model"
        cancelLabel="Cancel"
        onConfirm={() => {
          setConfirmDelete(false);
          removeModels();
        }}
      />
    </div>
  );
}
