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
import { useProjectStore } from "@/store/projectStore";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { logError } from "@/utils/logger";
import { getDefaultAgentId } from "@/lib/resolveAgentId";

export function registerHelpActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  actions.set("help.shortcuts", () => ({
    id: "help.shortcuts",
    title: "Keyboard Shortcuts",
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
    title: "Keyboard Shortcuts (Alt)",
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

  actions.set("help.launchAgent", () => ({
    id: "help.launchAgent",
    title: "Launch Help Agent",
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
      // `currentProject` is captured in the same synchronous block so the
      // session is provisioned with a project identity and context snapshot
      // that are guaranteed consistent — a project switch during the
      // `getFolderPath()` await can't split them (#8317).
      const capturedContext = actionService.getContext();
      const project = useProjectStore.getState().currentProject;
      const folderPath = await window.electron.help.getFolderPath();
      if (!folderPath) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Help Agent",
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
        const resolved = isInitialized
          ? getDefaultAgentId(defaultAgent, undefined, availability)
          : null;
        agentId = resolved ?? "claude";
      }

      const helpPrompt =
        "I need help with Daintree, an Electron-based IDE for orchestrating AI coding agents. Please briefly tell me how you can help.";

      let session: Awaited<ReturnType<typeof window.electron.help.provisionSession>> | null = null;
      if (!project) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Daintree Assistant",
          message: "Project state is still loading.",
        });
        return;
      }

      try {
        session = await window.electron.help.provisionSession({
          projectId: project.id,
          projectPath: project.path,
          agentId,
          context: capturedContext,
        });
      } catch (err) {
        logError("Failed to provision help session", err);
        const code =
          err && typeof err === "object" && "code" in err
            ? (err as Record<string, unknown>).code
            : undefined;
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: code === "MCP_NOT_READY" ? "Start MCP failed" : "Assistant launch failed",
          message:
            code === "MCP_NOT_READY"
              ? "Daintree Assistant needs MCP, but the server didn't start."
              : "Couldn't provision the Daintree Assistant session.",
        });
        return;
      }

      if (!session) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Assistant launch failed",
          message: "Couldn't provision the Daintree Assistant session.",
        });
        return;
      }

      const cwd = session.sessionPath;
      const env: Record<string, string> = {
        DAINTREE_MCP_TOKEN: session.token,
        DAINTREE_WINDOW_ID: String(session.windowId),
        ...(session.mcpUrl ? { DAINTREE_MCP_URL: session.mcpUrl } : {}),
        DAINTREE_PROJECT_ID: project.id,
      };

      const result = await actionService.dispatch<{ terminalId: string | null }>(
        "agent.launch",
        {
          agentId,
          cwd,
          location: "dock",
          prompt: helpPrompt,
          ephemeral: true,
          ...(env && { env }),
        },
        { source: "user" }
      );

      if (result.ok && result.result?.terminalId) {
        useHelpPanelStore
          .getState()
          .setTerminal(result.result.terminalId, agentId, session?.sessionId ?? null);
        useFocusStore.getState().clearAssistantGesture();
        if (!useHelpPanelStore.getState().isOpen) {
          suppressSidebarResizes();
          useHelpPanelStore.getState().setOpen(true);
        }
        window.electron.help.markTerminal(result.result.terminalId).catch(() => {});
      } else if (session) {
        window.electron.help.revokeSession(session.sessionId).catch((err) => {
          logError("Failed to revoke help session after failed launch", err);
        });
      }
    },
  }));

  actions.set("help.gettingStarted.show", () => ({
    id: "help.gettingStarted.show",
    title: "Getting Started",
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

  actions.set("help.togglePanel", () => ({
    id: "help.togglePanel",
    title: "Toggle Help Panel",
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
