import { useCallback, useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { terminalClient } from "@/clients/terminalClient";
import { pluralize } from "@/lib/pluralize";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { usePanelStore } from "@/store/panelStore";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import type { RestartAccountChoice } from "@/components/Terminal/RestartOnAccount";
import { restartPanesOnPreset } from "@/components/Terminal/restartPanesOnPreset";

/**
 * An account an agent was just switched to, or just given (#16136), and the
 * panes stopped on a usage limit that it could take. Raised by the switch
 * itself, which is a fact Daintree made: a `/login` typed in a pane is not.
 */
export interface AccountSwitchNoticeState {
  agentId: string;
  /** `id: null` is the CLI's default login. */
  account: RestartAccountChoice;
  /** What the host reported when the switch was made. */
  paneIds: readonly string[];
}

/**
 * A pane an account switch could move: this agent's, live, and not already
 * on that account. Whether it is stopped on a limit is the host's to say.
 */
export function isAccountSwitchCandidate(
  panel: PanelInstance | undefined,
  agentId: string,
  accountId: string | null
): boolean {
  if (!panel || !isPtyPanel(panel)) return false;
  return (
    panel.launchAgentId === agentId &&
    // The restart relaunches the launch agent, so a pane now running another
    // agent's CLI is not this agent's limit to lift.
    getRuntimeOrBootAgentId(panel) === agentId &&
    (panel.agentAccountId ?? null) !== accountId &&
    !panel.isRestarting &&
    !panel.restoreRecovery &&
    panel.location !== "trash" &&
    panel.agentState !== "exited" &&
    panel.exitCode === undefined
  );
}

/**
 * The candidates whose host still remembers a usage-limit banner: kept until
 * the pane works again, long after the header chip has gone, and read from
 * the host so a view opened since still sees it. A pane the host can't
 * answer for is left out rather than guessed at.
 */
export async function readUsageLimitedPaneIds(
  agentId: string,
  accountId: string | null
): Promise<string[]> {
  const { panelIds, panelsById } = usePanelStore.getState();
  const candidates = panelIds.filter((id) =>
    isAccountSwitchCandidate(panelsById[id], agentId, accountId)
  );
  const limited = await Promise.all(
    candidates.map(async (id) => {
      try {
        const info = await terminalClient.getInfo(id);
        return info.hasPty && info.usageLimitObservedAt !== undefined ? id : null;
      } catch {
        return null;
      }
    })
  );
  return limited.filter((id): id is string => id !== null);
}

/** The notice's panes that can still be moved: one closed or restarted since drops out. */
export function useAccountSwitchPaneIds(notice: AccountSwitchNoticeState | null): string[] {
  return usePanelStore(
    useShallow((state) => {
      if (!notice) return [];
      return notice.paneIds.filter((id) =>
        isAccountSwitchCandidate(state.panelsById[id], notice.agentId, notice.account.id)
      );
    })
  );
}

export function limitedPanesLabel(count: number, agentName: string): string {
  return `${pluralize(count, `${agentName} pane`)} stopped on a usage limit`;
}

export function switchPanesLabel(count: number, accountName: string): string {
  return `${count === 1 ? "Switch it" : "Switch them"} to ${accountName}…`;
}

/** Rows for the bottom of the agent's picker: what is limited, Switch and Keep. */
export function AccountSwitchNoticeItems({
  agentName,
  notice,
  paneIds,
  onSwitch,
  onKeep,
}: {
  agentName: string;
  notice: AccountSwitchNoticeState;
  paneIds: readonly string[];
  onSwitch: () => void;
  onKeep: () => void;
}) {
  if (paneIds.length === 0) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <div role="status" className="px-2 py-1.5 text-xs text-text-secondary">
        {limitedPanesLabel(paneIds.length, agentName)}
      </div>
      <DropdownMenuItem inset onSelect={onSwitch}>
        {switchPanesLabel(paneIds.length, notice.account.name)}
      </DropdownMenuItem>
      <DropdownMenuItem
        inset
        onSelect={(event) => {
          // Keeps the picker open: leaving the panes where they are isn't a choice of account.
          event.preventDefault();
          onKeep();
        }}
      >
        Keep
      </DropdownMenuItem>
    </>
  );
}

export interface AccountSwitchRequest {
  account: RestartAccountChoice;
  /** Frozen when asked, so the confirm acts on exactly the panes it named. */
  panes: { id: string; title: string; worktree: string | undefined; working: boolean }[];
}

export function buildAccountSwitchRequest(
  notice: AccountSwitchNoticeState,
  paneIds: readonly string[]
): AccountSwitchRequest {
  const panelsById = usePanelStore.getState().panelsById;
  const worktrees = getCurrentViewStoreOrNull()?.getState().worktrees;
  return {
    account: notice.account,
    panes: paneIds.map((id) => {
      const panel = panelsById[id];
      return {
        id,
        title: panel?.title?.trim() || id,
        worktree: panel?.worktreeId ? worktrees?.get(panel.worktreeId)?.name : undefined,
        working: terminalHasRunningAgentSession(panel),
      };
    }),
  };
}

/**
 * One confirm naming every pane, each with its own box so the switch takes
 * one, some or all of them; then one account switch per checked pane, through
 * the same action as the pane menu's, so the conversation follows its rules.
 */
export function AccountSwitchDialog({
  request,
  onClose,
}: {
  request: AccountSwitchRequest | null;
  onClose: () => void;
}) {
  if (!request) return null;
  const key = `${request.account.id ?? ""}:${request.panes.map((pane) => pane.id).join(",")}`;
  return <OpenAccountSwitchDialog key={key} request={request} onClose={onClose} />;
}

function OpenAccountSwitchDialog({
  request,
  onClose,
}: {
  request: AccountSwitchRequest;
  onClose: () => void;
}) {
  const labelIdPrefix = useId();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(request.panes.map((pane) => pane.id))
  );
  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const chosen = request.panes.filter((pane) => selected.has(pane.id));
  const count = chosen.length;
  const working = chosen.filter((pane) => pane.working).length;
  const accountName = request.account.name;

  const handleConfirm = () => {
    if (count === 0) return;
    onClose();
    void restartPanesOnPreset(
      chosen,
      accountName,
      (pane) =>
        actionService.dispatch(
          "terminal.restartOnAccount",
          { terminalId: pane.id, accountId: request.account.id, confirmed: true },
          { source: "user" }
        ),
      (restarted) => `Restarting ${pluralize(restarted, "pane")} on ${accountName}`
    );
  };

  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      title={`Restart ${pluralize(count, "pane")} on '${accountName}'?`}
      description={
        <>
          {working > 0 && (
            <span className="block font-medium text-text-primary">
              {pluralize(working, "agent is working", "agents are working")} and will be
              interrupted.
            </span>
          )}
          <span className={working > 0 ? "mt-1 block" : undefined}>
            {count === 1
              ? "It keeps its preset and starts a new conversation on that account, and the scrollback is discarded."
              : "Each keeps its preset and starts a new conversation on that account, and its scrollback is discarded."}
          </span>
        </>
      }
      confirmLabel={count === 1 ? "Restart pane" : `Restart ${pluralize(count, "pane")}`}
      confirmDisabled={count === 0}
      variant="destructive"
      onConfirm={handleConfirm}
    >
      <ul className="mt-2 space-y-1" data-testid="account-switch-panes">
        {request.panes.map((pane) => {
          const labelId = `${labelIdPrefix}-${pane.id}`;
          return (
            <li key={pane.id} className="relative flex items-start gap-2 py-0.5">
              <Checkbox
                size="sm"
                checked={selected.has(pane.id)}
                onCheckedChange={() => toggle(pane.id)}
                aria-labelledby={labelId}
                // The whole row is the hit area, without a second control to step past.
                className="static mt-0.5 before:absolute before:inset-0 before:content-['']"
              />
              <span id={labelId} className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
                <span className="truncate text-text-primary">{pane.title}</span>
                {pane.worktree && (
                  <span className="min-w-0 truncate text-xs text-text-secondary">
                    {pane.worktree}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </ConfirmDialog>
  );
}
