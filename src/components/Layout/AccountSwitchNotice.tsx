import { useId, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAgentConfig } from "@/config/agents";
import { terminalClient } from "@/clients/terminalClient";
import { pluralize } from "@/lib/pluralize";
import { actionService } from "@/services/ActionService";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { usePanelStore } from "@/store/panelStore";
import { terminalHasRunningAgentSession } from "@/utils/destructiveSessionConfirm";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { supportsConversationKeepingSwitch } from "@shared/types/agentSettings";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { defaultLoginLabel, sanitizeAgentAccounts } from "@shared/utils/agentAccounts";
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
  accountId: string | null,
  /** Only these panes, when asking again about a list already offered. */
  among?: readonly string[]
): Promise<string[]> {
  const { panelIds, panelsById } = usePanelStore.getState();
  const candidates = (among ?? panelIds).filter((id) =>
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
  // Read again after the host answered: a pane trashed or restarted while it
  // was asked is no longer one to move.
  const current = usePanelStore.getState().panelsById;
  return limited.filter(
    (id): id is string => id !== null && isAccountSwitchCandidate(current[id], agentId, accountId)
  );
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
  return `${pluralize(count, `${agentName} terminal`)} stopped on a usage limit`;
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

export interface AccountSwitchPane {
  id: string;
  title: string;
  worktreeId: string | undefined;
  /** The worktree's name, when this view still knows it. */
  worktree: string | undefined;
}

export interface AccountSwitchRequest {
  agentId: string;
  account: RestartAccountChoice;
  /** Frozen when asked, so the confirm never acts on a pane it didn't name. */
  panes: AccountSwitchPane[];
  /**
   * What raised it. The offer after a pick (#16136) is about usage limits, so
   * it starts with every pane checked and moves only those still limited at
   * the confirm. A move the user started (#17089) moves exactly what's checked.
   */
  origin: "usage-limit-offer" | "move";
  /** The panes that start checked; every pane when absent. */
  initiallyChecked?: readonly string[];
}

function describePanes(paneIds: readonly string[]): AccountSwitchPane[] {
  const panelsById = usePanelStore.getState().panelsById;
  const worktrees = getCurrentViewStoreOrNull()?.getState().worktrees;
  return paneIds.map((id) => {
    const panel = panelsById[id];
    const worktreeId = panel?.worktreeId;
    return {
      id,
      title: panel?.title?.trim() || id,
      worktreeId,
      worktree: worktreeId ? worktrees?.get(worktreeId)?.name : undefined,
    };
  });
}

export function buildAccountSwitchRequest(
  notice: AccountSwitchNoticeState,
  paneIds: readonly string[]
): AccountSwitchRequest {
  return {
    agentId: notice.agentId,
    account: notice.account,
    panes: describePanes(paneIds),
    origin: "usage-limit-offer",
  };
}

/**
 * The user's own move (#17089): every pane the agent could move to the
 * account, in every worktree, limited or not. A working agent starts
 * unchecked, since moving it interrupts it; every other pane starts checked.
 * That covers the limited ones too: the host forgets a limit only once the
 * pane settles from new work, so a limited pane is working only while it
 * retries, and then it is interrupted like any other.
 */
export function buildMovePanesRequest(
  agentId: string,
  account: RestartAccountChoice
): AccountSwitchRequest {
  const { panelIds, panelsById } = usePanelStore.getState();
  const paneIds = panelIds.filter((id) =>
    isAccountSwitchCandidate(panelsById[id], agentId, account.id)
  );
  return {
    agentId,
    account,
    panes: describePanes(paneIds),
    origin: "move",
    initiallyChecked: paneIds.filter((id) => !terminalHasRunningAgentSession(panelsById[id])),
  };
}

/** Panes in the order given, gathered under the worktree each runs in. */
function groupByWorktree(
  panes: readonly AccountSwitchPane[]
): { key: string; worktree: string | undefined; panes: AccountSwitchPane[] }[] {
  const groups = new Map<string, { worktree: string | undefined; panes: AccountSwitchPane[] }>();
  for (const pane of panes) {
    const key = pane.worktreeId ?? "";
    const group = groups.get(key);
    if (group) group.panes.push(pane);
    else groups.set(key, { worktree: pane.worktree, panes: [pane] });
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
}

function keepDescription(count: number, keep: boolean): string {
  if (count === 1) {
    return keep
      ? "It keeps its preset and reopens this conversation on that account, and the scrollback is discarded. If the account can't find the conversation, the panel offers a new one or the way back."
      : "It keeps its preset and starts a new conversation on that account, and the scrollback is discarded.";
  }
  return keep
    ? "Each keeps its preset and reopens its conversation on that account, and its scrollback is discarded. If the account can't find a conversation, that panel offers a new one or the way back."
    : "Each keeps its preset and starts a new conversation on that account, and its scrollback is discarded.";
}

/**
 * The offer after a pick: one confirm naming every pane, each with its own box
 * so the switch takes one, some or all of them; then one account switch per
 * checked pane, through the same action as the pane menu's, so the
 * conversation follows its rules.
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
  return (
    <AccountSwitchConfirm key={key} agentId={request.agentId} request={request} onClose={onClose} />
  );
}

const DEFAULT_LOGIN_VALUE = "default-login";

/**
 * The move the user starts (#17089): the same confirm over every pane the
 * agent could move, under a picker for the account they go to. Changing the
 * account lists that account's panes afresh. Moving panes leaves the account
 * new launches use where it was.
 */
export function MoveTerminalsToAccountDialog({
  agentId,
  account,
  onClose,
}: {
  agentId: string;
  /** Picked already, from the agent's menu; the palette leaves it to the dialog. */
  account: RestartAccountChoice | undefined;
  onClose: () => void;
}) {
  const pickerId = useId();
  const savedAccounts = useAgentSettingsStore(
    (state) => state.settings?.agents?.[agentId]?.accounts
  );
  const defaultLoginName = useAgentSettingsStore(
    (state) => state.settings?.agents?.[agentId]?.defaultLoginName
  );
  const choices: RestartAccountChoice[] = [
    { id: null, name: defaultLoginLabel(defaultLoginName) },
    ...sanitizeAgentAccounts(savedAccounts).map(({ id, name }) => ({ id, name })),
  ];
  const [request, setRequest] = useState<AccountSwitchRequest | null>(() =>
    account ? buildMovePanesRequest(agentId, account) : null
  );
  const pick = (value: string) => {
    const choice = choices.find((candidate) => (candidate.id ?? DEFAULT_LOGIN_VALUE) === value);
    if (choice) setRequest(buildMovePanesRequest(agentId, choice));
  };
  // An account removed while the dialog is open can take nothing: the restart
  // would refuse every pane, so the dialog asks for an account again.
  const live =
    request !== null &&
    (request.account.id === null || choices.some((choice) => choice.id === request.account.id))
      ? request
      : null;

  return (
    <AccountSwitchConfirm
      agentId={agentId}
      request={live}
      onClose={onClose}
      accountPicker={
        <div className="space-y-1.5">
          <label htmlFor={pickerId} className="block text-sm font-medium text-text-primary">
            Account
          </label>
          <Select value={live ? (live.account.id ?? DEFAULT_LOGIN_VALUE) : ""} onValueChange={pick}>
            <SelectTrigger id={pickerId} className="w-full">
              <SelectValue placeholder="Choose an account…" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem
                  key={choice.id ?? DEFAULT_LOGIN_VALUE}
                  value={choice.id ?? DEFAULT_LOGIN_VALUE}
                >
                  {choice.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    />
  );
}

function AccountSwitchConfirm({
  agentId,
  request,
  accountPicker,
  onClose,
}: {
  agentId: string;
  /** Null until the move's account is picked. */
  request: AccountSwitchRequest | null;
  accountPicker?: ReactNode;
  onClose: () => void;
}) {
  const labelIdPrefix = useId();
  const keepId = useId();
  const [keepConversation, setKeepConversation] = useState(false);
  // One answer for the batch: every pane here is launched by the same agent.
  const canKeep = supportsConversationKeepingSwitch(agentId);
  const keep = canKeep && keepConversation;
  // The boxes belong to the list they were ticked on: picking another account
  // lists its panes afresh, as they start.
  const [ticked, setTicked] = useState<{
    request: AccountSwitchRequest;
    ids: ReadonlySet<string>;
  } | null>(null);
  const selected: ReadonlySet<string> =
    request === null
      ? new Set()
      : ticked?.request === request
        ? ticked.ids
        : initialSelection(request);
  const toggle = (id: string) => {
    if (request === null) return;
    setTicked((current) => {
      const next = new Set(current?.request === request ? current.ids : initialSelection(request));
      if (!next.delete(id)) next.add(id);
      return { request, ids: next };
    });
  };

  const panes = request?.panes ?? [];
  const chosen = panes.filter((pane) => selected.has(pane.id));
  const count = chosen.length;
  // Read live: an agent that took up work while the list was open is interrupted too.
  const working = usePanelStore(
    (state) =>
      chosen.filter((pane) => terminalHasRunningAgentSession(state.panelsById[pane.id])).length
  );
  const agentName = getAgentConfig(agentId)?.name ?? agentId;

  const handleConfirm = () => {
    if (request === null || count === 0) return;
    const { account } = request;
    onClose();
    void (async () => {
      const chosenIds = chosen.map((pane) => pane.id);
      // The offer asks again: a pane that worked again, or restarted, since the
      // list was made has no limit left to switch away from, and keeps its
      // conversation. A move the user started takes every checked pane still open.
      const still = new Set(
        request.origin === "usage-limit-offer"
          ? await readUsageLimitedPaneIds(agentId, account.id, chosenIds)
          : chosenIds.filter((id) =>
              isAccountSwitchCandidate(usePanelStore.getState().panelsById[id], agentId, account.id)
            )
      );
      const restarting = chosen.filter((pane) => still.has(pane.id));
      if (restarting.length === 0) return;
      await restartPanesOnPreset(
        restarting,
        account.name,
        (pane) =>
          actionService.dispatch(
            "terminal.restartOnAccount",
            {
              terminalId: pane.id,
              accountId: account.id,
              confirmed: true,
              ...(keep ? { keepConversation: true } : {}),
            },
            { source: "user" }
          ),
        (restarted) => `Restarting ${pluralize(restarted, "terminal")} on ${account.name}`
      );
    })();
  };

  const title =
    request === null
      ? `Move ${agentName} terminals to which account?`
      : panes.length === 0
        ? `Move ${agentName} terminals to '${request.account.name}'?`
        : `Restart ${pluralize(count, "terminal")} on '${request.account.name}'?`;

  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      title={title}
      description={
        panes.length > 0 ? (
          <>
            {working > 0 && (
              <span className="block font-medium text-text-primary">
                {pluralize(working, "agent is working", "agents are working")} and will be
                interrupted.
              </span>
            )}
            <span className={working > 0 ? "mt-1 block" : undefined}>
              {keepDescription(count, keep)}
            </span>
          </>
        ) : undefined
      }
      confirmLabel={count === 1 ? "Restart terminal" : `Restart ${pluralize(count, "terminal")}`}
      confirmDisabled={count === 0}
      variant="destructive"
      onConfirm={handleConfirm}
    >
      {accountPicker}
      {request !== null && panes.length === 0 && (
        <p role="status" className="mt-3 text-sm text-text-secondary">
          No running {agentName} terminal to move to {request.account.name}
        </p>
      )}
      {panes.length > 0 && (
        <div className="mt-3 space-y-2" data-testid="account-switch-panes">
          {groupByWorktree(panes).map((group) => {
            const headingId = `${labelIdPrefix}-worktree-${group.key}`;
            return (
              <div
                key={group.key}
                role={group.worktree ? "group" : undefined}
                aria-labelledby={group.worktree ? headingId : undefined}
              >
                {group.worktree && (
                  <div id={headingId} className="truncate text-xs text-text-secondary">
                    {group.worktree}
                  </div>
                )}
                <ul className="space-y-1">
                  {group.panes.map((pane) => {
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
                        <span
                          id={labelId}
                          className="min-w-0 flex-1 truncate text-sm text-text-primary"
                        >
                          {pane.title}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {canKeep && panes.length > 0 && (
        <label htmlFor={keepId} className="mt-3 flex items-center gap-2 text-sm text-text-primary">
          <Checkbox
            id={keepId}
            checked={keepConversation}
            onCheckedChange={(checked) => setKeepConversation(checked === true)}
          />
          {panes.length === 1 ? "Keep this conversation" : "Keep their conversations"}
        </label>
      )}
    </ConfirmDialog>
  );
}

function initialSelection(request: AccountSwitchRequest): ReadonlySet<string> {
  return new Set(request.initiallyChecked ?? request.panes.map((pane) => pane.id));
}
