import { useCallback, useId, useMemo, useState } from "react";
import { UserRound } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { actionService } from "@/services/ActionService";
import { getMergedPresets } from "@/config/agents";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { useAgentAccountHeadroom } from "@/hooks/useAgentAccountHeadroom";
import { presetNamesAccountFolder, type AccountHeadroom } from "@/utils/agentAccountHeadroom";
import { getAgentConfigFolderAccount } from "@shared/config/agentRegistry";
import type { ActionSource } from "@shared/types/actions";
import { supportsConversationKeepingSwitch } from "@shared/types/agentSettings";
import { isPtyPanel } from "@shared/types/panel";
import { sanitizeAgentAccounts } from "@shared/utils/agentAccounts";
import {
  DestructiveConsequence,
  type DestructiveConfirmCopy,
} from "./TerminalDestructiveActionConfirmDialog";
import { AccountChoiceText } from "./AccountHeadroomHint";
import { restartPanesOnPreset } from "./restartPanesOnPreset";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

export interface RestartAccountChoice {
  /** `null` is the CLI's default login. */
  id: string | null;
  name: string;
  /** The tightest window known for the account, while its menu is open (#16407). */
  headroom?: AccountHeadroom;
}

function quoted(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim();
  return trimmed ? `'${trimmed}'` : fallback;
}

/**
 * Asked every time, as a preset switch is: the conversation follows the pane
 * to another account's folder only when the user asks it to (#16135).
 */
export function buildRestartOnAccountCopy(
  terminalTitle: string | undefined,
  accountName: string,
  agentWorking: boolean,
  keepConversation = false
): DestructiveConfirmCopy {
  return {
    title: `Restart ${quoted(terminalTitle, "terminal")} on ${quoted(accountName, "another account")}?`,
    lead: agentWorking ? "Its agent is working and will be interrupted." : undefined,
    description: keepConversation
      ? "It keeps its preset and reopens this conversation on that account, and the scrollback is discarded. If the account can't find the conversation, the pane offers a new one or the way back."
      : "It keeps its preset and starts a new conversation on that account, and the scrollback is discarded.",
    confirmLabel: "Restart on account",
  };
}

/**
 * The accounts an agent pane can move to (#16040): every other one of its
 * agent's, with the default login among them. A pane still on an account
 * that has since been removed can always go back to the default login. None
 * for a pane on the default login when the agent has no saved account.
 *
 * Each carries the tightest quota window known for it while `open` (#16407),
 * and the quota is read only then. A move to the default login keeps the
 * pane's preset, so `presetId` says whether that preset puts the login's
 * folder somewhere of its own.
 */
export function useRestartAccountChoices(
  agentId: string | undefined,
  currentAccountId: string | undefined,
  open = false,
  presetId?: string
): RestartAccountChoice[] {
  const savedAccounts = useAgentSettingsStore((s) =>
    agentId ? s.settings?.agents?.[agentId]?.accounts : undefined
  );
  const customPresets = useAgentSettingsStore((s) =>
    agentId ? s.settings?.agents?.[agentId]?.customPresets : undefined
  );
  const ccrPresets = useCcrPresetsStore((s) =>
    agentId ? s.ccrPresetsByAgent[agentId] : undefined
  );
  const projectPresets = useProjectPresetsStore((s) =>
    agentId ? s.presetsByAgent[agentId] : undefined
  );
  const choices = useMemo(() => {
    if (!agentId || !getAgentConfigFolderAccount(agentId)) return [];
    const accounts = sanitizeAgentAccounts(savedAccounts);
    if (accounts.length === 0 && !currentAccountId) return [];
    const all: RestartAccountChoice[] = [
      { id: null, name: "Default login" },
      ...accounts.map((account) => ({ id: account.id, name: account.name })),
    ];
    return all.filter((choice) => choice.id !== (currentAccountId ?? null));
  }, [agentId, currentAccountId, savedAccounts]);

  const headroomFor = useAgentAccountHeadroom(agentId, open && choices.length > 0);
  // A preset that can't be found refuses the switch anyway; its folder is unknown.
  const presetNamesFolder = useMemo(() => {
    if (!agentId || presetId === undefined) return false;
    const preset = getMergedPresets(agentId, customPresets, ccrPresets, projectPresets).find(
      (candidate) => candidate.id === presetId
    );
    return preset === undefined || presetNamesAccountFolder(agentId, preset);
  }, [agentId, presetId, customPresets, ccrPresets, projectPresets]);

  return useMemo(() => {
    if (!open) return choices;
    return choices.map((choice) => {
      const headroom = headroomFor(
        choice.id === null
          ? { kind: "default", presetNamesFolder }
          : { kind: "account", accountId: choice.id }
      );
      return headroom ? { ...choice, headroom } : choice;
    });
  }, [choices, open, headroomFor, presetNamesFolder]);
}

/** "Switch account" in the pane menu; nothing when the agent has no other account. */
export function RestartOnAccountSubmenu({
  agentId,
  currentAccountId,
  currentPresetId,
  onPick,
}: {
  agentId: string;
  currentAccountId: string | undefined;
  currentPresetId?: string;
  onPick: (choice: RestartAccountChoice) => void;
}) {
  // Menu content mounts only while open, so the quota is read only then.
  const choices = useRestartAccountChoices(agentId, currentAccountId, true, currentPresetId);
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
            <AccountChoiceText name={choice.name} headroom={choice.headroom} />
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
          <AccountChoiceText name={choice.name} headroom={choice.headroom} />
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

interface RestartOnAccountConfirmDialogProps {
  request: RestartOnAccountRequest | null;
  onClose: () => void;
  /** Read at confirm time: the menu records how it was opened as it opens. */
  sourceRef: { readonly current: ActionSource };
}

/** Confirms and dispatches `terminal.restartOnAccount`. */
export function RestartOnAccountConfirmDialog({
  request,
  ...rest
}: RestartOnAccountConfirmDialogProps) {
  // Mounted per request, so the opt-in starts unchecked on every opening.
  if (!request) return null;
  return <RestartOnAccountConfirm request={request} {...rest} />;
}

function RestartOnAccountConfirm({
  request,
  onClose,
  sourceRef,
}: RestartOnAccountConfirmDialogProps & { request: RestartOnAccountRequest }) {
  const keepId = useId();
  const [keepConversation, setKeepConversation] = useState(false);
  // Offered where a refusal can be recognised, as on a preset switch (#16045).
  const canKeep = usePanelStore((state) => {
    const panel = state.panelsById[request.terminalId];
    return (
      panel !== undefined &&
      isPtyPanel(panel) &&
      supportsConversationKeepingSwitch(panel.launchAgentId)
    );
  });
  const keep = canKeep && keepConversation;

  const handleConfirm = useCallback(() => {
    const source = sourceRef.current;
    onClose();
    void restartPanesOnPreset(
      [{ id: request.terminalId, title: request.terminalTitle }],
      request.account.name,
      (pane) =>
        actionService.dispatch(
          "terminal.restartOnAccount",
          {
            terminalId: pane.id,
            accountId: request.account.id,
            confirmed: true,
            ...(keep ? { keepConversation: true } : {}),
          },
          { source }
        ),
      () => `Restarting on ${request.account.name}`
    );
  }, [request, onClose, sourceRef, keep]);

  const copy = buildRestartOnAccountCopy(
    request.terminalTitle,
    request.account.name,
    request.agentWorking,
    keep
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
    >
      {canKeep && (
        <label htmlFor={keepId} className="flex items-center gap-2 text-sm text-text-primary">
          <Checkbox
            id={keepId}
            checked={keepConversation}
            onCheckedChange={(checked) => setKeepConversation(checked === true)}
          />
          Keep this conversation
        </label>
      )}
    </ConfirmDialog>
  );
}
