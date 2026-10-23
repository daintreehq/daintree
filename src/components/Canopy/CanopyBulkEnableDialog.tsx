import { useEffect, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { systemClient } from "@/clients/systemClient";
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
} from "./bulkEnable";
import {
  CANOPY_BETA_TERMS,
  CANOPY_PRIVACY_URL,
  CANOPY_REDACTION,
  CANOPY_STOP_ON_EACH,
  canopySendsFromHosts,
} from "./canopyTerms";

const OUTCOME_LABEL: Record<BulkEnableOutcome, string> = {
  enabled: "Turned on",
  "already-enabled": "Already on",
  unsupported: "Not supported",
  inaccessible: "Couldn't reach",
  refused: "Refused",
  conflicted: "Changed meanwhile",
  uncertain: "Not confirmed",
};

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
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    if (!isOpen) return;
    setPhase("review");
    setResults(new Map());
    setHidden(new Set());
    let live = true;
    void previewCanopyModes(targets, depsRef.current).then((rows) => {
      if (live)
        setHidden(new Set(rows.filter((row) => row.mode === "hidden").map((r) => r.hostId)));
    });
    return () => {
      live = false;
      abortRef.current?.abort();
    };
  }, [isOpen, targets]);

  const run = (subset: readonly BulkTarget[], before: ReadonlyMap<string, BulkSeen | null>) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    void enableCanopyOnHosts(
      subset,
      { ...depsRef.current, signal: controller.signal },
      before,
      (result) => setResults((prev) => new Map(prev).set(result.hostId, result))
    ).then(() => {
      if (abortRef.current === controller) setPhase("done");
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
      zIndex="modal"
    >
      <AppDialog.Header>
        <AppDialog.Title>Enable Canopy on all hosts?</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body className="space-y-3">
        {phase === "review" && (
          <>
            <AppDialog.Description>{canopySendsFromHosts(names)}</AppDialog.Description>
            <p className="text-sm leading-6 text-text-secondary">
              {CANOPY_REDACTION} {CANOPY_STOP_ON_EACH}{" "}
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0 text-sm"
                onClick={() => void systemClient.openExternal(CANOPY_PRIVACY_URL)}
              >
                Privacy policy
              </Button>
            </p>
            <p className="text-xs text-text-secondary">{CANOPY_BETA_TERMS}</p>
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
                  phase === "review" &&
                  hidden.has(target.hostId) && (
                    <span className="text-xs text-text-secondary">
                      Hidden there. It will be shown, then turned on.
                    </span>
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
                disabled: phase === "running" || targets.length === 0,
                loading: phase === "running",
              }
        }
      />
    </AppDialog>
  );
}
