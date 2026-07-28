// Launch-failure toasts/banner routing and the resume auto-dismiss banner,
// split out of HelpSessionController.ts (#11009). No behavior change — the
// notify() calls and timers are unchanged, just relocated.

import { getAgentConfig } from "@/config/agents";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import type { HelpSessionSnapshot, LaunchErrorKind } from "./HelpSessionController";

const RESUME_BANNER_AUTO_DISMISS_MS = 4_000;

/**
 * Workspace state hasn't hydrated yet — retrying really does help.
 * Says "workspace", not "project": a scratch is an equally valid assistant
 * workspace (#11068).
 */
export const LAUNCH_BLOCKED_LOADING = "Workspace state is still loading. Try again.";

/**
 * Hydrated, but nothing is open. Both assistant launch paths used to report
 * this as "Project state is still loading", which was a lie in a scratch
 * workspace and unhelpful everywhere else (#11068).
 */
export const LAUNCH_BLOCKED_NO_WORKSPACE =
  "No project or scratch workspace is active. Open one, then try again.";

// Exported directly: the launch FSM also calls this before a launch reaches
// the version gate (e.g. workspace state still loading), not just from
// `surfaceLaunchError`. The `help.launchAgent` action shares it too, so both
// launch entry points fail with identical copy.
export function notifyLaunchFailed(agentId: string, reason: string): void {
  const cfg = getAgentConfig(agentId);
  const name = cfg?.name ?? agentId;
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({
    type: "error",
    title: "Assistant launch failed",
    message: `Couldn't start ${name}. ${reason}`,
  });
}

function notifyAssistantServicesUnavailable(
  kind: "mcp-server-not-started" | "mcp-probe-failed"
): void {
  notify({
    type: "error",
    title: "Assistant couldn't start",
    // Mirror the inline banner's per-kind discrimination on the closed-panel
    // fallback so the two failure modes read differently here too.
    message:
      kind === "mcp-probe-failed"
        ? "Daintree's assistant services didn't respond in time. Check assistant settings, then try again."
        : "Daintree's assistant services didn't start. Check assistant settings, then try again.",
    action: {
      label: "Open settings",
      actionId: "app.settings.openTab",
      actionArgs: { tab: "assistant" },
      onClick: () => {
        void actionService.dispatch("app.settings.openTab", { tab: "assistant" });
      },
    },
  });
}

// Mirrors the `folder-unavailable` banner's primary recovery affordance on
// the closed-panel toast. Single action keeps parity with the established
// `notifyAssistantServicesUnavailable` shape; the secondary "Open logs" CTA
// on the banner is reachable by reopening the panel.
function notifyInstallCorrupted(agentId: string): void {
  const cfg = getAgentConfig(agentId);
  const name = cfg?.name ?? agentId;
  // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
  notify({
    type: "error",
    title: "Assistant files missing",
    message: `Couldn't start ${name}. Daintree's bundled assistant files are missing — reinstall or check the logs.`,
    action: {
      label: "Open installer page",
      actionId: "system.openExternal",
      actionArgs: { url: "https://daintree.org/download" },
      onClick: () => {
        void actionService.dispatch(
          "system.openExternal",
          { url: "https://daintree.org/download" },
          { source: "user" }
        );
      },
    },
  });
}

export interface LaunchNotificationsHost {
  patch(partial: Partial<HelpSessionSnapshot>): void;
  isPanelOpen(): boolean;
}

/**
 * Owns launch-failure toast/banner routing plus the resume-success banner's
 * auto-dismiss timer.
 */
export class LaunchNotifications {
  private _resumeBannerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: LaunchNotificationsHost) {}

  /** Clears the banner timer — called on controller stop(). */
  dispose(): void {
    this._clearResumeBannerTimer();
  }

  dismissResumeBanner(): void {
    this._clearResumeBannerTimer();
    this.host.patch({ showResumeBanner: false });
  }

  armResumeBannerAutoDismiss(): void {
    this._clearResumeBannerTimer();
    this._resumeBannerTimer = setTimeout(() => {
      this._resumeBannerTimer = null;
      this.host.patch({ showResumeBanner: false });
    }, RESUME_BANNER_AUTO_DISMISS_MS);
  }

  /**
   * Route a launch failure to the least-restricted surface that conveys it.
   * When the panel is open, the failure becomes an inline banner the user can
   * retry from in place; when it's closed, we fall back to a toast so the
   * failure isn't lost. The MCP failure kinds keep the settings-routing toast
   * (a real recovery action); everything else uses the plain launch-failed
   * toast.
   */
  surfaceLaunchError(agentId: string, kind: LaunchErrorKind): void {
    if (this.host.isPanelOpen()) {
      this.host.patch({ launchError: Object.freeze({ agentId, kind }) });
      return;
    }
    if (kind === "mcp-server-not-started" || kind === "mcp-probe-failed") {
      notifyAssistantServicesUnavailable(kind);
    } else if (kind === "folder-unavailable") {
      notifyInstallCorrupted(agentId);
    } else if (kind === "skills-sync-failed") {
      notifyLaunchFailed(
        agentId,
        "Daintree couldn't refresh this project's assistant commands and skills. Try again."
      );
    } else {
      notifyLaunchFailed(agentId, "The agent didn't start. Try again.");
    }
  }

  private _clearResumeBannerTimer(): void {
    if (this._resumeBannerTimer) {
      clearTimeout(this._resumeBannerTimer);
      this._resumeBannerTimer = null;
    }
  }
}
