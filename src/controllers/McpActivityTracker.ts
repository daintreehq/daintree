// MCP tool-call activity strip, tier-mismatch approval flow, per-tool grant
// lifecycle, session-revoked banner, and the turn-outcome alert pip — split
// out of HelpSessionController.ts (#11009). No behavior change — the IPC
// listeners and their handlers are unchanged, just relocated.

import { useProjectStore } from "@/store";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { projectClient } from "@/clients/projectClient";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  ActiveGrantState,
  HelpSessionSnapshot,
  GrantEndReason,
} from "./HelpSessionController";
import type { McpGrantLifecyclePayload } from "@shared/types/ipc/mcpServer";

const GRANT_ENDED_BANNER_AUTO_DISMISS_MS = 15_000;

// Native grants are told apart by `grantId` (their lazy expiry names the tool
// that tripped it, not "*"); per-tool grants, which carry none, by tool.
function grantKeyOf(payload: McpGrantLifecyclePayload): string {
  return payload.grantId !== undefined
    ? `native:${payload.sessionId}:${payload.grantId}`
    : `tool:${payload.sessionId}:${payload.toolId}`;
}

export interface McpActivityTrackerHost {
  getSnapshot(): HelpSessionSnapshot;
  patch(partial: Partial<HelpSessionSnapshot>): void;
  /**
   * The MCP session id of the lane this tracker belongs to, or null before one
   * is bound (#12108).
   *
   * Deliberately NOT read off the global store. Every push below is targeted
   * at a WebContents, and with concurrent lanes all of a project's sessions
   * share one — so routing can no longer say which lane an event belongs to
   * and the payload's session id is the only thing that can. Sourcing this
   * from the host keeps each tracker comparing against ITS OWN session rather
   * than whichever lane happens to be focused.
   */
  getSessionId(): string | null;
  /**
   * The lane this tracker writes figures into. A function rather than a value
   * because the host constructs this tracker in a class field initializer,
   * which runs before its own constructor body has assigned the lane.
   */
  getSlot(): number;
}

/**
 * Owns the MCP tool-call activity strip, tier-mismatch approval flow,
 * per-tool grant lifecycle countdown/notice, session-revoked banner, and the
 * turn-outcome alert pip. Registers its own IPC listeners in `start()`,
 * torn down in `dispose()`.
 */
export class McpActivityTracker {
  private _outcomeAlertTurnId: string | null = null;
  private _grantEndedBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposers: Array<() => void> = [];

  constructor(private readonly host: McpActivityTrackerHost) {}

  /**
   * Whether an incoming push belongs to this tracker's lane.
   *
   * A live session always commits its id before any tool call — and thus
   * before any denial, grant or revoke — so a null or mismatched id means the
   * event is for a sibling lane, or for a torn-down / mid-relaunch session of
   * our own. Painting either would stomp the lane the user is actually in
   * (#10017, generalized to lanes in #12108).
   */
  private _isMine(sessionId: string | null | undefined): boolean {
    const mine = this.host.getSessionId();
    return mine !== null && sessionId === mine;
  }

  /** Arm IPC subscriptions. Idempotency is the caller's responsibility (controller `start()`). */
  start(): void {
    const disposeTier = window.electron.mcpServer.onTierNotPermitted((payload) => {
      if (!this._isMine(payload.sessionId)) return;
      const projectId = useProjectStore.getState().currentProject?.id ?? null;
      // A fresh denial supersedes any lingering "approval ended" notice — the
      // banner the user is about to re-approve from carries the same signal.
      this._clearGrantEndedTimer();
      this.host.patch({
        tierMismatch: {
          sessionId: payload.sessionId,
          toolId: payload.toolId,
          tier: payload.tier,
          targetTier: payload.targetTier,
          projectId,
        },
        grantEnded: null,
      });
    });
    this._disposers.push(disposeTier);

    const disposeRevoked = window.electron.mcpServer.onSessionRevoked((payload) => {
      if (!this._isMine(payload.sessionId)) return;
      this.host.patch({
        sessionRevoked: { sessionId: payload.sessionId, denialKind: payload.denialKind },
      });
    });
    this._disposers.push(disposeRevoked);

    const disposeGrant = window.electron.mcpServer.onGrantLifecycle((payload) => {
      if (!this._isMine(payload.sessionId)) return;
      this._onGrantLifecycle(payload);
    });
    this._disposers.push(disposeGrant);

    const disposeToolStarted = window.electron.mcpServer.onToolCallStarted((payload) => {
      if (!this._isMine(payload.sessionId)) return;
      this._onToolCallStarted(payload);
    });
    const disposeToolSettled = window.electron.mcpServer.onToolCallSettled((payload) => {
      if (!this._isMine(payload.sessionId)) return;
      this._onToolCallSettled(payload);
    });
    this._disposers.push(disposeToolStarted, disposeToolSettled);

    const disposeOutcomeAlert = window.electron.mcpServer.onTurnOutcomeAlert((payload) => {
      // This channel names the lane with `helpSessionId` rather than
      // `sessionId`; both are the same public help-session id.
      if (!this._isMine(payload.helpSessionId)) return;
      this._onTurnOutcomeAlert(payload);
    });
    this._disposers.push(disposeOutcomeAlert);

    const disposeDisplayImage = window.electron.mcpServer.onDisplayImage((payload) => {
      // Gate before writing: figures are per lane, so an unfiltered push would
      // file a sibling's image under this conversation (#12108).
      if (!this._isMine(payload.sessionId)) return;
      // The main process already validated the URL and assigned the figure
      // number (#9828); the renderer just records the figure for inline display.
      useHelpPanelStore.getState().addFigure(this.host.getSlot(), {
        imageId: payload.imageId,
        figureNumber: payload.figureNumber,
        figureLabel: payload.figureLabel,
        url: payload.url,
        ...(payload.caption !== undefined ? { caption: payload.caption } : {}),
        ...(payload.altText !== undefined ? { altText: payload.altText } : {}),
      });
    });
    this._disposers.push(disposeDisplayImage);
  }

  /** Unsubscribe all IPC listeners and clear the grant-ended timer. */
  dispose(): void {
    for (const dispose of this._disposers) {
      try {
        dispose();
      } catch (err) {
        logError("McpActivityTracker: disposer threw", err);
      }
    }
    this._disposers = [];
    this._clearGrantEndedTimer();
  }

  dismissTierMismatch(): void {
    // Capture the session before clearing the banner — `patch` runs
    // synchronously, so reading after would see a null `tierMismatch`.
    const sessionId = this.host.getSnapshot().tierMismatch?.sessionId ?? null;
    this.host.patch({ tierMismatch: null });
    if (!sessionId) return;
    // Dismissing the banner without approving must re-arm it: reset the
    // denial counters so the next out-of-tier call shows the banner again
    // instead of being silently suppressed once the abuse policy threshold is
    // crossed (#10017). This clears the counters for ALL tools in the session,
    // not just the dismissed one — Cancel means "show me again for anything in
    // this session"; the threshold re-accrues from zero per tool. Grants
    // (the per-tool approval lifecycle) are left untouched.
    safeFireAndForget(window.electron.mcpServer.resetDenialCounts({ sessionId }), {
      context: "Help: reset denial counts on tier-mismatch dismiss",
    });
  }

  dismissSessionRevoked(): void {
    this.host.patch({ sessionRevoked: null });
  }

  dismissGrantEnded(): void {
    this._clearGrantEndedTimer();
    this.host.patch({ grantEnded: null });
  }

  /**
   * End one live grant early (#10042), leaving the session's others alone
   * (#14975): a per-tool grant by its `(session, toolId)`, a native automation
   * grant by its id. Normally the `grant.revoked` lifecycle event (reason
   * `user`) removes its row first; the `.then` removes it as a
   * renderer-authoritative fallback so a dropped event (WebContents torn down
   * before it fired) can't leave a zombie countdown. The fallback runs only on
   * success, so a failed revoke leaves the row up as its own retry surface.
   * No `ConfirmDialog` — the inverse (re-approve) is one tool call away.
   */
  revokeGrant(key: string): void {
    const { activeGrants, revokingGrantKeys } = this.host.getSnapshot();
    const grant = activeGrants.find((g) => g.key === key);
    if (!grant || revokingGrantKeys.includes(key)) return;
    this.host.patch({ revokingGrantKeys: [...revokingGrantKeys, key] });
    const request: Promise<unknown> =
      grant.grantId !== undefined
        ? window.electron.mcpServer.revokeNativeGrant({ grantId: grant.grantId })
        : window.electron.mcpServer.revokeGrant({
            sessionId: grant.sessionId,
            toolId: grant.toolId,
          });
    safeFireAndForget(
      request
        .then(() => {
          this._removeGrant(key);
        })
        .catch((err) => {
          // The grant is still live and its row stays put, so the row itself
          // is the retry surface — diagnostic only, no toast.
          logError("HelpPanel: revokeGrant failed", err);
        })
        .finally(() => {
          const pending = this.host.getSnapshot().revokingGrantKeys;
          if (!pending.includes(key)) return;
          this.host.patch({ revokingGrantKeys: pending.filter((k) => k !== key) });
        }),
      { context: "HelpPanel:revokeGrant" }
    );
  }

  approveTierOnce(): void {
    const current = this.host.getSnapshot().tierMismatch;
    if (!current?.targetTier || this.host.getSnapshot().isApprovingTier) return;
    const { sessionId, toolId } = current;
    this.host.patch({ isApprovingTier: true });
    safeFireAndForget(
      window.electron.mcpServer
        // The banner's "Allow this tool" mints a per-tool, time-bounded
        // grant for this session — it does NOT elevate the session tier. The
        // "Set project default" path is the only remaining caller of
        // `setSessionTier` (#8442).
        .issueGrant({ sessionId, toolId })
        .then(() => {
          this._clearTierMismatchIfStillCurrent(sessionId, toolId);
        })
        .catch((err) => {
          logError("HelpPanel: issueGrant failed", err);
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: "Couldn't approve tool",
            message: formatErrorMessage(err, "Couldn't grant access to this tool."),
          });
        })
        .finally(() => {
          this.host.patch({ isApprovingTier: false });
        }),
      { context: "HelpPanel:issueGrant" }
    );
  }

  alwaysAllowTier(): void {
    const current = this.host.getSnapshot().tierMismatch;
    if (!current?.targetTier || this.host.getSnapshot().isApprovingTier) return;
    // Use the project captured at event time — `current.projectId` is
    // immutable for this banner, so a project switch after the banner
    // appears doesn't redirect the save to the wrong project.
    const projectId = current.projectId ?? useProjectStore.getState().currentProject?.id ?? null;
    if (!projectId) {
      this.dismissTierMismatch();
      return;
    }
    const { targetTier, sessionId, toolId } = current;
    this.host.patch({ isApprovingTier: true });
    safeFireAndForget(
      (async () => {
        // projectClient.saveSettings goes directly to the IPC handler —
        // the `project.saveSettings` action sanitizes `daintreeMcpTier`
        // out to keep agents from self-elevating.
        const settings = await projectClient.getSettings(projectId);
        await projectClient.saveSettings(projectId, {
          ...settings,
          daintreeMcpTier: targetTier,
        });
        await window.electron.mcpServer.setSessionTier({ sessionId, tier: targetTier });
        this._clearTierMismatchIfStillCurrent(sessionId, toolId);
      })()
        .catch((err) => {
          logError("HelpPanel: always-allow tier write failed", err);
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: "Couldn't save permission",
            message: formatErrorMessage(err, "Couldn't update project tier setting."),
          });
        })
        .finally(() => {
          this.host.patch({ isApprovingTier: false });
        }),
      { context: "HelpPanel:alwaysAllowTier" }
    );
  }

  /**
   * Handle a live `tool-call-started` push (#9759). Coalesces bursts within
   * the same turn into a single row ("N calls · latest tool") and clears any
   * lingering errored row — a new call always supersedes the previous result.
   */
  private _onToolCallStarted(
    payload: import("@shared/types/ipc/mcpServer").McpToolCallStartedPayload
  ): void {
    const prev = this.host.getSnapshot().mcpActivity;
    // Coalesce only within the same turn: a burst of calls the model fires in
    // one turn collapses to a count, but a new turn starts a fresh row. Calls
    // outside a turn boundary (`turnId` absent) never coalesce — last wins.
    const sameTurn =
      prev !== null &&
      payload.turnId !== undefined &&
      prev.turnId !== undefined &&
      prev.turnId === payload.turnId;
    const callCount = sameTurn && prev ? prev.callCount + 1 : 1;
    // Outstanding-call tracking: a same-turn start joins the burst's pending
    // pool (settled rows have drained to 0). A new turn starts a fresh pool.
    const pendingCalls = sameTurn && prev ? prev.pendingCalls + 1 : 1;
    this.host.patch({
      mcpActivity: {
        status: "in-flight",
        toolId: payload.toolId,
        argsSummary: payload.argsSummary,
        startedAt: payload.startedAt,
        danger: payload.danger,
        callCount,
        pendingCalls,
        ...(payload.turnId !== undefined ? { turnId: payload.turnId } : {}),
        isError: false,
      },
    });
    // Auto-clear the outcome pip (#10018) once the agent resumes work in a
    // fresh turn — a tool call whose turn differs from the alert's turn means
    // the stuck/looping turn is behind us. `agent-stuck` alerts carry no turn
    // id (`_outcomeAlertTurnId` is null), so any turn-stamped call clears them.
    if (
      this.host.getSnapshot().outcomeAlert !== null &&
      payload.turnId !== undefined &&
      payload.turnId !== this._outcomeAlertTurnId
    ) {
      this.host.patch({ outcomeAlert: null });
    }
  }

  /**
   * Handle a live `tool-call-settled` push (#9759). Transitions the current
   * in-flight row to its settled (dimmed glyph + duration) appearance. A push
   * with no current row is ignored — there's nothing on screen to settle.
   */
  private _onToolCallSettled(
    payload: import("@shared/types/ipc/mcpServer").McpToolCallSettledPayload
  ): void {
    const prev = this.host.getSnapshot().mcpActivity;
    if (prev === null) return;
    // A settle from a different turn must not regress the current row — a
    // slow call from the previous turn can land after the next turn's call
    // already started. Settles with no turnId (turn boundary already passed,
    // or no turn was active) still apply: they belong to the row last shown.
    if (
      prev.turnId !== undefined &&
      payload.turnId !== undefined &&
      payload.turnId !== prev.turnId
    ) {
      return;
    }
    // Drain one call from the burst's pending pool. While calls remain
    // outstanding the row stays in-flight — an early settle from call A must
    // not flip a coalesced row to "settled" while call B is still running.
    const pendingCalls = Math.max(0, prev.pendingCalls - 1);
    if (prev.status === "in-flight" && pendingCalls > 0) {
      this.host.patch({ mcpActivity: { ...prev, pendingCalls } });
      return;
    }
    const isError = payload.severity === "error" || payload.severity === "critical";
    this.host.patch({
      mcpActivity: {
        ...prev,
        status: "settled",
        // Reflect the settled call's tool so the glyph labels the right call
        // even when a burst's latest started differs from what just settled.
        toolId: payload.toolId,
        danger: false,
        durationMs: payload.durationMs,
        result: payload.result,
        severity: payload.severity,
        isError,
        pendingCalls,
      },
    });
  }

  /**
   * Handle a live turn-outcome alert push (#10018). Surfaces the `agent-stuck`
   * / `reasoning-loop` outcome as the footer's ambient pip. The targeted send
   * already routes only to this session's pinned WebContents, so no session
   * filtering is needed here (matches `_onToolCallStarted`). The carried turn
   * id (absent for `agent-stuck`) is retained so the pip auto-clears once the
   * agent starts a fresh turn.
   */
  private _onTurnOutcomeAlert(
    payload: import("@shared/types/ipc/mcpServer").McpTurnOutcomeAlertPayload
  ): void {
    this._outcomeAlertTurnId = payload.turnId ?? null;
    this.host.patch({ outcomeAlert: payload.outcome });
  }

  /** Dismiss the ambient outcome pip (#10018). User-driven click-to-clear. */
  dismissOutcomeAlert(): void {
    this.clearOutcomeAlert();
  }

  /**
   * Drop any pending outcome pip and its retained turn id (#10018). Shared by
   * the user dismiss path and session teardown/replacement — a pip for a
   * session that's gone must never linger into its successor.
   */
  clearOutcomeAlert(): void {
    this._outcomeAlertTurnId = null;
    if (this.host.getSnapshot().outcomeAlert === null) return;
    this.host.patch({ outcomeAlert: null });
  }

  /** Clear the live activity strip (e.g. on session teardown). */
  clearActivity(): void {
    if (this.host.getSnapshot().mcpActivity === null) return;
    this.host.patch({ mcpActivity: null });
  }

  /**
   * Consume a live grant lifecycle push (#10042). `grant.issued` adds the
   * grant's countdown (or replaces the same grant's, on a re-approval) and
   * dismisses the mismatch that prompted it; `grant.refreshed` moves its
   * deadline after a use slides it (#14998); `grant.expired`/`grant.revoked`
   * retire its row and, for the two user-actionable reasons, surface a brief
   * "approval ended" notice; a native grant's `grant.exhausted` retires its row
   * silently. Every case but `issued` touches only the grant it names, so a
   * push for one tool can't move or wipe another's countdown, and a refresh
   * never re-arms a row that's already gone. `tier.elevated`/`tier.decayed`
   * are session-tier transitions, not grants — they leave the countdowns
   * untouched (the audit viewer records them). Native automation grants
   * (#10648) all share `toolId: "*"`, so they are matched by `grantId`, or one
   * native grant's use would move another's countdown.
   */
  private _onGrantLifecycle(
    payload: import("@shared/types/ipc/mcpServer").McpGrantLifecyclePayload
  ): void {
    const key = grantKeyOf(payload);
    const { activeGrants } = this.host.getSnapshot();
    if (payload.type === "grant.issued") {
      // `expiresAt` is always set on `grant.issued`; bail defensively if a
      // malformed payload omits it rather than seed a NaN countdown.
      if (payload.expiresAt === undefined) return;
      this._clearGrantEndedTimer();
      const grant: ActiveGrantState = {
        key,
        sessionId: payload.sessionId,
        toolId: payload.toolId,
        expiresAt: payload.expiresAt,
        maxExpiresAt: payload.maxExpiresAt,
        ttlMs: payload.ttlMs,
        grantId: payload.grantId,
        allowedTools: payload.allowedTools,
      };
      const index = activeGrants.findIndex((g) => g.key === key);
      this.host.patch({
        activeGrants:
          index === -1
            ? [...activeGrants, grant]
            : activeGrants.map((g, i) => (i === index ? grant : g)),
        grantEnded: null,
      });
      // The mint resolves the mismatch that triggered it. Idempotent with the
      // fallback clear in `approveTierOnce`'s `.then` — whichever runs first.
      this._clearTierMismatchIfStillCurrent(payload.sessionId, payload.toolId);
      return;
    }
    const active = activeGrants.find((g) => g.key === key);
    if (!active) return;
    if (payload.type === "grant.refreshed") {
      if (payload.expiresAt === undefined) return;
      const expiresAt = payload.expiresAt;
      this.host.patch({
        activeGrants: activeGrants.map((g) =>
          g === active
            ? { ...g, expiresAt, maxExpiresAt: payload.maxExpiresAt ?? g.maxExpiresAt }
            : g
        ),
      });
      return;
    }
    if (payload.type === "grant.exhausted") {
      this._removeGrant(key);
      return;
    }
    if (payload.type === "grant.expired" || payload.type === "grant.revoked") {
      this._removeGrant(key);
      const reason = this._grantEndReason(payload);
      if (!reason) return;
      this._clearGrantEndedTimer();
      this.host.patch({ grantEnded: { toolId: active.toolId, reason } });
      this._armGrantEndedAutoDismiss();
    }
  }

  private _removeGrant(key: string): void {
    const { activeGrants } = this.host.getSnapshot();
    if (!activeGrants.some((g) => g.key === key)) return;
    this.host.patch({ activeGrants: activeGrants.filter((g) => g.key !== key) });
  }

  /**
   * The user-actionable subset of how a grant ended. Passive expiry and the
   * 30-minute ceiling are worth a notice; a user-initiated revoke and session
   * teardown/idle are not (the user did it, or the session is already gone).
   */
  private _grantEndReason(
    payload: import("@shared/types/ipc/mcpServer").McpGrantLifecyclePayload
  ): GrantEndReason | null {
    if (payload.type === "grant.expired") return "expired";
    return payload.revokedReason === "grant-ceiling" ? "grant-ceiling" : null;
  }

  clearGrantState(): void {
    this._clearGrantEndedTimer();
    // Clear the in-flight revokes too: a teardown mid-revoke would otherwise
    // leak a stuck-disabled "Revoke access" button into the next session.
    this.host.patch({ activeGrants: [], grantEnded: null, revokingGrantKeys: [] });
  }

  private _clearGrantEndedTimer(): void {
    if (this._grantEndedBannerTimer) {
      clearTimeout(this._grantEndedBannerTimer);
      this._grantEndedBannerTimer = null;
    }
  }

  private _armGrantEndedAutoDismiss(): void {
    this._clearGrantEndedTimer();
    this._grantEndedBannerTimer = setTimeout(() => {
      this._grantEndedBannerTimer = null;
      this.host.patch({ grantEnded: null });
    }, GRANT_ENDED_BANNER_AUTO_DISMISS_MS);
  }

  private _clearTierMismatchIfStillCurrent(sessionId: string, toolId: string): void {
    const current = this.host.getSnapshot().tierMismatch;
    if (current && current.sessionId === sessionId && current.toolId === toolId) {
      this.host.patch({ tierMismatch: null });
    }
  }
}
