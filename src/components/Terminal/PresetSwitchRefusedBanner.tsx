import { useState } from "react";
import { Play, RotateCcw } from "lucide-react";
import { getAgentConfig, getMergedPresets } from "@/config/agents";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { isPtyPanel } from "@shared/types/panel";
import { sanitizeAgentAccounts } from "@shared/utils/agentAccounts";
import {
  dismissRefusedPresetSwitch,
  returnAfterRefusedSwitch,
  startNewAfterRefusedSwitch,
} from "@/services/terminal/agentEndRecovery";
import { InlineStatusBanner } from "./InlineStatusBanner";

export interface PresetSwitchRefusedCopy {
  title: string;
  description: string;
  startNewLabel: string;
  backLabel: string;
}

/** How the default login reads where an account's name would go. */
const DEFAULT_LOGIN_NAME = "the default login";

/**
 * Says what the CLI said, on which preset or account, and never why: the
 * folder may be signed out, the conversation may never have been shared with
 * it, or the link the user made may have gone (#16045, #16135).
 */
export function buildPresetSwitchRefusedCopy(args: {
  agentName: string;
  /** The preset or account the switch moved the pane onto. */
  targetName: string;
  /** The one it left, when it still has a name. */
  priorName: string | undefined;
  backUnavailable?: "held-elsewhere" | "unavailable";
  /** A new conversation couldn't start there either, such as on a removed account. */
  startNewUnavailable?: boolean;
}): PresetSwitchRefusedCopy {
  const { agentName, targetName, priorName, backUnavailable, startNewUnavailable } = args;
  const backTo = priorName ? `back to ${priorName}` : "back to how it was running";
  const instead = startNewUnavailable ? "" : ` Start a new one on ${targetName} instead.`;
  return {
    title: `${agentName} couldn't find this conversation on ${targetName}`,
    description:
      backUnavailable === "held-elsewhere"
        ? `Another pane has this conversation open, so it can't reopen here.${instead}`
        : backUnavailable === "unavailable"
          ? `The conversation couldn't reopen here.${instead}`
          : startNewUnavailable
            ? `A new conversation couldn't start on ${targetName}. Go ${backTo} to carry on with this one.`
            : `Start a new conversation on ${targetName}, or go ${backTo} to carry on with this one.`,
    startNewLabel: `Start new on ${targetName}`,
    backLabel: priorName ? `Back to ${priorName}` : "Go back",
  };
}

/**
 * The offer a conversation-keeping preset or account switch leaves when the
 * CLI refused the conversation where the switch moved it (#16045, #16135).
 * Both ways out are the user's pick; nothing starts by itself.
 */
export function PresetSwitchRefusedBanner({ panelId }: { panelId: string }) {
  const attempt = usePanelStore((state) => {
    const panel = state.panelsById[panelId];
    return panel && isPtyPanel(panel) && panel.presetSwitchResume?.refused
      ? panel.presetSwitchResume
      : undefined;
  });
  const agentId = attempt?.agentId;
  const customPresets = useAgentSettingsStore((s) =>
    agentId ? s.settings?.agents?.[agentId]?.customPresets : undefined
  );
  const ccrPresets = useCcrPresetsStore((s) =>
    agentId ? s.ccrPresetsByAgent[agentId] : undefined
  );
  const projectPresets = useProjectPresetsStore((s) =>
    agentId ? s.presetsByAgent[agentId] : undefined
  );
  const savedAccounts = useAgentSettingsStore((s) =>
    agentId ? s.settings?.agents?.[agentId]?.accounts : undefined
  );
  const [backUnavailable, setBackUnavailable] = useState<
    "held-elsewhere" | "unavailable" | undefined
  >(undefined);
  const [startNewUnavailable, setStartNewUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!attempt) return null;
  const { target, prior } = attempt;
  let targetName: string;
  let priorName: string | undefined;
  if (target.kind === "preset") {
    const presets = getMergedPresets(attempt.agentId, customPresets, ccrPresets, projectPresets);
    const presetName = (presetId: string | undefined) =>
      presetId ? (presets.find((preset) => preset.id === presetId)?.name ?? presetId) : undefined;
    targetName = presetName(target.presetId) ?? target.presetId;
    priorName = presetName(prior.agentPresetId);
  } else {
    // A removed account keeps no name to show; the folder the pane left is
    // still what "Back" reopens.
    const accounts = sanitizeAgentAccounts(savedAccounts);
    const accountName = (accountId: string | null | undefined) =>
      accountId == null
        ? DEFAULT_LOGIN_NAME
        : accounts.find((account) => account.id === accountId)?.name;
    targetName = accountName(target.accountId) ?? "that account";
    priorName = accountName(prior.agentAccountId);
  }
  const copy = buildPresetSwitchRefusedCopy({
    agentName: getAgentConfig(attempt.agentId)?.name ?? attempt.agentId,
    targetName,
    priorName,
    backUnavailable,
    startNewUnavailable,
  });

  const run = (choice: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void choice().finally(() => setBusy(false));
  };

  return (
    <InlineStatusBanner
      title={copy.title}
      description={copy.description}
      severity="warning"
      animated={false}
      role="status"
      ariaLive="polite"
      layout="pane"
      actions={[
        ...(startNewUnavailable
          ? []
          : [
              {
                id: "start-new-conversation",
                label: copy.startNewLabel,
                icon: Play,
                disabled: busy,
                onClick: () =>
                  run(async () => {
                    // A refusal from the store itself takes the offer down and
                    // reports on the pane; one that leaves it up is said here.
                    const result = await startNewAfterRefusedSwitch(panelId);
                    if (!result.success) setStartNewUnavailable(true);
                  }),
              },
            ]),
        ...(backUnavailable
          ? []
          : [
              {
                id: "back-to-prior-preset",
                label: copy.backLabel,
                icon: RotateCcw,
                disabled: busy,
                onClick: () =>
                  run(async () => {
                    const result = await returnAfterRefusedSwitch(panelId);
                    if (result !== "launched") setBackUnavailable(result);
                  }),
              },
            ]),
      ]}
      onClose={() => dismissRefusedPresetSwitch(panelId)}
    />
  );
}
