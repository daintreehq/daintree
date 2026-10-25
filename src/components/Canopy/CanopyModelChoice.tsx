import { useEffect, useRef, useState } from "react";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import type { CanopyModelCatalogue } from "@shared/types/ipc/canopy";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { modelComparison, modelDescription } from "./canopyModelCopy";

export interface CanopyModelChoiceState {
  catalogue: CanopyModelCatalogue | null;
  error: string | null;
  /** The model the person has picked, else the one the host would use. Null until the list is in. */
  chosen: string | null;
  pick: (id: string) => void;
}

/**
 * The models a host can read with and which one is picked, starting from the
 * one it would use anyway. `load` is that host's own list and `forHost` names
 * it: the list is fetched again, and the pick forgotten, only when the host
 * changes, never because `load` was made afresh by a render. Nothing is asked
 * for until `enabled`: a flow that is not on screen costs no request.
 */
export function useCanopyModelChoice(
  load: () => Promise<CanopyModelCatalogue>,
  forHost: string,
  enabled = true
): CanopyModelChoiceState {
  const [catalogue, setCatalogue] = useState<CanopyModelCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const latest = useRef(load);
  // After commit, not during render: the fetch below reads it a tick later.
  useEffect(() => {
    latest.current = load;
  });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setCatalogue(null);
    setError(null);
    setPicked(null);
    // Through a promise, so a loader that throws is a failed list, not a crashed render.
    // A flow closed before the tick asks for nothing.
    Promise.resolve()
      .then(() => (live ? latest.current() : null))
      .then(
        (loaded) => {
          if (live && loaded) setCatalogue(loaded);
        },
        (failure: unknown) => {
          if (live) setError(formatErrorMessage(failure, "Couldn't list the models."));
        }
      );
    return () => {
      live = false;
    };
  }, [forHost, enabled]);
  return {
    catalogue,
    error,
    chosen: picked ?? (catalogue && catalogue.selected !== "" ? catalogue.selected : null),
    pick: setPicked,
  };
}

/**
 * Which model Canopy reads with, asked where it is turned on: nothing is
 * downloaded until the person has chosen. The same sizes and the same honest
 * comparison as Settings, worded from one place.
 */
export function CanopyModelChoice({
  choice,
  name,
  host,
}: {
  choice: CanopyModelChoiceState;
  /** Groups the radios; unique per place it is shown. */
  name: string;
  /** The host it is downloaded to, when not this computer. */
  host?: string;
}) {
  const { catalogue, error, chosen, pick } = choice;
  if (error !== null) {
    return (
      <p className="text-xs text-text-secondary">
        Couldn't list the models. Canopy will use the one already chosen.
      </p>
    );
  }
  if (catalogue === null) {
    return <p className="text-xs text-text-secondary">Looking up the models…</p>;
  }
  const comparison = modelComparison(catalogue.variants);
  return (
    <div className="flex flex-col gap-2" data-canopy-model-choice="">
      <RadioChoiceGroup legend={host ? `Model for ${host}` : "Model"}>
        {catalogue.variants.map((variant) => (
          <RadioChoiceRow
            key={variant.id}
            name={name}
            value={variant.id}
            checked={chosen === variant.id}
            onChange={() => pick(variant.id)}
            disabled={!variant.supported}
            label={variant.name}
            description={modelDescription(variant)}
          />
        ))}
      </RadioChoiceGroup>
      {comparison && <p className="text-xs leading-5 text-text-secondary">{comparison}</p>}
    </div>
  );
}
