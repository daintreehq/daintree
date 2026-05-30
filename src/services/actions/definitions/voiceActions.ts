import { z } from "zod";
import type { ActionRegistry } from "../actionTypes";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";

const lockTargetArgsSchema = z.object({ panelId: z.string().optional() });
const recallRecentTargetArgsSchema = z.object({ panelId: z.string() });

function resolveTargetForPanel(panelId: string): {
  panelId: string;
  panelTitle?: string;
  projectId?: string;
  projectName?: string;
  worktreeId?: string;
  worktreeLabel?: string;
} | null {
  const panel = usePanelStore.getState().panelsById[panelId];
  if (!panel || panel.location === "trash") return null;
  // Only PTY-backed panels can receive dictation — browsers and dev-preview
  // panels have no input surface for the transcript to land in. Without this
  // guard, hotkey/palette invocations could lock dictation to a browser panel
  // (no `panelId` arg falls back to focusedId).
  if (!panelKindHasPty(panel.kind)) return null;
  const currentProject = useProjectStore.getState().currentProject;
  const worktree = panel.worktreeId
    ? getCurrentViewStore().getState().worktrees.get(panel.worktreeId)
    : undefined;
  return {
    panelId: panel.id,
    panelTitle: panel.title,
    projectId: currentProject?.id,
    projectName: currentProject?.name,
    worktreeId: panel.worktreeId,
    worktreeLabel: worktree?.isMainWorktree ? worktree?.name : worktree?.branch || worktree?.name,
  };
}

export function registerVoiceActions(actions: ActionRegistry): void {
  actions.set("voiceInput.toggle", () => ({
    id: "voiceInput.toggle",
    title: "Toggle Voice Dictation",
    description: "Start or stop dictation for the focused terminal input",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "speech"],
    run: async () => {
      await voiceRecordingService.toggleFocusedPanel();
    },
  }));

  actions.set("voiceInput.toggleAssistant", () => ({
    id: "voiceInput.toggleAssistant",
    title: "Toggle Voice Dictation in Assistant",
    description: "Start or stop dictation in the Daintree Assistant from anywhere",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "speech", "assistant"],
    run: async () => {
      await voiceRecordingService.toggleAssistant();
    },
  }));

  actions.set("voiceInput.togglePause", () => ({
    id: "voiceInput.togglePause",
    title: "Pause or resume voice dictation",
    description: "Suspend dictation without ending the session, or resume after pausing",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["pause", "resume", "dictate", "mic", "speech"],
    run: async () => {
      voiceRecordingService.togglePause();
    },
  }));

  actions.set("voiceInput.lockTarget", () => ({
    id: "voiceInput.lockTarget",
    title: "Lock Voice Dictation to Panel",
    description: "Pin voice dictation to a specific panel so focus changes don't redirect it",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "lock", "pin", "fix"],
    argsSchema: lockTargetArgsSchema,
    run: async (args: unknown) => {
      const parsed = lockTargetArgsSchema.safeParse(args ?? {});
      const requestedId =
        (parsed.success ? parsed.data.panelId : undefined) ??
        usePanelStore.getState().focusedId ??
        undefined;
      if (!requestedId) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "transient",
          code: "lock_target_no_focus",
          message: "Focus a panel before locking dictation to it.",
        });
        useVoiceRecordingStore.getState().announce("Focus a panel before locking dictation to it.");
        return;
      }
      const target = resolveTargetForPanel(requestedId);
      if (!target) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "transient",
          code: "lock_target_unavailable",
          message: "Couldn't lock dictation to that panel.",
        });
        return;
      }
      useVoiceRecordingStore.getState().lockTarget(target);
      useVoiceRecordingStore
        .getState()
        .announce(`Dictation locked to ${target.panelTitle ?? "this panel"}.`);
    },
  }));

  actions.set("voiceInput.unlockTarget", () => ({
    id: "voiceInput.unlockTarget",
    title: "Unlock Voice Dictation",
    description: "Release the pinned dictation target so voice follows focus again",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "unlock", "release"],
    run: async () => {
      const wasLocked = useVoiceRecordingStore.getState().lockedTarget;
      useVoiceRecordingStore.getState().unlockTarget();
      if (wasLocked) {
        useVoiceRecordingStore.getState().announce("Dictation unlocked.");
      }
    },
  }));

  actions.set("voiceInput.recallRecentTarget", () => ({
    id: "voiceInput.recallRecentTarget",
    title: "Toggle Voice Dictation on Recent Target",
    description: "Start or stop dictation on a recently used panel by id",
    category: "voice",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dictate", "mic", "recent", "history"],
    argsSchema: recallRecentTargetArgsSchema,
    run: async (args: unknown) => {
      const parsed = recallRecentTargetArgsSchema.safeParse(args);
      if (!parsed.success) return;
      const target = resolveTargetForPanel(parsed.data.panelId);
      if (!target) {
        useVoiceRecordingStore.getState().setLastError({
          severity: "transient",
          code: "recall_target_unavailable",
          message: "That panel is no longer available for dictation.",
        });
        return;
      }
      await voiceRecordingService.toggle(target);
    },
  }));
}
