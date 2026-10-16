import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { systemClient } from "@/clients/systemClient";
import {
  CANOPY_BETA_TERMS,
  CANOPY_PRIVACY_URL,
  CANOPY_REDACTION,
  canopySendsFrom,
  canopyStopOn,
} from "./canopyTerms";

/**
 * Canopy is off on the host the panel shows. Consent is that host's own: the
 * offer names it, says what turning it on sends from there, and turns it on
 * there alone. Nothing about the window's own host changes.
 */
export function CanopyHostOffer({
  hostName,
  onTurnOn,
}: {
  hostName: string;
  onTurnOn: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const turnOn = () => {
    setPending(true);
    setFailed(false);
    onTurnOn().then(
      () => setPending(false),
      () => {
        setPending(false);
        setFailed(true);
      }
    );
  };
  return (
    <section
      aria-labelledby="canopy-host-offer-title"
      data-canopy-host-offer=""
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-10"
    >
      <div className="flex max-w-md flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2
            id="canopy-host-offer-title"
            className="text-lg font-semibold tracking-tight text-text-primary"
          >
            Canopy is off on {hostName}
          </h2>
          <p className="text-sm leading-6 text-text-secondary">
            Turn it on there to see which of its agents need you. {hostName} reads its own agents,
            and this panel shows what it found.
          </p>
        </div>
        <div className="flex gap-2 text-sm leading-6 text-text-secondary">
          <Send className="mt-1.5 size-3.5 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-2">
            <p>{canopySendsFrom(hostName)}</p>
            <p>
              {CANOPY_REDACTION} {canopyStopOn(hostName)}{" "}
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0 text-sm"
                onClick={() => void systemClient.openExternal(CANOPY_PRIVACY_URL)}
              >
                Privacy policy
              </Button>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="contrast" disabled={pending} onClick={turnOn}>
            Turn on Canopy on {hostName}
          </Button>
          <p role="status" className="text-xs text-text-secondary">
            {failed ? `Couldn't turn on Canopy on ${hostName}. Try again.` : ""}
          </p>
        </div>
        <p className="text-xs text-text-secondary">{CANOPY_BETA_TERMS}</p>
      </div>
    </section>
  );
}
