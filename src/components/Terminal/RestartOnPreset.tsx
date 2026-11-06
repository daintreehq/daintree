import { useCallback, useId, useState } from "react";
import { RotateCw } from "lucide-react";
import { BrandMark } from "@/components/icons";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { getAgentConfig } from "@/config/agents";
import { getBrandColorHex } from "@/lib/colorUtils";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import type { ActionSource } from "@shared/types/actions";
import { supportsConversationKeepingSwitch } from "@shared/types/agentSettings";
import { isPtyPanel } from "@shared/types/panel";
import {
  DestructiveConsequence,
  type DestructiveConfirmCopy,
} from "./TerminalDestructiveActionConfirmDialog";
import { useRestartPresetChoices, type RestartPresetChoice } from "./restartOnPresetChoices";
import { restartPanesOnPreset } from "./restartPanesOnPreset";

const ICON_CLASS = "w-3.5 h-3.5 mr-2 shrink-0";

function quoted(name: string | undefined, fallback: string): string {
  const trimmed = name?.trim();
  return trimmed ? `'${trimmed}'` : fallback;
}

/**
 * Asked every time, working or not (#13746): the conversation doesn't follow
 * the pane to another preset's home unless the user asks it to (#16045), and a
 * rate-limited agent is rarely working.
 */
export function buildRestartOnPresetCopy(
  terminalTitle: string | undefined,
  presetName: string,
  agentWorking: boolean,
  keepConversation = false
): DestructiveConfirmCopy {
  return {
    title: `Restart ${quoted(terminalTitle, "terminal")} on ${quoted(presetName, "another preset")}?`,
    lead: agentWorking ? "Its agent is working and will be interrupted." : undefined,
    description: keepConversation
      ? "The agent reopens this conversation with that preset's settings, and the scrollback is discarded. If it can't find the conversation there, the pane offers a new one or the way back."
      : "The agent starts a new conversation on that preset, and the scrollback is discarded.",
    confirmLabel: "Restart on preset",
  };
}

function PresetRowContent({ agentId, choice }: { agentId: string; choice: RestartPresetChoice }) {
  const Icon = getAgentConfig(agentId)?.icon;
  return (
    <>
      <span className="mr-2 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {Icon && (
          <BrandMark brandColor={choice.color ?? getBrandColorHex(agentId)}>
            <Icon />
          </BrandMark>
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{choice.name}</span>
        {choice.hint && <span className="truncate text-xs text-text-secondary">{choice.hint}</span>}
      </span>
    </>
  );
}

/** "Restart on preset" in the pane menu; nothing when the agent has no other preset. */
export function RestartOnPresetSubmenu({
  agentId,
  currentPresetId,
  accountBound = false,
  onPick,
}: {
  agentId: string;
  currentPresetId: string | undefined;
  /** The pane keeps its account across the switch, so a preset's home quota doesn't apply. */
  accountBound?: boolean;
  onPick: (choice: RestartPresetChoice) => void;
}) {
  // Menu content mounts only while open, so the quota is read only then.
  const choices = useRestartPresetChoices(agentId, currentPresetId, !accountBound);
  if (choices.length === 0) return null;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <RotateCw className={ICON_CLASS} aria-hidden="true" />
        Restart on preset
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {choices.map((choice) => (
          <ContextMenuItem key={choice.id} onSelect={() => onPick(choice)}>
            <PresetRowContent agentId={agentId} choice={choice} />
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** The same choices as dropdown rows, for the rate-limit chip's menu. */
export function RestartOnPresetDropdownItems({
  agentId,
  choices,
  onPick,
}: {
  agentId: string;
  choices: readonly RestartPresetChoice[];
  onPick: (choice: RestartPresetChoice) => void;
}) {
  return (
    <>
      {choices.map((choice) => (
        <DropdownMenuItem key={choice.id} onSelect={() => onPick(choice)}>
          <PresetRowContent agentId={agentId} choice={choice} />
        </DropdownMenuItem>
      ))}
    </>
  );
}

export interface RestartOnPresetRequest {
  terminalId: string;
  terminalTitle: string | undefined;
  agentWorking: boolean;
  preset: RestartPresetChoice;
}

interface RestartOnPresetConfirmDialogProps {
  request: RestartOnPresetRequest | null;
  onClose: () => void;
  /** Read at confirm time: the menu records how it was opened as it opens. */
  sourceRef: { readonly current: ActionSource };
}

/** Confirms and dispatches `terminal.restartOnPreset`. */
export function RestartOnPresetConfirmDialog({
  request,
  ...rest
}: RestartOnPresetConfirmDialogProps) {
  // Mounted per request, so the opt-in starts unchecked on every opening.
  if (!request) return null;
  return <RestartOnPresetConfirm request={request} {...rest} />;
}

function RestartOnPresetConfirm({
  request,
  onClose,
  sourceRef,
}: RestartOnPresetConfirmDialogProps & { request: RestartOnPresetRequest }) {
  const keepId = useId();
  const [keepConversation, setKeepConversation] = useState(false);
  // Offered only where a refusal can be recognised (#16045), never on whether
  // the pane holds an id yet: a running Codex learns its id at the teardown.
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
      request.preset.name,
      (pane) =>
        actionService.dispatch(
          "terminal.restartOnPreset",
          {
            terminalId: pane.id,
            presetId: request.preset.id,
            confirmed: true,
            ...(keep ? { keepConversation: true } : {}),
          },
          { source }
        ),
      () => `Restarting on ${request.preset.name}`
    );
  }, [request, onClose, sourceRef, keep]);

  const copy = buildRestartOnPresetCopy(
    request.terminalTitle,
    request.preset.name,
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
