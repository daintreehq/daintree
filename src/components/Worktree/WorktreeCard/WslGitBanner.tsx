import React, { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Info } from "lucide-react";
import type { WslGitEligibility } from "@shared/types";
import { Gauge } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { worktreeConfigClient } from "@/clients/worktreeConfigClient";
import { useDeferredLoading, useSkeletonDisplayFloor } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { logError } from "@/utils/logger";

export interface WslGitBannerProps {
  worktreeId: string;
  wslDistro?: string;
  wslGitEligible?: WslGitEligibility;
}

// If the probe hasn't resolved this long, treat the skeleton as stuck (WSL
// unavailable / probe failed upstream) and surface a manual retry so the user
// isn't stranded staring at a perpetual skeleton. Mirrors the ">5s →
// persistent skeleton + recovery" tier of the loading-indicator rules.
const WSL_PROBE_STUCK_MS = 5000;

// A failed default-distro probe emits nothing — the monitor just stays
// `unprobed` — so the only way to tell the user their re-check got no answer is
// to stop waiting. `wsl.exe --list` is killed at 5s in main; allow for the hop.
export const WSL_RECHECK_WINDOW_MS = 6500;

type RecheckState =
  | { phase: "idle" }
  | { phase: "running"; from: WslGitEligibility; sawPending: boolean }
  | { phase: "done"; outcome: "unchanged" | "no-answer" | "failed" };

type ActionError = "enable" | "dismiss" | null;

const DISTRO_CLASS = "text-text-primary [overflow-wrap:anywhere]";

/**
 * Inline note on a WSL-mounted worktree card suggesting git be routed through
 * `wsl git` to avoid the 9P boundary slowdown. Three states driven by
 * `wslGitEligible`:
 *
 * - `'eligible'`: offers to enable WSL git, or to decline for this worktree.
 * - `'ineligible'`: the worktree is in a non-default distro, so git keeps
 *   running from Windows. Re-check re-probes, since the default can change.
 * - `'unprobed'` (or absent): the default-distro probe hasn't resolved. A
 *   Doherty-gated skeleton, then a retry once the probe has stalled.
 *
 * A re-check is observed through the snapshots it produces: the host flips the
 * monitor to `unprobed` while it probes, then back to a resolved value. The
 * banner keeps showing what it showed before until that answer arrives.
 */
export const WslGitBanner = React.memo(function WslGitBanner({
  worktreeId,
  wslDistro,
  wslGitEligible,
}: WslGitBannerProps) {
  const [busy, setBusy] = useState<"enable" | "dismiss" | null>(null);
  const [actionError, setActionError] = useState<ActionError>(null);
  const [recheck, setRecheck] = useState<RecheckState>({ phase: "idle" });
  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  // Treat a missing value as "unprobed" — older snapshots predate the field.
  const eligibility: WslGitEligibility = wslGitEligible ?? "unprobed";
  const rechecking = recheck.phase === "running";
  // While a re-check the user asked for is in flight, keep the answer they
  // were reading rather than collapsing it into a loading placeholder.
  const shown: WslGitEligibility =
    rechecking && eligibility === "unprobed" ? recheck.from : eligibility;

  const probePending = eligibility === "unprobed";
  const probeStuck = useDeferredLoading(probePending, WSL_PROBE_STUCK_MS);
  const showStuck = shown === "unprobed" && (probeStuck || recheck.phase !== "idle");
  const skeletonGate = useDeferredLoading(probePending && !showStuck, UI_DOHERTY_THRESHOLD);
  const showSkeleton = useSkeletonDisplayFloor(skeletonGate) && !showStuck;

  useEffect(() => {
    if (recheck.phase !== "running") return;
    if (eligibility === "unprobed") {
      if (!recheck.sawPending) setRecheck({ ...recheck, sawPending: true });
      return;
    }
    if (eligibility !== recheck.from) {
      setRecheck({ phase: "idle" });
    } else if (recheck.sawPending) {
      setRecheck({ phase: "done", outcome: "unchanged" });
    }
  }, [eligibility, recheck]);

  useEffect(() => {
    if (!rechecking) return;
    const timer = setTimeout(() => {
      setRecheck((prev) =>
        prev.phase === "running" ? { phase: "done", outcome: "no-answer" } : prev
      );
    }, WSL_RECHECK_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [rechecking]);

  // Enabling or declining unmounts this banner from the card. If focus was on
  // one of its buttons it would fall to <body>; hand it to the card's own
  // keyboard target instead. Layout cleanup runs before React detaches the node.
  useLayoutEffect(() => {
    if (!root) return;
    return () => {
      if (!root.contains(document.activeElement)) return;
      const row = root.closest("[data-worktree-row]");
      const target =
        row?.querySelector<HTMLElement>("[data-card-select-overlay]") ??
        root.closest<HTMLElement>('[role="gridcell"]');
      target?.focus({ preventScroll: true });
    };
  }, [root]);

  // The card selects its worktree on any click that reaches it, so every
  // control here stops propagation (card convention, #10319 / #12087).
  // Promise-method cleanup instead of try/finally: statement-level finally
  // clauses bail React Compiler memoization for the whole component.
  const handleEnable = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      setBusy("enable");
      setActionError(null);
      worktreeConfigClient
        .setWslGit(worktreeId, true)
        .catch((err) => {
          logError("Failed to enable WSL git for worktree", err, { worktreeId });
          setActionError("enable");
        })
        .finally(() => {
          setBusy(null);
        });
    },
    [worktreeId, busy]
  );

  const handleDismiss = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      setBusy("dismiss");
      setActionError(null);
      worktreeConfigClient
        .dismissWslBanner(worktreeId)
        .catch((err) => {
          logError("Failed to dismiss WSL git banner", err, { worktreeId });
          setActionError("dismiss");
        })
        .finally(() => {
          setBusy(null);
        });
    },
    [worktreeId, busy]
  );

  const handleRecheck = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (rechecking) return;
      setActionError(null);
      setRecheck({ phase: "running", from: eligibility, sawPending: false });
      worktreeConfigClient.reprobeWsl(worktreeId).catch((err) => {
        logError("Failed to re-check WSL distro for worktree", err, { worktreeId });
        setRecheck({ phase: "done", outcome: "failed" });
      });
    },
    [worktreeId, rechecking, eligibility]
  );

  if (shown === "unprobed" && !showStuck && !showSkeleton) return null;

  const view = shown === "unprobed" ? (showStuck ? "stuck" : "probing") : shown;

  let result: string | null = null;
  if (actionError === "enable") result = "Couldn't enable WSL git. Try again.";
  else if (actionError === "dismiss") result = "Couldn't hide this. Try again.";
  else if (recheck.phase === "done" && view !== "eligible") {
    if (recheck.outcome === "failed") result = "Couldn't re-check. Try again.";
    else if (recheck.outcome === "no-answer") result = "WSL didn't answer.";
    else if (view === "ineligible") result = "Checked. Still not the default distro.";
  }

  const distro = wslDistro ? <span className={DISTRO_CLASS}>{wslDistro}</span> : null;

  return (
    <div
      ref={setRoot}
      data-testid="wsl-git-banner"
      data-state={view}
      aria-busy={view === "probing" || rechecking || undefined}
      className="mb-2 flex items-start gap-2 rounded-[var(--radius-lg)] border border-border-default bg-overlay-subtle p-3 text-xs"
    >
      {view === "probing" ? (
        <Skeleton label="Checking WSL distro" className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            <SkeletonBone className="h-3.5 w-1/2" />
            <SkeletonBone className="h-3 w-full" />
            <SkeletonBone className="h-3 w-3/4" />
          </div>
          <SkeletonBone className="h-7 w-24" />
        </Skeleton>
      ) : (
        <>
          {view === "eligible" ? (
            <Gauge className="mt-px h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
          ) : (
            <Info className="mt-px h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-text-primary">
                {view === "eligible"
                  ? "Speed up git for this worktree"
                  : view === "ineligible"
                    ? "Git runs from Windows"
                    : "Couldn't read your default WSL distro"}
              </span>
              <span className="text-text-secondary">
                {view === "eligible" ? (
                  <>
                    It lives in WSL, so git is slow when it runs from Windows. Running it inside{" "}
                    {distro ?? "WSL"} makes status checks{" "}
                    <span className="whitespace-nowrap">5–10×</span> faster.
                  </>
                ) : view === "ineligible" ? (
                  <>
                    {distro ?? "This worktree's distro"} isn't your default WSL distro, so git can't
                    run inside it and status checks may be slower.
                  </>
                ) : (
                  "Git runs from Windows for now, which may be slower."
                )}
              </span>
            </div>
            <p role="status" aria-live="polite" className="text-text-secondary empty:hidden">
              {result}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {view === "eligible" ? (
                <Button
                  size="sm"
                  variant="subtle"
                  loading={busy === "enable"}
                  disabled={busy === "dismiss"}
                  onClick={handleEnable}
                >
                  Enable WSL git
                </Button>
              ) : (
                <Button size="sm" variant="subtle" loading={rechecking} onClick={handleRecheck}>
                  {view === "stuck" ? "Retry" : "Re-check"}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                loading={busy === "dismiss"}
                disabled={busy === "enable"}
                onClick={handleDismiss}
              >
                {view === "eligible" ? "No thanks" : "Got it"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
