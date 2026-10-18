import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import {
  DEFAULT_RESUME_ON_RESTART,
  resolveResumeOnRestart,
  type ResumeOnRestart,
} from "@shared/types/agentSettings";
import { SettingsPresetGroup } from "./SettingsPresetGroup";

const OPTIONS = [
  { value: "always", label: "Always" },
  { value: "on-focus", label: "On focus" },
  { value: "never", label: "Never" },
] as const satisfies readonly { value: ResumeOnRestart; label: string }[];

const DESCRIPTIONS: Record<ResumeOnRestart, string> = {
  always: "Every agent pane resumes its conversation as its project restores",
  "on-focus":
    "Agent panes wait, and each resumes its conversation when you first focus it. Saves memory when many panes come back",
  never: "Agent panes wait for you to resume their conversation or start a new one",
};

export interface ResumeOnRestartRowProps {
  /** A save is starting; whatever an earlier failure's Retry would resend is superseded. */
  onSaveStart: () => void;
  /** The save failed and the row is back on its previous value; `retry` resends it. */
  onSaveFailed: (retry: () => Promise<void>) => void;
}

/**
 * "Resume agents after restart" (#13509). Held panes keep their conversation,
 * so nothing a restart holds is lost — only started later, or by hand.
 */
export function ResumeOnRestartRow({ onSaveStart, onSaveFailed }: ResumeOnRestartRowProps) {
  // Loaded means a snapshot is in hand: a failed load leaves `settings` null.
  const value = useAgentSettingsStore((state) =>
    state.isInitialized && state.settings ? resolveResumeOnRestart(state.settings) : null
  );
  const setResumeOnRestart = useAgentSettingsStore((state) => state.setResumeOnRestart);

  const persist = (next: ResumeOnRestart): Promise<void> => {
    onSaveStart();
    return setResumeOnRestart(next).catch(() => onSaveFailed(() => persist(next)));
  };
  const save = (next: ResumeOnRestart) => void persist(next);

  return (
    <SettingsPresetGroup<ResumeOnRestart>
      id="general-resume-on-restart"
      label="Resume agents after restart"
      description={DESCRIPTIONS[value ?? DEFAULT_RESUME_ON_RESTART]}
      options={OPTIONS}
      value={value}
      onChange={save}
      disabled={value === null}
      isModified={value !== null && value !== DEFAULT_RESUME_ON_RESTART}
      onReset={() => save(DEFAULT_RESUME_ON_RESTART)}
    />
  );
}
