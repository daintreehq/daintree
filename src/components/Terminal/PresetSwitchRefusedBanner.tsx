import { useState } from "react";
import { Play, RotateCcw } from "lucide-react";
import { getAgentConfig, getMergedPresets } from "@/config/agents";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";
import { isPtyPanel } from "@shared/types/panel";
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

/**
 * Says what the CLI said, on whose preset, and never why: the folder may be
 * signed out, the conversation may never have been shared with it, or the
 * link the user made may have gone (#16045).
 */
export function buildPresetSwitchRefusedCopy(args: {
  agentName: string;
  presetName: string;
  priorPresetName: string | undefined;
  backUnavailable?: "held-elsewhere" | "unavailable";
}): PresetSwitchRefusedCopy {
  const { agentName, presetName, priorPresetName, backUnavailable } = args;
  const back = priorPresetName ? `go back to ${priorPresetName}` : "go back to how it was running";
  return {
    title: `${agentName} couldn't find this conversation on ${presetName}`,
    description:
      backUnavailable === "held-elsewhere"
        ? `Another pane has this conversation open, so it can't reopen here. Start a new one on ${presetName} instead.`
        : backUnavailable === "unavailable"
          ? `The conversation couldn't reopen here. Start a new one on ${presetName} instead.`
          : `Start a new conversation on ${presetName}, or ${back} to carry on with this one.`,
    startNewLabel: `Start new on ${presetName}`,
    backLabel: priorPresetName ? `Back to ${priorPresetName}` : "Go back",
  };
}

/**
 * The offer a conversation-keeping preset switch leaves when the CLI refused
 * the conversation on the new preset (#16045). Both ways out are the user's
 * pick; nothing starts by itself.
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
  const [backUnavailable, setBackUnavailable] = useState<
    "held-elsewhere" | "unavailable" | undefined
  >(undefined);
  const [busy, setBusy] = useState(false);

  if (!attempt) return null;
  const presets = getMergedPresets(attempt.agentId, customPresets, ccrPresets, projectPresets);
  const nameOf = (presetId: string | undefined) =>
    presetId ? (presets.find((preset) => preset.id === presetId)?.name ?? presetId) : undefined;
  const copy = buildPresetSwitchRefusedCopy({
    agentName: getAgentConfig(attempt.agentId)?.name ?? attempt.agentId,
    presetName: nameOf(attempt.presetId) ?? attempt.presetId,
    priorPresetName: nameOf(attempt.prior.agentPresetId),
    backUnavailable,
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
        {
          id: "start-new-conversation",
          label: copy.startNewLabel,
          icon: Play,
          disabled: busy,
          onClick: () =>
            run(async () => {
              await startNewAfterRefusedSwitch(panelId);
            }),
        },
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
