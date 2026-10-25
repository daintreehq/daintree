import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CANOPY_LOCAL } from "@/components/Canopy/canopyTerms";
import { formatModelBytes } from "@/components/Canopy/CanopyStatusBar";
import { useCanopyStore } from "@/store/canopyStore";
import type {
  CanopyMode,
  CanopyModelCatalogue,
  CanopyModelVariant,
} from "@shared/types/ipc/canopy";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { SettingsSection } from "./SettingsSection";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsChoicebox } from "./SettingsChoicebox";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";

const percent = (x: number) => `${Math.round(x * 100)}%`;

/** One model's own line: what it costs to have, and how fast it reads. */
function modelDescription(variant: CanopyModelVariant): string {
  const parts = [`${formatModelBytes(variant.downloadBytes)} download`];
  if (variant.bench) parts.push(`about ${variant.bench.msPerScreen} ms a screen on a fast CPU`);
  if (!variant.supported) parts.push("needs a newer version of Daintree");
  return parts.join(" · ");
}

/** A ratio as the comparison says it: one decimal under ten, so 3.5x is never called 4x. */
function times(ratio: number): string {
  const rounded = ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio);
  return `${rounded}x`;
}

/** How two measured rates compare, said plainly, the larger model's first. */
function against(large: number, small: number): string {
  return `${percent(large)} against ${percent(small)}`;
}

/**
 * How the smallest and the largest model differ, in the publisher's own
 * numbers from real agent screens it never trained on. Says only what the
 * numbers say: a larger model that is no better is not called better.
 */
export function modelComparison(variants: readonly CanopyModelVariant[]): string | null {
  const measured = variants.filter((v) => v.bench !== null && v.supported);
  if (measured.length < 2) return null;
  const small = measured[0]!;
  const large = measured[measured.length - 1]!;
  const a = small.bench!;
  const b = large.bench!;
  const sentences: string[] = [];
  if (a.agentCategory === b.agentCategory && a.agents === b.agents) {
    sentences.push(
      `Both read an agent's state equally well: ${a.agentCategory} of ${a.agents} real agent screens`
    );
  } else {
    sentences.push(
      `${small.name} reads an agent's state right on ${a.agentCategory} of ${a.agents} real agent screens, ${large.name} on ${b.agentCategory} of ${b.agents}`
    );
  }
  const better = b.headline > a.headline && b.options > a.options;
  sentences.push(
    better
      ? `${large.name} picks the line that says most a little more often (${against(b.headline, a.headline)}) and gets a menu's options right more often (${against(b.options, a.options)})`
      : `Picking the line that says most: ${large.name} ${percent(b.headline)}, ${small.name} ${percent(a.headline)}. A menu's options: ${large.name} ${percent(b.options)}, ${small.name} ${percent(a.options)}`
  );
  const size = large.downloadBytes / small.downloadBytes;
  sentences.push(
    `${large.name} is ${size < 1.15 ? "about the same download" : `${times(size)} the download`} and about ${times(b.msPerScreen / a.msPerScreen)} the work per screen`
  );
  if (better) sentences.push(`For most people ${small.name} is enough`);
  return `${sentences.join(". ")}.`;
}

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

      {!activated && installed.length > 0 && (
        <SettingsSection title="Downloaded model" id="canopy-model-files">
          <SettingsGroup>
            <SettingsRow
              id="canopy-delete-model"
              label={installed.map((v) => v.name).join(", ")}
              description={`${formatModelBytes(installed.reduce((sum, v) => sum + v.downloadBytes, 0))} on this computer. Turning Canopy on again downloads it again.`}
              control={
                <Button variant="ghost-danger" size="sm" onClick={removeModels}>
                  Delete model
                </Button>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      )}
    </div>
  );
}
