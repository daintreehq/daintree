import React, { useCallback, useState } from "react";
import type { WslGitEligibility } from "@shared/types";
import { worktreeConfigClient } from "@/clients/worktreeConfigClient";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { logError } from "@/utils/logger";
import { cn } from "../../../lib/utils";

export interface WslGitBannerProps {
  worktreeId: string;
  wslDistro?: string;
  wslGitEligible?: WslGitEligibility;
}

const BANNER_SHELL = cn(
  "mx-3 my-2 rounded-md border border-border-default bg-overlay-subtle px-3 py-2",
  "flex items-start gap-3 text-sm"
);

// If the probe hasn't resolved this long, treat the skeleton as stuck (WSL
// unavailable / probe failed upstream) and surface a manual Re-check so the
// user isn't stranded staring at a perpetual skeleton. Mirrors the ">5s →
// persistent skeleton + recovery" tier of the loading-indicator rules.
const WSL_PROBE_STUCK_MS = 5000;

/**
 * Inline banner shown on WSL-mounted worktrees suggesting the user route git
 * through `wsl git` to avoid the 9P boundary slowdown. Three states driven by
 * `wslGitEligible`:
 *
 * - `'eligible'`: "Enable WSL git" + "Not now" buttons. Enabling persists the
 *   opt-in and re-routes git invocations on the next poll cycle.
 *
 * - `'ineligible'`: read-only informational note — the worktree is in a
 *   non-default distro and we can't safely route through `wsl.exe git` without
 *   distro-specific args. Carries a "Re-check" button: the default distro can
 *   change mid-session, so re-probing can flip this worktree back to eligible.
 *
 * - `'unprobed'` (or absent): the default-distro probe hasn't resolved yet or
 *   failed. Shows a Doherty-gated skeleton; a re-check is offered if the probe
 *   stalls.
 */
export const WslGitBanner = React.memo(function WslGitBanner({
  worktreeId,
  wslDistro,
  wslGitEligible,
}: WslGitBannerProps) {
  const [busy, setBusy] = useState(false);
  const [reprobing, setReprobing] = useState(false);
  const [reprobeFailed, setReprobeFailed] = useState(false);

  // Treat a missing value as "unprobed" — older snapshots predate the field.
  const eligibility: WslGitEligibility = wslGitEligible ?? "unprobed";
  const probePending = eligibility === "unprobed" && !reprobeFailed;
  const showProbeSkeleton = useDeferredLoading(probePending, UI_DOHERTY_THRESHOLD);
  const probeStuck = useDeferredLoading(probePending, WSL_PROBE_STUCK_MS);

  // Promise-method cleanup instead of try/finally: statement-level finally
  // clauses bail React Compiler memoization for the whole component.
  const handleEnable = useCallback(() => {
    if (busy) return;
    setBusy(true);
    worktreeConfigClient
      .setWslGit(worktreeId, true)
      .catch((err) => {
        logError("Failed to enable WSL git for worktree", err, { worktreeId });
      })
      .finally(() => {
        setBusy(false);
      });
  }, [worktreeId, busy]);

  const handleDismiss = useCallback(() => {
    if (busy) return;
    setBusy(true);
    worktreeConfigClient
      .dismissWslBanner(worktreeId)
      .catch((err) => {
        logError("Failed to dismiss WSL git banner", err, { worktreeId });
      })
      .finally(() => {
        setBusy(false);
      });
  }, [worktreeId, busy]);

  const handleReprobe = useCallback(() => {
    if (reprobing) return;
    setReprobing(true);
    setReprobeFailed(false);
    worktreeConfigClient
      .reprobeWsl(worktreeId)
      .catch((err) => {
        logError("Failed to re-check WSL distro for worktree", err, { worktreeId });
        setReprobeFailed(true);
      })
      .finally(() => {
        setReprobing(false);
      });
  }, [worktreeId, reprobing]);

  if (eligibility === "eligible") {
    return (
      <div role="status" className={BANNER_SHELL}>
        <div className="flex-1">
          <div className="font-medium text-text-primary">Speed up git on this WSL worktree</div>
          <div className="mt-0.5 text-text-secondary">
            This worktree lives in WSL ({wslDistro ?? "unknown distro"}). Routing git through{" "}
            <code className="rounded bg-overlay-subtle px-1 py-0.5">wsl git</code> avoids the
            Windows–Linux filesystem boundary and can make status polling 5–10× faster.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleEnable}
            disabled={busy}
            className={cn(
              "rounded border border-border-default bg-overlay-strong px-2 py-1 text-xs",
              "transition-colors duration-150 hover:bg-overlay-hover",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            Enable WSL git
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={busy}
            className={cn(
              "rounded px-2 py-1 text-xs text-text-secondary",
              "transition-colors duration-150 hover:text-text-primary",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            Not now
          </button>
        </div>
      </div>
    );
  }

  if (eligibility === "unprobed") {
    // Probe hasn't resolved. A user-initiated re-check that errored, or a probe
    // stuck past the threshold (WSL unavailable), both surface a recovery
    // affordance so the user is never stranded on a perpetual skeleton.
    if (reprobeFailed || probeStuck) {
      return (
        <div role="status" className={BANNER_SHELL}>
          <div className="flex-1">
            <div className="font-medium text-text-primary">Couldn't check WSL distro</div>
            <div className="mt-0.5 text-text-secondary">
              The WSL default distro couldn't be read, so git routing for this worktree is
              undetermined. Git runs from Windows in the meantime.
            </div>
          </div>
          <button
            type="button"
            onClick={handleReprobe}
            disabled={reprobing}
            className={cn(
              "shrink-0 rounded border border-border-default bg-overlay-strong px-2 py-1 text-xs",
              "transition-colors duration-150 hover:bg-overlay-hover",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            {reprobing ? "Re-checking…" : "Re-check"}
          </button>
        </div>
      );
    }
    if (!showProbeSkeleton) return null;
    return (
      <div role="status" aria-busy="true" className={BANNER_SHELL}>
        <div className="flex-1">
          <div className="h-4 w-48 animate-pulse-delayed rounded bg-overlay-strong" />
          <div className="mt-1.5 h-3 w-full animate-pulse-delayed rounded bg-overlay-subtle" />
        </div>
      </div>
    );
  }

  // eligibility === "ineligible"
  return (
    <div role="status" className={BANNER_SHELL}>
      <div className="flex-1">
        <div className="font-medium text-text-primary">Git runs via Windows</div>
        <div className="mt-0.5 text-text-secondary">
          This worktree is in{" "}
          <code className="rounded bg-overlay-subtle px-1 py-0.5">{wslDistro ?? "WSL"}</code>, which
          isn't the default WSL distro. Git can't be routed through this distro automatically — it
          will run from Windows and may be slower than usual.
        </div>
        {reprobeFailed && (
          <div className="mt-1 text-text-secondary">Couldn't re-check — try again.</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={handleReprobe}
          disabled={reprobing}
          className={cn(
            "rounded border border-border-default bg-overlay-strong px-2 py-1 text-xs",
            "transition-colors duration-150 hover:bg-overlay-hover",
            "disabled:cursor-not-allowed disabled:opacity-60"
          )}
        >
          {reprobing ? "Re-checking…" : "Re-check"}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={busy}
          className={cn(
            "rounded px-2 py-1 text-xs text-text-secondary",
            "transition-colors duration-150 hover:text-text-primary",
            "disabled:cursor-not-allowed disabled:opacity-60"
          )}
        >
          Got it
        </button>
      </div>
    </div>
  );
});
