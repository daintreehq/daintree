import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { AgentIdSchema } from "./schemas";
import { z } from "zod";
import { suppressSidebarResizes } from "@/lib/sidebarToggle";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useFocusStore } from "@/store/focusStore";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { isAssistantFocused } from "@/store/macroFocusStore";
import {
  notifyLaunchFailed,
  LAUNCH_BLOCKED_LOADING,
  LAUNCH_BLOCKED_NO_WORKSPACE,
} from "@/controllers/LaunchNotifications";
import { logError } from "@/utils/logger";
import { extractHelpSessionErrorCode } from "@/utils/clientHelpSessionError";
import { getDefaultAgentId } from "@/lib/resolveAgentId";
import { loadCustomLaunchFlags } from "@/lib/assistantLaunchFlags";
import { ensureHelpPanelRuntime } from "@/lib/helpPanelRuntimeGate";
import { openTour } from "@/components/Tour/tourEvents";
import { isAssistantOnlyAgentId, isBuiltInAgentId } from "@shared/config/agentIds";
import {
  ASSISTANT_SLOTS,
  MAX_ASSISTANT_SLOTS,
  assistantSlotKey,
  projectIdFromSlotKey,
} from "@shared/config/assistantSlots";
import { getAssistantSupportedAgentIds } from "@shared/config/agentRegistry";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";

type HelpPanelState = ReturnType<typeof useHelpPanelStore.getState>;

// A lane is free only when nothing could be lost by launching into it: no
// terminal (live or reserved), no provisioned session, and no hibernated
// conversation waiting to resume there. A live lane mirrors its resume token
// into `hibernateSessions` too, so the last check also covers it.
function isFreeHelpLane(state: HelpPanelState, workspaceId: string, slot: number): boolean {
  const lane = state.sessions[slot];
  return (
    !!lane &&
    lane.terminalId === null &&
    lane.sessionId === null &&
    !(assistantSlotKey(workspaceId, slot) in state.hibernateSessions)
  );
}

/**
 * The lane `help.launchAgent` may launch into without displacing anything
 * (#13192): the active tab if it is free, else another free tab, else a slot
 * no tab occupies yet (`isNew`). Null when every slot holds a session.
 */
function pickHelpLaunchLane(
  state: HelpPanelState,
  workspaceId: string
): { slot: number; isNew: boolean } | null {
  if (isFreeHelpLane(state, workspaceId, state.activeSlot)) {
    return { slot: state.activeSlot, isNew: false };
  }
  for (const slot of ASSISTANT_SLOTS) {
    if (isFreeHelpLane(state, workspaceId, slot)) return { slot, isNew: false };
  }
  for (const slot of ASSISTANT_SLOTS) {
    if (
      !state.sessions[slot] &&
      !(assistantSlotKey(workspaceId, slot) in state.hibernateSessions)
    ) {
      return { slot, isNew: true };
    }
  }
  return null;
}

/**
 * The agent another lane of this workspace is running or will resume with.
 * Lanes of one project share a session folder and must run one agent — main
 * refuses a mismatch with `MIXED_AGENT_LANES` — so a help launch beside them
 * has to join that agent rather than fail on the default. A live lane proves
 * its agent launches; a hibernated one only counts while its CLI still does,
 * since main doesn't hold it against the launch and a missing CLI would.
 */
function siblingLaneAgentId(
  state: HelpPanelState,
  workspaceId: string,
  slot: number,
  canLaunch: (agentId: string) => boolean
): string | null {
  const liveSlots = [state.activeSlot, ...ASSISTANT_SLOTS].filter((n) => n !== slot);
  for (const n of liveSlots) {
    const lane = state.sessions[n];
    if (lane?.terminalId && lane.agentId) return lane.agentId;
  }
  const ownKey = assistantSlotKey(workspaceId, slot);
  for (const [key, entry] of Object.entries(state.hibernateSessions)) {
    if (
      key !== ownKey &&
      projectIdFromSlotKey(key) === workspaceId &&
      entry.agentId &&
      canLaunch(entry.agentId)
    ) {
      return entry.agentId;
    }
  }
  return null;
}

export function registerHelpActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("help.shortcuts", () => ({
    id: "help.shortcuts",
    title: "Keyboard shortcuts",
    description: "Show keyboard shortcuts reference",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["hotkeys", "keys", "reference", "bindings"],
    run: async () => {
      callbacks.onOpenShortcuts();
    },
  }));

  actions.set("help.shortcutsAlt", () => ({
    id: "help.shortcutsAlt",
    title: "Keyboard shortcuts (Alt)",
    description: "Show keyboard shortcuts reference",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["hotkeys", "keys", "reference", "bindings"],
    run: async () => {
      callbacks.onOpenShortcuts();
    },
  }));

  // help.displayImage is registered here purely for manifest registration —
  // schema, description, tier, and audit metadata (#9828). Execution is handled
  // inline in the MCP CallTool handler (electron/services/mcp-server/
  // sessionServer.ts): the URL is validated against the daintree.org allowlist,
  // a figure number is assigned sequentially per help session, and the figure
  // is pushed to the pinned renderer. The tool lives only in CORE_TIER_TOOLS
  // (never the external/api-key allowlist), and the handler refuses any session
  // without a help-session id, so only help sessions can call it.
  // `run()` throws if the renderer ever invokes it directly.
  actions.set("help.displayImage", () => ({
    id: "help.displayImage",
    title: "Display documentation image",
    description:
      "Show a documentation image inline in the assistant panel, only when it genuinely illustrates the answer. Cite the returned figure label as plain text where it belongs, not as markdown image syntax, which CLI renderers strip. Never choose figure numbers yourself.",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    mcpVisibility: "core",
    argsSchema: z.object({
      url: z
        .string()
        .min(1)
        .describe("An https://daintree.org image URL. data:, blob:, and other hosts are rejected."),
      caption: z.string().optional().describe("Caption shown under the figure."),
      altText: z.string().optional().describe("Alt text for accessibility."),
    }),
    rawOutputSchema: {
      type: "object",
      properties: {
        imageId: { type: "string" },
        figureNumber: { type: "number" },
        figureLabel: { type: "string" },
      },
      required: ["imageId", "figureNumber", "figureLabel"],
    },
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
    },
    examples: [
      {
        args: {
          url: "https://daintree.org/img/docs/worktree-dashboard.png",
          caption: "The worktree dashboard",
        },
        description:
          "A daintree-docs result returned this screenshot and it directly illustrates the answer — pin it, then write the returned `figureLabel` (e.g. `[image #N]`) at the relevant point in the reply.",
      },
      {
        args: { url: "https://daintree.org/img/docs/terminal-grid.png" },
        description:
          "Only call this for images that genuinely help — if a result's image is decorative or tangential to the question, do not display it.",
      },
    ],
    run: async () => {
      throw new Error(
        "help.displayImage must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("help.launchAgent", () => ({
    id: "help.launchAgent",
    title: "Launch help agent",
    description: "Open an AI agent in the help workspace folder",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["assistant", "support", "docs", "guide"],
    argsSchema: z.object({ agentId: AgentIdSchema.optional() }).optional(),
    run: async (args?: unknown) => {
      // Snapshot the renderer's action context BEFORE any await. This is
      // bound to the MCP session at provision and replayed as the
      // contextOverride on every assistant tool call, so a focus shift
      // during the model's turn can't retarget actions onto the wrong
      // worktree/terminal (#8317). Capturing after an await would
      // reintroduce the exact stale-read race this fixes (lesson #5087).
      // The workspace is captured in the same synchronous block so the
      // session is provisioned with a workspace identity and context snapshot
      // that are guaranteed consistent — a workspace switch during the
      // `getFolderPath()` await can't split them (#8317).
      //
      // The active workspace is a project OR a scratch (#11068): switching to a
      // scratch clears `currentProject` by design, and main keys the assistant's
      // session on an opaque workspace id (`ctx.projectId` resolves through
      // ProjectViewManager, which maps scratch ids the same as project ids), so
      // a scratch's `{ id, path }` provisions unchanged. The two pointers are
      // mutually exclusive; project-first only guards a transient inconsistency.
      const capturedContext = actionService.getContext();
      const projectState = useProjectStore.getState();
      const workspace = projectState.currentProject ?? useScratchStore.getState().currentScratch;
      const isProjectStateSettled = projectState.isBootstrapped;
      // Started before the first await so the panel's lazy chunk loads in
      // parallel with the folder lookup; awaited before the session is bound.
      const helpPanelRuntimeReady = ensureHelpPanelRuntime();
      const folderPath = await window.electron.help.getFolderPath();
      if (!folderPath) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Help agent",
          message: "Help folder not available. Please ensure the help workspace is configured.",
        });
        return;
      }

      const parsed = args as { agentId?: string } | undefined;
      let agentId: string;
      if (parsed?.agentId) {
        agentId = parsed.agentId;
      } else {
        const { defaultAgent } = useAgentPreferencesStore.getState();
        const { availability, isInitialized } = useCliAvailabilityStore.getState();
        // Constrain the implicit default to agents the assistant gate will
        // actually admit — `getDefaultAgentId` otherwise answers with general
        // launch eligibility and can name one `provisionSession` refuses (a
        // deprecated tier, or an unimplemented injection mode). An explicit
        // `args.agentId` still goes straight to that gate, so an experimental
        // agent stays launchable by name.
        const resolved = isInitialized
          ? getDefaultAgentId(
              defaultAgent,
              undefined,
              availability,
              new Set(getAssistantSupportedAgentIds())
            )
          : null;
        agentId = resolved ?? "claude";
      }

      const helpPrompt =
        "I need help with Daintree, an IDE for orchestrating AI coding agents. Please briefly tell me how you can help.";

      let session: Awaited<ReturnType<typeof window.electron.help.provisionSession>> | null = null;
      if (!workspace) {
        // Shares the panel controller's copy so both launch entry points fail
        // identically, and only claims "loading" when state really is still
        // hydrating — the old message said so unconditionally (#11068).
        notifyLaunchFailed(
          agentId,
          isProjectStateSettled ? LAUNCH_BLOCKED_NO_WORKSPACE : LAUNCH_BLOCKED_LOADING
        );
        return;
      }

      // Name the lane explicitly (#12108) rather than letting main default it.
      // Chosen once, before the provision, so the lane this session is minted
      // for is the same one the terminal binds into below even if the user
      // switches tabs while the await is outstanding. Provisioning revokes and
      // kills whatever a lane was running, so a busy tab is never a target: the
      // help agent opens beside it instead (#13192).
      await helpPanelRuntimeReady;
      const panelState = useHelpPanelStore.getState();
      const lane = pickHelpLaunchLane(panelState, workspace.id);
      if (!lane) {
        if (!panelState.isOpen) {
          suppressSidebarResizes();
          panelState.setOpen(true);
        }
        notify({
          type: "warning",
          title: "Assistant tabs full",
          message: `All ${MAX_ASSISTANT_SLOTS} assistant tabs are in use. Close one to launch the help agent.`,
          priority: "high",
          context: { eventKind: "uiFeedback" },
        });
        return;
      }
      const targetSlot = lane.slot;
      if (!parsed?.agentId) {
        const { availability, isInitialized } = useCliAvailabilityStore.getState();
        const canLaunch = (id: string) =>
          !isInitialized || !isBuiltInAgentId(id) || isAgentLaunchable(availability[id]);
        agentId = siblingLaneAgentId(panelState, workspace.id, targetSlot, canLaunch) ?? agentId;
      }

      try {
        session = await window.electron.help.provisionSession({
          projectId: workspace.id,
          projectPath: workspace.path,
          agentId,
          context: capturedContext,
          slot: targetSlot,
        });
      } catch (err) {
        logError("Failed to provision help session", err);
        // Decode BEFORE any message formatting: the contextBridge strips the
        // custom `code` property, so it rides an encoded message prefix.
        const code = extractHelpSessionErrorCode(err);
        let message = "Couldn't start the Daintree Assistant session.";
        if (code === "MCP_PROBE_FAILED") {
          message =
            "Daintree's assistant services didn't respond in time. Check assistant settings, then try again.";
        } else if (code === "MCP_SERVER_NOT_STARTED" || code === "MCP_NOT_READY") {
          message =
            "Daintree's assistant services didn't start. Check assistant settings, then try again.";
        } else if (code === "USER_CONTENT_SYNC_FAILED") {
          message =
            "Daintree couldn't load this project's assistant folder, so the session didn't start. Try again.";
        } else if (code === "MIXED_AGENT_LANES") {
          message =
            "Another session in this project is running a different agent. Sessions of one project share a folder and use one agent, so stop that session first or open this one with the same agent.";
        }
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Assistant couldn't start",
          message,
        });
        return;
      }

      if (!session) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Assistant couldn't start",
          message: "Couldn't start the Daintree Assistant session.",
        });
        return;
      }

      // The Daintree Assistant is env-only (MCP via DAINTREE_MCP_* env vars)
      // and ships its own skills, so it reads nothing from cwd. Run it in the
      // workspace root so its file tools (read/list/grep/edit) and the terminal's
      // file-link resolution operate on the actual workspace; other help agents
      // stay in the session dir that owns their .mcp.json / settings. The
      // session token still scopes the assistant's MCP surface to this workspace.
      const cwd = isAssistantOnlyAgentId(agentId) ? workspace.path : session.sessionPath;
      const env: Record<string, string> = {
        DAINTREE_MCP_TOKEN: session.token,
        DAINTREE_WINDOW_ID: String(session.windowId),
        ...(session.mcpUrl ? { DAINTREE_MCP_URL: session.mcpUrl } : {}),
        DAINTREE_PROJECT_ID: workspace.id,
      };

      const agentLaunchFlags = await loadCustomLaunchFlags(agentId);
      const result = await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        {
          agentId,
          cwd,
          location: "overlay",
          prompt: helpPrompt,
          excludeFromPersistence: true,
          removeOnExit: true,
          ...(env && { env }),
          ...(agentLaunchFlags.length > 0 && { agentLaunchFlags }),
        },
        { source: "user" }
      );

      if (result.ok && result.result?.terminalId) {
        const launchedTerminalId = result.result.terminalId;
        // The lane can be closed while the provision + dispatch awaits are
        // outstanding (#12108). `setTerminal` refuses to bind into a lane that
        // is gone, so binding blind would leave this PTY holding a live bearer,
        // owned by no lane and no longer filtered out of the dock. Tear it down
        // instead — revoke before kill, mirroring `_teardownBoundSession`.
        //
        // A lane that did not exist yet is created only now, already bound, so
        // its runtime never mounts empty and auto-launches a second session into
        // the slot this one was provisioned for. Should a tab have claimed the
        // slot meanwhile, it is ours to keep only while it is still free.
        const bindState = useHelpPanelStore.getState();
        const laneLost = lane.isNew
          ? !!bindState.sessions[targetSlot] && !isFreeHelpLane(bindState, workspace.id, targetSlot)
          : !bindState.sessions[targetSlot];
        if (laneLost) {
          window.electron.help.revokeSession(session.sessionId).catch((err) => {
            logError("Failed to revoke help session for a lane closed mid-launch", err);
          });
          usePanelStore.getState().removePanel(launchedTerminalId);
          return;
        }
        // Bind into the lane provisioning targeted above (#12108): binding
        // anywhere else would leave that session unreachable. Then show it.
        if (lane.isNew) bindState.ensureSlot(targetSlot);
        const helpPanel = useHelpPanelStore.getState();
        helpPanel.setTerminal(targetSlot, launchedTerminalId, agentId, session?.sessionId ?? null);
        useFocusStore.getState().clearAssistantGesture();
        const switchedLane = helpPanel.activeSlot !== targetSlot;
        helpPanel.setActiveSlot(targetSlot);
        if (!helpPanel.isOpen) {
          suppressSidebarResizes();
          helpPanel.setOpen(true);
        } else if (switchedLane) {
          // A lane that was in the background has no trustworthy geometry;
          // the focus request drives the panel's fit-and-repaint reveal.
          helpPanel.requestFocus();
        }
        window.electron.help.markTerminal(result.result.terminalId).catch(() => {});
      } else if (session) {
        window.electron.help.revokeSession(session.sessionId).catch((err) => {
          logError("Failed to revoke help session after failed launch", err);
        });
      }
    },
  }));

  actions.set("help.openCommandsFolder", () => ({
    id: "help.openCommandsFolder",
    title: "Open assistant commands folder",
    description:
      "Open the folder where custom assistant commands and skills live (~/.daintree/assistant)",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    // Opening an OS file-manager window is a human affordance — never
    // something an MCP agent should discover or trigger.
    mcpVisibility: "hidden",
    keywords: ["custom", "skills", "slash", "prompts", "assistant", "commands"],
    run: async () => {
      const result = await window.electron.help.openAssistantContentFolder();
      if (!result) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't open commands folder",
          message:
            "Daintree couldn't create ~/.daintree/assistant. Check that your home folder is writable, then try again.",
        });
      } else if (!result.opened) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't open commands folder",
          message: `The folder is ready at ${result.path} — open it manually in your file manager.`,
        });
      }
    },
  }));

  actions.set("help.gettingStarted.show", () => ({
    id: "help.gettingStarted.show",
    title: "Getting started",
    description: "Show the getting started checklist",
    category: "help",
    kind: "command",
    danger: "safe",
    nonRepeatable: true,
    scope: "renderer",
    keywords: ["onboarding", "checklist", "welcome", "tutorial"],
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:show-getting-started"));
    },
  }));

  actions.set("help.tour.show", () => ({
    id: "help.tour.show",
    title: "Daintree Tour",
    description: "Play the narrated tour of Daintree's essentials",
    category: "help",
    kind: "command",
    danger: "safe",
    nonRepeatable: true,
    scope: "renderer",
    keywords: ["tour", "tutorial", "walkthrough", "onboarding", "intro", "video"],
    // Optional so every existing zero-argument caller (menu, palette, MCP) keeps working.
    // An id no tour is registered under is the host's to handle, not a validation error.
    argsSchema: z
      .object({
        tourId: z.string().optional().describe("Tour to play; defaults to the Daintree tour"),
      })
      .optional(),
    run: async (args: { tourId?: string } | undefined) => {
      openTour(args?.tourId);
    },
  }));

  actions.set("help.togglePanel", () => ({
    id: "help.togglePanel",
    title: "Toggle help panel",
    description: "Show or hide the help panel",
    category: "help",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["docs", "support", "guide", "assistant"],
    run: async () => {
      suppressSidebarResizes();
      const store = useHelpPanelStore.getState();

      if (!store.isOpen) {
        // Closed → open and focus the input
        useFocusStore.getState().clearAssistantGesture();
        store.setOpen(true);
        store.requestFocus();
      } else if (!isAssistantFocused()) {
        // Open but blurred → focus the input without closing
        useFocusStore.getState().clearAssistantGesture();
        store.requestFocus();
      } else {
        // Open and focused → close
        store.setOpen(false);
      }
    },
  }));
}
