import React, { useCallback, useEffect, useState } from "react";
import { Info } from "lucide-react";
import type { WslGitEligibility } from "@shared/types";
import { Gauge } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { worktreeConfigClient } from "@/clients/worktreeConfigClient";
import { useDeferredLoading, useSkeletonDisplayFloor } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { logError } from "@/utils/logger";
import { useCardFocusHandoff } from "./hooks/useCardFocusHandoff";

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
  // `at` is the eligibility the outcome describes; a later snapshot retires it.
  | {
      phase: "done";
      outcome: "changed" | "unchanged" | "no-answer" | "failed";
      at: WslGitEligibility;
    };

type ActionError = "enable" | "dismiss" | null;

// Every WSL card probes the same default distro, so they all stall together.
// The first to stall says so; the rest stay quiet for this long.
const STALL_ANNOUNCE_DEDUP_MS = 30_000;
let lastStallAnnouncedAt = 0;

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
  const [stallAnnounced, setStallAnnounced] = useState(false);
  // Enabling or declining unmounts this banner from the card.
  const setRoot = useCardFocusHandoff<HTMLDivElement>();

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
  const skeletonGate = useDeferredLoading(shown === "unprobed" && !showStuck, UI_DOHERTY_THRESHOLD);
  // The floor can outlive the gate by a few hundred ms after an answer lands;
  // the skeleton holds the render for that long rather than tearing down.
  const showSkeleton = useSkeletonDisplayFloor(skeletonGate) && !showStuck;

  useEffect(() => {
    if (recheck.phase === "done") {
      if (eligibility !== recheck.at) setRecheck({ phase: "idle" });
      return;
    }
    if (recheck.phase !== "running") return;
    if (eligibility === "unprobed") {
      if (!recheck.sawPending) setRecheck({ ...recheck, sawPending: true });
      return;
    }
    if (eligibility !== recheck.from) {
      setRecheck({ phase: "done", outcome: "changed", at: eligibility });
    } else if (recheck.sawPending) {
      setRecheck({ phase: "done", outcome: "unchanged", at: eligibility });
    }
  }, [eligibility, recheck]);

  useEffect(() => {
    if (!rechecking) return;
    const timer = setTimeout(() => {
      setRecheck((prev) =>
        // Had the snapshot moved anywhere but `unprobed`, the run would already
        // have ended, so this is the value the banner is showing right now.
        prev.phase === "running"
          ? { phase: "done", outcome: "no-answer", at: prev.sawPending ? "unprobed" : prev.from }
          : prev
      );
    }, WSL_RECHECK_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [rechecking]);

  const stalledOnItsOwn = showStuck && recheck.phase === "idle";
  useEffect(() => {
    if (!stalledOnItsOwn) return;
    const now = Date.now();
    if (now - lastStallAnnouncedAt < STALL_ANNOUNCE_DEDUP_MS) return;
    lastStallAnnouncedAt = now;
    setStallAnnounced(true);
  }, [stalledOnItsOwn]);

  // Promise-method cleanup instead of try/finally: statement-level finally
  // clauses bail React Compiler memoization for the whole component.
  const handleEnable = useCallback(() => {
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
  }, [worktreeId, busy]);

  const handleDismiss = useCallback(() => {
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
  }, [worktreeId, busy]);

  const handleRecheck = useCallback(() => {
    if (rechecking) return;
    setActionError(null);
    setRecheck({ phase: "running", from: eligibility, sawPending: false });
    worktreeConfigClient.reprobeWsl(worktreeId).catch((err) => {
      logError("Failed to re-check WSL distro for worktree", err, { worktreeId });
      setRecheck({ phase: "done", outcome: "failed", at: eligibility });
    });
  }, [worktreeId, rechecking, eligibility]);

  if (shown === "unprobed" && !showStuck && !showSkeleton) return null;

  const view = showSkeleton ? "probing" : shown === "unprobed" ? "stuck" : shown;

  // `result` is shown and spoken; `spoken` adds what only needs saying because
  // the banner's own change already shows it.
  let result: string | null = null;
  let spoken: string | null = null;
  if (actionError === "enable") result = "Couldn't enable WSL git.";
  else if (actionError === "dismiss") result = "Couldn't hide this.";
  else if (recheck.phase === "done" && recheck.at === eligibility) {
    if (recheck.outcome === "failed") result = "Couldn't re-check.";
    else if (recheck.outcome === "no-answer") result = "WSL didn't answer.";
    else if (recheck.outcome === "unchanged" && view === "ineligible")
      result = "Checked. Still not the default distro.";
    else if (recheck.outcome === "changed" && view === "eligible")
      spoken = "Checked. WSL git is available for this worktree.";
    else if (recheck.outcome === "changed" && view === "ineligible")
      spoken = "Checked. Git runs from Windows for this worktree.";
  } else if (stallAnnounced && view === "stuck") {
    spoken = "Couldn't read your default WSL distro. Git runs from Windows for now.";
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
        // Inert: every WSL card probes at once, and a status region per card
        // would announce the same wait once for each of them.
        <>
          <span className="sr-only">Checking WSL distro</span>
          <Skeleton inert className="flex min-w-0 flex-1 gap-2">
            <SkeletonBone className="my-px h-3.5 w-3.5 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <SkeletonBone className="my-0.5 h-3 w-1/2" />
                <SkeletonBone className="my-0.5 h-3 w-full" />
                <SkeletonBone className="my-0.5 h-3 w-2/3" />
              </div>
              <SkeletonBone className="h-7 w-28" />
            </div>
          </Skeleton>
        </>
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
                    Git runs from Windows. Run it in {distro ?? "WSL"} for{" "}
                    <span className="whitespace-nowrap">5–10×</span> faster status checks.
                  </>
                ) : view === "ineligible" ? (
                  <>
                    {distro ?? "This worktree's distro"} isn't your default WSL distro, so git can't
                    run inside it.
                  </>
                ) : (
                  "Git runs from Windows for now, which may be slower."
                )}
              </span>
            </div>
            {result && (
              <p aria-hidden="true" className="text-text-secondary">
                {result}
              </p>
            )}
            {/* The card selects its worktree on any click that reaches it
                (#10319 / #12087). Guarding the row rather than each handler
                also covers a press on a loading or disabled button, which is
                pointer-events-none and lets the click land here instead. */}
            <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
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
      {/* Always mounted and never display:none, so it is in the accessibility
          tree before a result is written into it. */}
      <span role="status" aria-live="polite" className="sr-only">
        {result ?? spoken}
      </span>
    </div>
  );
});
