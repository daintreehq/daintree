import { useCallback, useRef, useState } from "react";
import { CANOPY_LOCAL } from "@/components/Canopy/canopyTerms";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { formatBytes } from "@/lib/formatBytes";
import { useCanopyStore } from "@/store/canopyStore";
import type { CanopyMode } from "@shared/types/ipc/canopy";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { SettingsSection } from "./SettingsSection";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";

/** A revision as Settings names it: the first seven characters of its commit, as Git shows it. */
function shortRevision(revision: string): string {
  return revision.slice(0, 7);
}

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
        });
    },
    [applySnapshot]
  );

  const setMode = useCallback(
    (next: CanopyMode) => act(() => window.electron.canopy.setMode(next)),
    [act]
  );

  const hidden = mode === "hidden";
  const activated = mode === "on";
  const model = snapshot?.model;
  const ready = model?.status === "ready" && model.revision ? model : null;
  const update = ready?.update ?? null;

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
              subtitle="When off, Canopy lets its model go and deletes its readings"
              isEnabled={activated}
              onChange={() => setMode(activated ? "unset" : "on")}
            />
          </SettingsDependents>
        </SettingsGroup>
      </SettingsSection>

      {/* Which copy reads, and an update on its way: shown here and nowhere more prominent. */}
      {activated && ready && (
        <SettingsSection title="Model" id="canopy-model">
          <SettingsGroup>
            <SettingsRow
              id="canopy-model-revision"
              label={`Revision ${shortRevision(ready.revision!)}`}
              description={
                ready.source === "update"
                  ? "An update from Hugging Face, newer than the copy that comes with Daintree"
                  : "The copy that comes with Daintree"
              }
            />
            {update && (
              <SettingsRow
                id="canopy-model-update"
                label={`Downloading revision ${shortRevision(update.revision)}`}
                description={
                  <>
                    <span className="block">
                      {`${formatBytes(update.received)} of ${formatBytes(update.total)}. Canopy reads with revision ${shortRevision(ready.revision!)} until it's in place.`}
                    </span>
                    <ProgressBar
                      className="mt-2"
                      size="thin"
                      value={update.received}
                      max={update.total}
                      label="Model update"
                      valueText={`${formatBytes(update.received)} of ${formatBytes(update.total)}`}
                    />
                  </>
                }
              />
            )}
          </SettingsGroup>
        </SettingsSection>
      )}

      {/* The model ships with Daintree: one that fails its check says so here. */}
      {activated && model?.status === "failed" && (
        <SettingsSection title="Model" id="canopy-model">
          <SettingsGroup>
            <SettingsRow
              id="canopy-model-status"
              label="Model unavailable"
              description={model.error}
            />
          </SettingsGroup>
        </SettingsSection>
      )}
    </div>
  );
}
