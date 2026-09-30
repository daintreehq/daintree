import { useEffect } from "react";
import type { SystemMemoryPressurePayload } from "@shared/types/ipc/system";
import { notify } from "@/lib/notify";
import { isMac } from "@/lib/platform";
import { isElectronAvailable } from "@/hooks/useElectron";
import { getDefaultAgentId } from "@/lib/resolveAgentId";
import { actionService } from "@/services/ActionService";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import type { NotificationAction } from "@/store/notificationStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useSystemMemoryNoticeStore } from "@/store/systemMemoryNoticeStore";
import { resolveViewWorkspace } from "@/store/viewWorkspace";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

const SUPERSEDE_KEY = "system-memory-pressure";

// One-way latch, as in useDiskSpaceWarnings: an app-lifetime listener with no
// teardown, so a remount can never subscribe twice (#10455).
let ipcListenerAttached = false;
/** This renderer raised the notice for the episode now open. */
let noticeRaised = false;

function formatGb(mb: number): string {
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** States only what was measured over threshold — never a cause (#12462). */
export function describeSystemMemoryReadings(payload: SystemMemoryPressurePayload): string | null {
  const observed: string[] = [];
  if (payload.kernelPressureLevel !== null) {
    observed.push(
      `macOS reports memory pressure at its ${
        payload.kernelPressureLevel === "critical" ? "critical" : "warning"
      } level`
    );
  }
  if (payload.swapUsedPercent !== null) {
    observed.push(
      payload.swapKind === "commit"
        ? `committed memory is at ${payload.swapUsedPercent}% of its limit`
        : `swap is ${payload.swapUsedPercent}% full`
    );
  }
  if (payload.fseventsdRssMb !== null) {
    observed.push(`the fseventsd process is using ${formatGb(payload.fseventsdRssMb)} of memory`);
  }
  if (observed.length === 0) return null;
  const sentence = observed.join(" and ");
  // "macOS" keeps its own casing at the start of a sentence.
  return sentence.startsWith("macOS")
    ? `${sentence}.`
    : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export function formatSystemMemoryPressureMessage(
  payload: SystemMemoryPressurePayload,
  mac: boolean
): string | null {
  const text = describeSystemMemoryReadings(payload);
  if (text === null) return null;
  // The restart advice covers what a reboot resets — swap and a grown
  // fseventsd — not a pressure level, which reflects whatever is running now.
  if (payload.swapUsedPercent === null && payload.fseventsdRssMb === null) return text;
  return `${text} Restarting your ${mac ? "Mac" : "computer"} clears this.`;
}

/**
 * The first turn for an agent asked to diagnose the episode. It carries the
 * readings as of the notice, because an inbox row can be clicked hours after
 * pressure cleared, and leaves the cause entirely to the agent.
 */
export function buildSystemMemoryDiagnosisPrompt(
  payload: SystemMemoryPressurePayload,
  observedAt: string,
  mac: boolean
): string | null {
  const readings = describeSystemMemoryReadings(payload);
  if (readings === null) return null;
  const tools = mac
    ? "read-only commands such as memory_pressure, vm_stat, sysctl vm.swapusage, and ps -axmo pid,rss,comm"
    : "your platform's read-only memory and process tools";
  return [
    "Why is my system under memory pressure?",
    `Daintree raised a high system memory notice at ${observedAt}. ${readings}`,
    "Those readings may be out of date, so check the current state first. Then find which processes are using the most memory, including anything outside Daintree such as virtual machines, containers, and background services, and report what you find. If the pressure has already cleared, say so.",
    `Use ${tools}. Don't quit, kill, or restart anything, or change any settings, without asking me first.`,
  ].join(" ");
}

/** The launch args, or null when this view has nowhere or nothing to launch. */
function resolveDiagnosisLaunch(
  payload: SystemMemoryPressurePayload
): { agentId: string; prompt: string; name: string } | null {
  const projectState = useProjectStore.getState();
  const scratchState = useScratchStore.getState();
  const workspace = resolveViewWorkspace({
    viewWorkspaceId: getViewWorkspaceId(),
    projects: projectState.projects,
    currentProject: projectState.currentProject,
    scratches: scratchState.scratches,
    currentScratch: scratchState.currentScratch,
  });
  if (!workspace) return null;
  // A closed project keeps its row and this view keeps its id (useWorkspaceRoot).
  if (workspace.kind === "project" && workspace.project.status === "closed") return null;

  const { availability, hasRealData } = useCliAvailabilityStore.getState();
  if (!hasRealData) return null;
  const agentId = getDefaultAgentId(
    useAgentPreferencesStore.getState().defaultAgent,
    undefined,
    availability
  );
  if (!agentId) return null;

  const observedAt = new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const prompt = buildSystemMemoryDiagnosisPrompt(payload, observedAt, isMac());
  if (!prompt) return null;
  return { agentId, prompt, name: "Memory pressure" };
}

function buildDiagnosisAction(payload: SystemMemoryPressurePayload): NotificationAction | null {
  const args = resolveDiagnosisLaunch(payload);
  if (!args) return null;
  let launching = false;
  const action: NotificationAction = {
    label: "Ask agent about memory",
    actionId: "agent.launch",
    actionArgs: args,
    onClick: async () => {
      if (launching) return;
      const store = useSystemMemoryNoticeStore.getState();
      // Captured now: recovery and a new episode can both land mid-launch, and
      // an inbox row from an episode long gone still launches but must never
      // clear a later episode's row.
      const clickedNotice = store.notice?.action === action ? store.notice : null;
      launching = true;
      try {
        const result = await actionService.dispatch<{ launched: boolean }>("agent.launch", args, {
          source: "user",
        });
        // The row stays until recovery otherwise, so each click would start
        // another agent. The inbox row keeps its normal lifecycle.
        if (
          result.ok &&
          result.result?.launched &&
          clickedNotice &&
          useSystemMemoryNoticeStore.getState().notice === clickedNotice
        ) {
          useSystemMemoryNoticeStore.getState().clearNotice();
        }
      } finally {
        launching = false;
      }
    },
  };
  return action;
}

export function handleSystemMemoryPressure(payload: SystemMemoryPressurePayload): void {
  if (payload.status === "normal") {
    // Recovery reaches every view; only the one that raised the notice answers.
    if (!noticeRaised) return;
    noticeRaised = false;
    useSystemMemoryNoticeStore.getState().clearNotice();
    notify({
      type: "success",
      priority: "low",
      urgent: false,
      countable: false,
      supersedeKey: SUPERSEDE_KEY,
      title: "System memory readings recovered",
      message: "Every monitored reading has stayed below its threshold for three samples in a row.",
      context: { eventKind: "host" },
    });
    return;
  }

  if (noticeRaised) return;
  const reading = describeSystemMemoryReadings(payload);
  const message = formatSystemMemoryPressureMessage(payload, isMac());
  if (!reading || !message) return;
  noticeRaised = true;
  const diagnosis = buildDiagnosisAction(payload);
  // Main publishes once per episode. The live reading is an ambient sidebar
  // footer row (#13101): a system state Daintree didn't cause and can't fix
  // doesn't earn a grid bar. The inbox keeps a quiet, uncounted record, which
  // the recovery row supersedes.
  useSystemMemoryNoticeStore.getState().setNotice({ reading, detail: message, action: diagnosis });
  notify({
    type: "warning",
    priority: "low",
    urgent: false,
    countable: false,
    title: "High system memory use",
    message,
    supersedeKey: SUPERSEDE_KEY,
    context: { eventKind: "host" },
    ...(diagnosis ? { actions: [diagnosis] } : {}),
  });
}

export function useSystemMemoryPressureNotice(): void {
  useEffect(() => {
    if (!isElectronAvailable() || ipcListenerAttached) return;
    window.electron.events.on("system:memory-pressure", handleSystemMemoryPressure);
    ipcListenerAttached = true;
  }, []);
}
