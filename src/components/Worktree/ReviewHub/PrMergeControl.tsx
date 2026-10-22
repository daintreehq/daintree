import { useEffect, useId, useRef, useState } from "react";
import type { PRMergeMethod } from "@shared/types/forge";
import { Button } from "@/components/ui/button";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { forgeClient } from "@/clients/forgeClient";
import { describeMergeIntent } from "@shared/utils/prMergeIntent";
import {
  derivePrMergeControl,
  mergeActionLabel,
  type PrMergeControlModel,
  type PrMergeRequest,
} from "./prMergeModel";

type ControlState =
  { kind: "loading" } | { kind: "ready"; model: PrMergeControlModel } | { kind: "error" };

const METHOD_SEGMENT_LABEL: Record<PRMergeMethod, string> = {
  merge: "Merge",
  squash: "Squash",
  rebase: "Rebase",
};

interface PrMergeControlProps {
  worktreePath: string;
  prNumber: number;
  /** Bumped by the popover's Refresh so both reads restart together. */
  reloadKey: number;
  onRequest: (request: PrMergeRequest) => void;
}

/**
 * The checks popover's merge row. Reads the pull request and the repository's
 * merge settings each time the popover opens — the poll's view can be a
 * minute old, and a PR moves from blocked to clean, or armed to queued, in
 * between. It only decides what to offer; the confirm owns the write.
 */
export function PrMergeControl({
  worktreePath,
  prNumber,
  reloadKey,
  onRequest,
}: PrMergeControlProps) {
  const [state, setState] = useState<ControlState>({ kind: "loading" });
  const [method, setMethod] = useState<PRMergeMethod | null>(null);
  const requestIdRef = useRef(0);
  const reasonId = useId();

  useEffect(() => {
    const requestId = (requestIdRef.current += 1);
    setState({ kind: "loading" });
    Promise.all([
      forgeClient.getPR(worktreePath, prNumber),
      forgeClient.getRepoMetadata(worktreePath),
    ]).then(
      ([pr, metadata]) => {
        if (requestIdRef.current !== requestId) return;
        const model = derivePrMergeControl(pr, metadata);
        setState({ kind: "ready", model });
        setMethod(model.kind === "arm" || model.kind === "merge" ? model.defaultMethod : null);
      },
      () => {
        if (requestIdRef.current !== requestId) return;
        setState({ kind: "error" });
      }
    );
    return () => void (requestIdRef.current += 1);
  }, [worktreePath, prNumber, reloadKey]);

  // Under the Doherty gate a read lands before anything would be drawn, and a
  // row that pops in and out is worse than one that arrives once.
  if (state.kind === "loading") return null;

  if (state.kind === "error") {
    return (
      <p
        data-testid="pr-merge-control-error"
        className="px-3 py-2 border-t border-divider text-text-secondary"
      >
        Couldn&apos;t read the merge options. Refresh to try again.
      </p>
    );
  }

  const { model } = state;
  if (model.kind === "hidden") return null;

  const mode = model.kind;
  const label = mergeActionLabel(mode, model.kind === "cancel" ? model.intent : null);
  const disabledReason = model.disabledReason;

  return (
    <div
      data-testid="pr-merge-control"
      className="flex flex-col gap-2 px-3 py-2 border-t border-divider"
    >
      {model.kind === "cancel" && (
        <p className="text-text-secondary" data-testid="pr-merge-control-intent">
          {describeMergeIntent(model.intent)}
        </p>
      )}
      <div className="flex items-center gap-2">
        {model.kind !== "cancel" && model.methods.length > 0 && method !== null && (
          <SegmentedRadioGroup
            aria-label="Merge method"
            density="compact"
            testId="pr-merge-method"
            value={method}
            onChange={setMethod}
            options={model.methods.map((value) => ({ value, label: METHOD_SEGMENT_LABEL[value] }))}
          />
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="pr-merge-action"
          disabled={disabledReason !== null}
          aria-describedby={disabledReason ? reasonId : undefined}
          onClick={() => onRequest({ mode, method: model.kind === "cancel" ? null : method })}
          className="ml-auto transition-colors"
        >
          {label}
        </Button>
      </div>
      {disabledReason && (
        <p
          id={reasonId}
          data-testid="pr-merge-control-reason"
          className="text-2xs text-text-secondary"
        >
          {disabledReason}
        </p>
      )}
    </div>
  );
}
