import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CANOPY_LOCAL } from "@/components/Canopy/canopyTerms";
import { formatModelBytes } from "@/components/Canopy/CanopyStatusBar";
import { modelComparison, modelDescription } from "@/components/Canopy/canopyModelCopy";
import { useCanopyStore } from "@/store/canopyStore";
import type { CanopyMode, CanopyModelCatalogue } from "@shared/types/ipc/canopy";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { SettingsSection } from "./SettingsSection";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsChoicebox } from "./SettingsChoicebox";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";

export function CanopySettingsTab() {
  const snapshot = useCanopyStore((s) => s.snapshot);
  const mode = useCanopyStore((s) => s.mode);
  const applySnapshot = useCanopyStore((s) => s.applySnapshot);
  // One change at a time: the two switches act on one mode, and a second
  // flipped before the first lands would act on the mode the first replaced.
  // Held in a ref, not shown: a change takes a moment, too short to dim for.
  const pending = useRef(false);
  const [failure, setFailure] = useState<{ retry: () => void; message: string } | null>(null);
  const [catalogue, setCatalogue] = useState<CanopyModelCatalogue | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);

  const loadModels = useCallback((refresh = false) => {
    setCatalogueError(null);
    window.electron.canopy
      .getModels(refresh)
      .then(setCatalogue, (error: unknown) =>
        setCatalogueError(formatErrorMessage(error, "Try again in a moment."))
      );
  }, []);

  // A download finishing changes what is on this machine.
  const modelStatus = snapshot?.model?.status;
  useEffect(() => {
    loadModels();
  }, [loadModels, modelStatus]);

  const act = useCallback(
    (run: () => Promise<Parameters<typeof applySnapshot>[0]>, retry: () => void) => {
      if (pending.current) return;
      pending.current = true;
      setFailure(null);
      run()
        .then(applySnapshot, (error: unknown) =>
          setFailure({ retry, message: formatErrorMessage(error, "Try again in a moment.") })
        )
        .finally(() => {
          pending.current = false;
          loadModels();
        });
    },
    [applySnapshot, loadModels]
  );

  const setMode = useCallback(
    (next: CanopyMode) =>
      act(
        () => window.electron.canopy.setMode(next),
        () => setMode(next)
      ),
    [act]
  );
  const setModel = useCallback(
    (id: string) =>
      act(
        () => window.electron.canopy.setModel(id),
        () => setModel(id)
      ),
    [act]
  );
  const retryModel = useCallback(
    () =>
      act(
        () => window.electron.canopy.retryModel(),
        () => retryModel()
      ),
    [act]
  );
  const removeModels = useCallback(
    () =>
      act(
        () => window.electron.canopy.removeModels(),
        () => removeModels()
      ),
    [act]
  );

  const hidden = mode === "hidden";
  const activated = mode === "on";
  const variants = catalogue?.variants ?? [];
  const selected = catalogue?.selected ?? null;
  const model = snapshot?.model;
  const comparison = modelComparison(variants);
  const installed = variants.filter((v) => v.installed);
  const installedNames = installed.map((v) => v.name).join(", ");
  const installedSize = formatModelBytes(installed.reduce((sum, v) => sum + v.downloadBytes, 0));
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
            onRetry={failure.retry}
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
              subtitle="Downloads the model below the first time. When off, Canopy lets the model go and deletes its readings."
              isEnabled={activated}
              onChange={() => setMode(activated ? "unset" : "on")}
            />
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Model"
        description="Every screen is read on this computer by the model chosen here, and only that one is kept. While Canopy is on, choosing another downloads it and then deletes the last."
        id="canopy-model"
      >
        {catalogueError && (
          <SettingsLoadErrorBanner
            title="Couldn't list the models"
            message={catalogueError}
            onRetry={() => loadModels(true)}
          />
        )}
        <SettingsGroup>
          <SettingsChoicebox
            label="Model"
            aria-label="Model"
            {...(comparison ? { description: comparison } : {})}
            value={selected ?? ""}
            onChange={setModel}
            options={variants.map((variant) => ({
              value: variant.id,
              label: variant.name,
              description: modelDescription(variant),
              disabled: !variant.supported,
              ...(variant.installed ? { resolvedLabel: "Downloaded" } : {}),
            }))}
          />
          {activated && model && model.status !== "ready" && (
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
          )}
        </SettingsGroup>
        {comparison === null && variants.length > 0 && (
          <p className="text-xs text-text-secondary">
            Accuracy figures show once Hugging Face can be reached.
          </p>
        )}
      </SettingsSection>

      {installed.length > 0 && (
        <SettingsSection title="Downloaded model" id="canopy-model-files">
          <SettingsGroup>
            <SettingsRow
              id="canopy-delete-model"
              label={installedNames}
              description={`${installedSize} on this computer${activated ? "" : ". Turning Canopy on again downloads one"}`}
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
        title={`Delete '${installedNames}'?`}
        description={
          activated
            ? `Frees ${installedSize}. Canopy turns off, and turning it on again asks you to choose a model and download it.`
            : `Frees ${installedSize}. Turning Canopy on again downloads a model.`
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
