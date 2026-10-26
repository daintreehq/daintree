import { useState } from "react";
import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canopyLocalOn, canopyStopOn } from "./canopyTerms";

/**
 * Canopy is off on the host the panel shows. Turning it on is that host's own:
 * the offer names it, says what turning it on does there, and turns it on
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
          <HardDrive className="mt-1.5 size-3.5 shrink-0" aria-hidden="true" />
          <p>
            {canopyLocalOn(hostName)} {canopyStopOn(hostName)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="contrast" disabled={pending} onClick={turnOn}>
            Turn on Canopy on {hostName}
          </Button>
          <p role="status" className="text-xs text-text-secondary">
            {failed ? `Couldn't turn on Canopy on ${hostName}. Try again.` : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The host the panel shows runs a Daintree from before Canopy read on the
 * machine itself: its Canopy would send screens to a service that is gone.
 * Nothing of it is shown or turned on from here until it is updated.
 */
export function CanopyHostOutdated({
  hostName,
  onTurnOff,
}: {
  hostName: string;
  /** Present while Canopy is on there: still sending screens, it can be stopped from here. */
  onTurnOff?: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const turnOff = () => {
    if (!onTurnOff) return;
    setPending(true);
    setFailed(false);
    onTurnOff().then(
      () => setPending(false),
      () => {
        setPending(false);
        setFailed(true);
      }
    );
  };
  return (
    <section
      aria-labelledby="canopy-host-outdated-title"
      data-canopy-host-outdated=""
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-10"
    >
      <div className="flex max-w-md flex-col gap-2">
        <h2
          id="canopy-host-outdated-title"
          className="text-lg font-semibold tracking-tight text-text-primary"
        >
          Update Daintree on {hostName}
        </h2>
        <p className="text-sm leading-6 text-text-secondary">
          {hostName} runs an older Daintree, whose Canopy reads screens with a service that has been
          retired. Once it is updated, Canopy reads its agents on {hostName} itself, with a model it
          downloads there.
        </p>
        {onTurnOff && (
          <div className="flex items-center gap-3 pt-2">
            <Button variant="outline" disabled={pending} onClick={turnOff}>
              Turn off Canopy on {hostName}
            </Button>
            <p role="status" className="text-xs text-text-secondary">
              {failed ? `Couldn't turn off Canopy on ${hostName}. Try again.` : ""}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
