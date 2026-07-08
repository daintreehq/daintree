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
import { isAssistantOnlyAgentId } from "@shared/config/agentIds";

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

  // help.displayImage is registered here purely for manifest registration —
  // schema, description, tier, and audit metadata (#9828). Execution is handled
  // inline in the MCP CallTool handler (electron/services/mcp-server/
  // sessionServer.ts): the URL is validated against the daintree.org allowlist,
  // a figure number is assigned sequentially per help session, and the figure
  // is pushed to the pinned renderer. The tool lives only in WORKBENCH_TIER_TOOLS
  // (never the external/api-key allowlist), so only help sessions can call it.
  // `run()` throws if the renderer ever invokes it directly.
  actions.set("help.displayImage", () => ({
    id: "help.displayImage",
    title: "Display documentation image",
    description:
      "Display a Daintree documentation image inline in the assistant panel so it can be referenced as `[image #N]`. Call this when a `daintree-docs` search result includes an image URL that directly illustrates your answer; skip images that are decorative or tangential rather than displaying every image a result contains. Reference the returned `figureLabel` as plain text at the insertion point (e.g. `[image #2]`) — never markdown image syntax (`![](...)`), which CLI renderers strip. Args: `url` is an `https://daintree.org` image URL (data:/blob:/non-daintree URLs are rejected); `caption` and `altText` are optional. Returns { imageId, figureNumber, figureLabel } — the figure number is assigned by the app sequentially per session; never pick your own.",
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
      caption: z.string().optional().describe("Optional caption shown beneath the figure."),
      altText: z.string().optional().describe("Optional alternative text for accessibility."),
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
        let message = "Couldn't start the Daintree Assistant session.";
        if (code === "MCP_PROBE_FAILED") {
          message =
            "Daintree's assistant services didn't respond in time. Check assistant settings, then try again.";
        } else if (code === "MCP_SERVER_NOT_STARTED" || code === "MCP_NOT_READY") {
          message =
            "Daintree's assistant services didn't start. Check assistant settings, then try again.";
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
      // project root so its file tools (read/list/grep/edit) and the terminal's
      // file-link resolution operate on the actual project; other help agents
      // stay in the session dir that owns their .mcp.json / settings. The
      // session token still scopes the assistant's MCP surface to this project.
      const cwd = isAssistantOnlyAgentId(agentId) ? project.path : session.sessionPath;
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
          location: "overlay",
          prompt: helpPrompt,
          excludeFromPersistence: true,
          removeOnExit: true,
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

  actions.set("help.openCommandsFolder", () => ({
    id: "help.openCommandsFolder",
    title: "Open Assistant Commands Folder",
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
