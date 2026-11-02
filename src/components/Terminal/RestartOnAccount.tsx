import { useCallback, useMemo } from "react";
import { UserRound } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { actionService } from "@/services/ActionService";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { getAgentConfigFolderAccount } from "@shared/config/agentRegistry";
import type { ActionSource } from "@shared/types/actions";
import { sanitizeAgentAccounts } from "@shared/utils/agentAccounts";
import {
  DestructiveConsequence,
  type DestructiveConfirmCopy,
} from "./TerminalDestructiveActionConfirmDialog";
import { restartPanesOnPreset } from "./restartPanesOnPreset";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

export interface RestartAccountChoice {
  /** `null` is the CLI's default login. */
  id: string | null;
  name: string;
}

function quoted(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim();
  return trimmed ? `'${trimmed}'` : fallback;
}

/**
 * Asked every time, as a preset switch is: the conversation doesn't follow
 * the pane to another account's folder yet (#16045).
 */
export function buildRestartOnAccountCopy(
  terminalTitle: string | undefined,
  accountName: string,
  agentWorking: boolean
): DestructiveConfirmCopy {
  return {
    title: `Restart ${quoted(terminalTitle, "terminal")} on ${quoted(accountName, "another account")}?`,
    lead: agentWorking ? "Its agent is working and will be interrupted." : undefined,
    description:
      "It keeps its preset and starts a new conversation on that account, and the scrollback is discarded.",
    confirmLabel: "Restart on account",
  };
}

/**
 * The accounts an agent pane can move to (#16040): every other one of its
 * agent's, with the default login among them. A pane still on an account
 * that has since been removed can always go back to the default login. None
 * for a pane on the default login when the agent has no saved account.
 */
export function useRestartAccountChoices(
  agentId: string | undefined,
  currentAccountId: string | undefined
): RestartAccountChoice[] {
  const savedAccounts = useAgentSettingsStore((s) =>
    agentId ? s.settings?.agents?.[agentId]?.accounts : undefined
  );
  return useMemo(() => {
    if (!agentId || !getAgentConfigFolderAccount(agentId)) return [];
    const accounts = sanitizeAgentAccounts(savedAccounts);
    if (accounts.length === 0 && !currentAccountId) return [];
    const choices: RestartAccountChoice[] = [
      { id: null, name: "Default login" },
      ...accounts.map((account) => ({ id: account.id, name: account.name })),
    ];
    return choices.filter((choice) => choice.id !== (currentAccountId ?? null));
  }, [agentId, currentAccountId, savedAccounts]);
}

/** "Switch account" in the pane menu; nothing when the agent has no other account. */
export function RestartOnAccountSubmenu({
  agentId,
  currentAccountId,
  onPick,
}: {
  agentId: string;
  currentAccountId: string | undefined;
  onPick: (choice: RestartAccountChoice) => void;
}) {
  const choices = useRestartAccountChoices(agentId, currentAccountId);
  if (choices.length === 0) return null;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <UserRound className={ICON_CLASS} aria-hidden="true" />
        Switch account
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {choices.map((choice) => (
          <ContextMenuItem key={choice.id ?? "default"} onSelect={() => onPick(choice)}>
            <span className="truncate">{choice.name}</span>
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** The same choices as dropdown rows, for the rate-limit chip's menu. */
export function RestartOnAccountDropdownItems({
  choices,
  onPick,
}: {
  choices: readonly RestartAccountChoice[];
  onPick: (choice: RestartAccountChoice) => void;
}) {
  return (
    <>
      {choices.map((choice) => (
        <DropdownMenuItem key={choice.id ?? "default"} onSelect={() => onPick(choice)}>
          <UserRound className={ICON_CLASS} aria-hidden="true" />
          <span className="truncate">{choice.name}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

export interface RestartOnAccountRequest {
  terminalId: string;
  terminalTitle: string | undefined;
  agentWorking: boolean;
  account: RestartAccountChoice;
}

/** Confirms and dispatches `terminal.restartOnAccount`. */
export function RestartOnAccountConfirmDialog({
  request,
  onClose,
  sourceRef,
}: {
  request: RestartOnAccountRequest | null;
  onClose: () => void;
  /** Read at confirm time: the menu records how it was opened as it opens. */
  sourceRef: { readonly current: ActionSource };
}) {
  const handleConfirm = useCallback(() => {
    if (!request) return;
    const source = sourceRef.current;
    onClose();
    void restartPanesOnPreset(
      [{ id: request.terminalId, title: request.terminalTitle }],
      request.account.name,
      (pane) =>
        actionService.dispatch(
          "terminal.restartOnAccount",
          { terminalId: pane.id, accountId: request.account.id, confirmed: true },
          { source }
        ),
      () => `Restarting on ${request.account.name}`
    );
  }, [request, onClose, sourceRef]);

  if (!request) return null;
  const copy = buildRestartOnAccountCopy(
    request.terminalTitle,
    request.account.name,
    request.agentWorking
  );
  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      title={copy.title}
      description={<DestructiveConsequence copy={copy} />}
      confirmLabel={copy.confirmLabel}
      variant="destructive"
      onConfirm={handleConfirm}
    />
  );
}
