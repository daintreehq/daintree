import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { DecisionsRotateKeysDialog } from "./DecisionsRotateKeysDialog";
import type { UseDecisionsKeyActionsResult } from "./useDecisionsKeyActions";
import type { UseDecisionsDevicesResult } from "./useDecisionsDevices";

export const ENCRYPTION_SECTION_ID = "decisions-encryption";
const ROTATE_BUTTON_ATTR = "data-decisions-rotate-keys";

/** Where focus goes after a revocation: the revoked row may be gone, the key row stays. */
export function currentRotateButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#${ENCRYPTION_SECTION_ID} [${ROTATE_BUTTON_ATTR}]`);
}

/**
 * The key every paired phone and enrolled Remote Host holds (#16010), after
 * both of their sections because a revocation in either changes it (#16222):
 * Rotate keys without revoking anyone, once confirmed (#18064), and what the
 * latest key change came to.
 */
export function DecisionsEncryptionSection({
  relayOrigin,
  devicesRead,
  keyActions,
  locked = false,
}: {
  relayOrigin: string;
  devicesRead: Pick<UseDecisionsDevicesResult, "devices" | "failure" | "loading">;
  keyActions: Pick<UseDecisionsKeyActionsResult, "pending" | "notice" | "rotate">;
  /** The switch is changing, so nothing here should start. */
  locked?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingsSection title="Encryption" id={ENCRYPTION_SECTION_ID}>
      <SettingsGroup>
        <SettingsRow
          id="decisions-rotate-keys"
          label="Shared key"
          description={
            <>
              Questions and answers are sealed with one key, which each paired phone or tablet and
              each enrolled Remote Host holds. Rotating seals a new one to each of them; what one
              already holds stays readable on it.
              {keyActions.notice && (
                <span
                  className="mt-1 block text-text-primary"
                  role={keyActions.notice.problem ? "alert" : "status"}
                >
                  {keyActions.notice.message}
                </span>
              )}
            </>
          }
          // Busy rather than disabled while it rotates, so the button keeps focus.
          disabled={locked || keyActions.pending === "revoke"}
          control={({ descriptionId, disabled }) => (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              loading={keyActions.pending === "rotate"}
              aria-describedby={descriptionId}
              onClick={() => {
                // A rotation already running keeps its busy button; a second ask changes nothing.
                if (keyActions.pending === null) setConfirming(true);
              }}
              {...{ [ROTATE_BUTTON_ATTR]: "" }}
            >
              Rotate keys
            </Button>
          )}
        />
      </SettingsGroup>
      <DecisionsRotateKeysDialog
        isOpen={confirming}
        relayOrigin={relayOrigin}
        devicesRead={devicesRead}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          // The busy button and the notice beside it carry the rotation from here.
          setConfirming(false);
          keyActions.rotate();
        }}
      />
    </SettingsSection>
  );
}
