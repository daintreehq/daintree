import { useCallback, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { CANOPY_BETA_TERMS } from "@/components/Canopy/canopyTerms";
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
  const [failure, setFailure] = useState<{ mode: CanopyMode; message: string } | null>(null);

  const setMode = useCallback(
    (next: CanopyMode) => {
      if (pending.current) return;
      pending.current = true;
      setFailure(null);
      window.electron.canopy
        .setMode(next)
        .then(applySnapshot, (error: unknown) =>
          setFailure({ mode: next, message: formatErrorMessage(error, "Try again in a moment.") })
        )
        .finally(() => {
          pending.current = false;
        });
    },
    [applySnapshot]
  );
  const hidden = mode === "hidden";
  const activated = mode === "on";

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Canopy"
        description="One inbox of every agent, read off its screen. To read them, Canopy sends your agents' terminal output to Daintree's servers. It keeps reading while it's closed, so it can tell you when an agent is asking for you. Anything shaped like a password or key is stripped first."
        id="canopy-activation"
      >
        {failure && (
          <SettingsLoadErrorBanner
            title="Couldn't change Canopy"
            message={failure.message}
            onRetry={() => setMode(failure.mode)}
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
              subtitle="Off, nothing leaves this computer and every reading is deleted."
              isEnabled={activated}
              onChange={() => setMode(activated ? "unset" : "on")}
            />
          </SettingsDependents>
          <SettingsRow
            id="canopy-plan"
            label="Plan"
            description={snapshot?.tier === "priority" ? "Paid" : CANOPY_BETA_TERMS}
            control={
              snapshot?.tier === "priority" ? (
                <span className="text-xs text-text-secondary">Paid</span>
              ) : (
                <Badge tone="warning" size="sm">
                  Beta
                </Badge>
              )
            }
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
