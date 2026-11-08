import { useCallback, useRef, useState } from "react";
import { CANOPY_LOCAL } from "@/components/Canopy/canopyTerms";
import { useCanopyStore } from "@/store/canopyStore";
import type { CanopyMode } from "@shared/types/ipc/canopy";
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

      {/* The model ships with Daintree: only one that fails its check has anything to say here. */}
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
