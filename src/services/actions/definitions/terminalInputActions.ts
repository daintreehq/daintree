import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { z } from "zod";
import { terminalClient } from "@/clients";
import { openSendToAgentPalette } from "@/hooks/useSendToAgentPalette";
import { openPanelContextMenu } from "@/lib/panelContextMenu";
import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { triggerPopStash, triggerStashInput } from "@/store/terminalInputStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isPtyPanel } from "@shared/types/panel";
import { formatWithBracketedPaste } from "@shared/utils/terminalInputProtocol";
export function registerTerminalInputActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("terminal.inject", () => ({
    id: "terminal.inject",
    title: "Inject Context",
    description: "Inject worktree context into terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      if (activeWorktreeId) {
        callbacks.onInject(activeWorktreeId);
      }
    },
  }));

  actions.set("terminal.copy", () => ({
    id: "terminal.copy",
    title: "Copy Selection",
    description: "Copy the current terminal selection to clipboard",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      const managed = terminalInstanceService.get(targetId);
      if (managed?.terminal) {
        const selection = managed.terminal.getSelection();
        if (selection) {
          await navigator.clipboard.writeText(selection);
        }
      }
    },
  }));

  actions.set("terminal.paste", () => ({
    id: "terminal.paste",
    title: "Paste",
    description: "Paste clipboard content into the terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    // Writes clipboard text (including \r-terminated, auto-executing commands in
    // non-bracketed mode) into a terminal — closed to plugin dispatch so it
    // can't be an end-run around the `agent:input` capability (#10558).
    denyPluginDispatch: true,
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }).optional(),
    run: async (args: unknown) => {
      const { terminalId } = (args as { terminalId?: string } | undefined) ?? {};
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (!targetId) return;
      const terminal = state.panelsById[targetId];
      if (terminal && isPtyPanel(terminal) && terminal.isInputLocked) return;
      const managed = terminalInstanceService.get(targetId);
      if (!managed || managed.isInputLocked) return;
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return;
        if (managed.terminal.modes.bracketedPasteMode) {
          terminalClient.write(targetId, formatWithBracketedPaste(text));
        } else {
          terminalClient.write(targetId, text.replace(/\r?\n/g, "\r"));
        }
        terminalInstanceService.notifyUserInput(targetId);
      } catch {
        // Clipboard API may be denied
      }
    },
  }));

  actions.set("terminal.copyLink", () => ({
    id: "terminal.copyLink",
    title: "Copy Link Address",
    description: "Copy a URL to the clipboard",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ url: z.string() }),
    run: async (args: unknown) => {
      const { url } = args as { url: string };
      await navigator.clipboard.writeText(url);
    },
  }));

  actions.set("terminal.contextMenu", () => ({
    id: "terminal.contextMenu",
    // Opens the focused panel's context menu — a keyboard affordance for the
    // right-click menu, meaningless to pick from the palette itself.
    palette: { mode: "hidden" },
    title: "Open Context Menu",
    description: "Open the context menu for the focused panel",
    category: "terminal",
    kind: "command",
    danger: "safe",
    nonRepeatable: true,
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = (args ?? {}) as { terminalId?: string };
      const state = usePanelStore.getState();
      const targetId = terminalId ?? state.focusedId;
      if (targetId) {
        openPanelContextMenu(targetId);
      }
    },
  }));

  actions.set("terminal.stashInput", () => ({
    id: "terminal.stashInput",
    title: "Stash Input",
    description: "Park the current hybrid input draft to a temporary stash slot",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["save", "draft", "store", "park"],
    run: async () => {
      const state = usePanelStore.getState();
      const targetId = state.focusedId;
      if (targetId) triggerStashInput(targetId);
    },
  }));

  actions.set("terminal.popStash", () => ({
    id: "terminal.popStash",
    title: "Restore Stashed Input",
    description: "Restore the previously stashed hybrid input draft",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["restore", "recall", "unstash"],
    run: async () => {
      const state = usePanelStore.getState();
      const targetId = state.focusedId;
      if (targetId) triggerPopStash(targetId);
    },
  }));

  actions.set("terminal.bulkCommand", () => ({
    id: "terminal.bulkCommand",
    title: "Fleet: Broadcast",
    description: "Arm every terminal in the current worktree for broadcast",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["broadcast", "fleet", "multi"],
    run: async () => {
      useFleetArmingStore.getState().armAll("current");
    },
  }));

  actions.set("terminal.sendToAgent", () => ({
    id: "terminal.sendToAgent",
    title: "Send to Agent",
    description: "Send terminal selection to another agent or terminal panel",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().optional() }),
    run: async (args: unknown) => {
      const { terminalId } = (args ?? {}) as { terminalId?: string };
      const state = usePanelStore.getState();
      const sourceId = terminalId ?? state.focusedId;
      if (!sourceId) return;

      const terminal = state.panelsById[sourceId];
      if (!terminal) return;
      if (terminal.kind && !panelKindHasPty(terminal.kind)) return;

      openSendToAgentPalette(sourceId);
    },
  }));

  actions.set("terminal.arm", () => ({
    id: "terminal.arm",
    title: "Arm Terminal",
    description:
      "Add a terminal to the fleet arming set so the next broadcast input is also routed to it. Args: `terminalId` (required) — panel UUID from `terminal.list` (the `id` field); ignored when the terminal is not arm-eligible. Returns { armed } — the resulting armed terminal IDs in broadcast (arm) order. Arming reroutes the human's keystrokes to every armed terminal, so agent dispatch must be confirmed first.",
    category: "terminal",
    kind: "command",
    danger: "confirm",
    dangerRationale:
      "Arming reroutes the human's next keystrokes to every armed terminal — an assistant arming a set the user forgets can broadcast commands to multiple terminals unintentionally.",
    // Agent/MCP-only confirm gate — no user-side ConfirmDialog. Hidden from the
    // palette so a palette pick can't bypass the agent-dispatch confirmation.
    palette: { mode: "hidden" },
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().min(1) }),
    resultSchema: z.object({ armed: z.array(z.string()) }),
    mcpOutputSchema: true,
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId: string };
      const terminal = usePanelStore.getState().panelsById[terminalId];
      if (isFleetArmEligible(terminal)) {
        useFleetArmingStore.getState().armId(terminalId);
      }
      return { armed: [...useFleetArmingStore.getState().armOrder] };
    },
  }));

  actions.set("terminal.disarm", () => ({
    id: "terminal.disarm",
    title: "Disarm Terminal",
    description:
      "Remove a terminal from the fleet arming set. Args: `terminalId` (required) — panel UUID from `terminal.list` (the `id` field). No-op when the terminal is not armed. Returns { armed } — the resulting armed terminal IDs in broadcast (arm) order.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ terminalId: z.string().min(1) }),
    resultSchema: z.object({ armed: z.array(z.string()) }),
    mcpOutputSchema: true,
    run: async (args: unknown) => {
      const { terminalId } = args as { terminalId: string };
      useFleetArmingStore.getState().disarmId(terminalId);
      return { armed: [...useFleetArmingStore.getState().armOrder] };
    },
  }));

  actions.set("terminal.disarmAll", () => ({
    id: "terminal.disarmAll",
    title: "Disarm All",
    description:
      "Clear the entire fleet arming set so no terminal receives broadcast input. Returns { armed } — always an empty array.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({ armed: z.array(z.string()) }),
    mcpOutputSchema: true,
    run: async () => {
      useFleetArmingStore.getState().clear();
      return { armed: [...useFleetArmingStore.getState().armOrder] };
    },
  }));

  actions.set("terminal.armByState", () => ({
    id: "terminal.armByState",
    title: "Arm by State",
    description: "Arm all eligible agent terminals in a given agent state",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      state: z.enum(["working", "waiting", "finished"]),
      scope: z.enum(["current", "all"]).optional(),
      extend: z.boolean().optional(),
    }),
    run: async (args: unknown) => {
      const {
        state,
        scope = "current",
        extend = false,
      } = args as {
        state: "working" | "waiting" | "finished";
        scope?: "current" | "all";
        extend?: boolean;
      };
      useFleetArmingStore.getState().armByState(state, scope, extend);
    },
  }));

  actions.set("terminal.armAll", () => ({
    id: "terminal.armAll",
    title: "Arm All Eligible",
    description: "Arm every eligible terminal",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({ scope: z.enum(["current", "all"]).optional() }).optional(),
    run: async (args: unknown) => {
      const { scope = "current" } = (args ?? {}) as { scope?: "current" | "all" };
      useFleetArmingStore.getState().armAll(scope);
    },
  }));

  actions.set("terminal.armDefault", () => ({
    id: "terminal.armDefault",
    title: "Arm Current Worktree",
    description: "Arm all eligible terminals in the active worktree",
    category: "terminal",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      useFleetArmingStore.getState().armAll("current");
    },
  }));
}
