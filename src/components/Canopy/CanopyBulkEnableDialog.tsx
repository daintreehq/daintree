import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import type { CanopyMode } from "@shared/types/ipc/canopy";
import { pluralize } from "@/lib/pluralize";
import {
  enableCanopyOnHosts,
  isRetryable,
  isSettled,
  previewCanopyModes,
  type BulkEnableDeps,
  type BulkEnableOutcome,
  type BulkResult,
  type BulkSeen,
  type BulkTarget,
} from "@shared/utils/canopyBulkEnable";
import { CANOPY_STOP_ON_EACH, canopyLocalOnHosts } from "./canopyTerms";

const OUTCOME_LABEL: Record<BulkEnableOutcome, string> = {
  enabled: "Turned on",
  "already-enabled": "Already on",
  unsupported: "Not supported",
  inaccessible: "Couldn't reach",
  refused: "Refused",
  conflicted: "Changed meanwhile",
  uncertain: "Not confirmed",
};

/** What a host still to be asked is going to see, said before anyone agrees. */
function reviewNote(
  target: BulkTarget,
  modes: ReadonlyMap<string, CanopyMode | null> | null
): string | null {
  if (modes === null) return target.connected === false ? "Not connected" : "Checking…";
  const mode = modes.get(target.hostId) ?? null;
  if (mode === "hidden") return "Hidden there. It will be shown, then turned on.";
  if (mode === "on") return "Already on.";
  if (mode === "unset") return null;
  return "Not read yet. If Canopy is hidden there, it will be shown, then turned on.";
}

type Phase = "review" | "running" | "done";

/**
 * One disclosure for every host named, one press to turn Canopy on across
 * them. The targets are the ones listed when it opened: a host added later is
 * not in this run, nor in its retry.
 */
export function CanopyBulkEnableDialog({
  isOpen,
  onClose,
  targets,
  deps,
}: {
  isOpen: boolean;
  onClose: () => void;
  targets: readonly BulkTarget[];
  deps: Pick<BulkEnableDeps, "transportFor">;
}) {
  const [phase, setPhase] = useState<Phase>("review");
  const [results, setResults] = useState<Map<string, BulkResult>>(new Map());
  const [modes, setModes] = useState<ReadonlyMap<string, CanopyMode | null> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Read when the effect runs, so a new `deps` alone never restarts the preview.
  const readDeps = useEffectEvent(() => deps);

  useEffect(() => {
    if (!isOpen) return;
    setPhase("review");
    setResults(new Map());
    setModes(null);
    const controller = new AbortController();
    abortRef.current = controller;
    void previewCanopyModes(targets, { ...readDeps(), signal: controller.signal }).then((rows) => {
      if (!controller.signal.aborted) {
        setModes(new Map(rows.map((row) => [row.hostId, row.mode] as const)));
      }
    });
    return () => controller.abort();
  }, [isOpen, targets]);

  const run = (subset: readonly BulkTarget[], before: ReadonlyMap<string, BulkSeen | null>) => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setPhase("running");
    void enableCanopyOnHosts(subset, { ...deps, signal: controller.signal }, before, (result) => {
      if (abortRef.current === controller) {
        setResults((prev) => new Map(prev).set(result.hostId, result));
      }
    }).then(() => {
      if (abortRef.current === controller && !controller.signal.aborted) setPhase("done");
    });
  };

  const failed = targets.filter((t) => {
    const result = results.get(t.hostId);
    return result !== undefined && isRetryable(result);
  });
  const retry = () =>
    run(
      failed,
      new Map(failed.map((t) => [t.hostId, results.get(t.hostId)?.seen ?? null] as const))
    );
  const onCount = [...results.values()].filter(isSettled).length;
  const names = targets.map((t) => t.name);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      dismissible={phase !== "running"}
      size="md"
      zIndex="nested"
    >
      <AppDialog.Header>
        <AppDialog.Title>Enable Canopy on all hosts?</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body className="space-y-3">
        {phase === "review" && (
          <>
            <AppDialog.Description>{canopyLocalOnHosts(names)}</AppDialog.Description>
            <p className="text-sm leading-6 text-text-secondary">{CANOPY_STOP_ON_EACH}</p>
          </>
        )}
        <ul className="flex flex-col gap-1 text-sm" data-bulk-enable-targets="">
          {targets.map((target) => {
            const result = results.get(target.hostId);
            return (
              <li
                key={target.hostId}
                data-host-id={target.hostId}
                data-outcome={result?.outcome}
                className="flex flex-col gap-0.5"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words text-text-primary">{target.name}</span>
                  {result && (
                    <span className="shrink-0 text-xs font-medium text-text-primary">
                      {OUTCOME_LABEL[result.outcome]}
                    </span>
                  )}
                </span>
                {result ? (
                  <span className="text-xs text-text-secondary">{result.detail}</span>
                ) : (
                  phase === "review" && (
                    <span className="text-xs text-text-secondary">{reviewNote(target, modes)}</span>
                  )
                )}
              </li>
            );
          })}
        </ul>
        {phase === "done" && (
          <p role="status" className="text-sm text-text-secondary">
            {onCount} of {pluralize(targets.length, "host")} on.
          </p>
        )}
      </AppDialog.Body>
      <AppDialog.Footer
        secondaryAction={{
          label: phase === "review" ? "Cancel" : "Close",
          onClick: onClose,
          disabled: phase === "running",
        }}
        primaryAction={
          phase === "done"
            ? failed.length > 0
              ? { label: "Retry failed", onClick: retry }
              : undefined
            : {
                label: "Enable Canopy on all hosts",
                onClick: () => run(targets, new Map()),
                disabled: phase === "running" || targets.length === 0 || modes === null,
                loading: phase === "running",
              }
        }
      />
    </AppDialog>
  );
}
