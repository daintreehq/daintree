import React, { useCallback, useState } from "react";
import { worktreeConfigClient } from "@/clients/worktreeConfigClient";
import { logError } from "@/utils/logger";
import { cn } from "../../../lib/utils";

export interface WslGitBannerProps {
  worktreeId: string;
  wslDistro?: string;
  wslGitEligible?: boolean;
}

/**
 * Inline banner shown on WSL-mounted worktrees suggesting the user route git
 * through `wsl git` to avoid the 9P boundary slowdown. Two variants:
 *
 * - Eligible (`wslGitEligible === true`): "Enable WSL git" + "Not now" buttons.
 *   Enabling persists the opt-in and re-routes git invocations on the next
 *   poll cycle.
 *
 * - Ineligible (`wslGitEligible === false`): read-only informational note —
 *   the worktree is in a non-default distro and we can't safely route through
 *   `wsl.exe git` without distro-specific args.
 */
export const WslGitBanner = React.memo(function WslGitBanner({
  worktreeId,
  wslDistro,
  wslGitEligible,
}: WslGitBannerProps) {
  const [busy, setBusy] = useState(false);

  const handleEnable = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await worktreeConfigClient.setWslGit(worktreeId, true);
    } catch (err) {
      logError("Failed to enable WSL git for worktree", err, { worktreeId });
    } finally {
      setBusy(false);
    }
  }, [worktreeId, busy]);

  const handleDismiss = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await worktreeConfigClient.dismissWslBanner(worktreeId);
    } catch (err) {
      logError("Failed to dismiss WSL git banner", err, { worktreeId });
    } finally {
      setBusy(false);
    }
  }, [worktreeId, busy]);

  if (wslGitEligible) {
    return (
      <div
        role="status"
        className={cn(
          "mx-3 my-2 rounded-md border border-daintree-border bg-overlay-subtle px-3 py-2",
          "flex items-start gap-3 text-sm"
        )}
      >
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
              "rounded border border-daintree-border bg-overlay-strong px-2 py-1 text-xs",
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

  return (
    <div
      role="status"
      className={cn(
        "mx-3 my-2 rounded-md border border-daintree-border bg-overlay-subtle px-3 py-2",
        "flex items-start gap-3 text-sm"
      )}
    >
      <div className="flex-1">
        <div className="font-medium text-text-primary">WSL worktree (non-default distro)</div>
        <div className="mt-0.5 text-text-secondary">
          This worktree is in{" "}
          <code className="rounded bg-overlay-subtle px-1 py-0.5">{wslDistro ?? "WSL"}</code>, which
          isn't the default WSL distro. Daintree can't yet route git through this distro
          automatically — git will run from Windows and may be slower than usual.
        </div>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        disabled={busy}
        className={cn(
          "shrink-0 rounded px-2 py-1 text-xs text-text-secondary",
          "transition-colors duration-150 hover:text-text-primary",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
      >
        Got it
      </button>
    </div>
  );
});
