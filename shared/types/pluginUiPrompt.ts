// Cross-process payload types for the imperative plugin UI-prompt bridge
// (#10522). A plugin's `host.showQuickPick` / `showInputBox` / `showConfirm`
// call originates in main (`PluginUIPromptDispatcher`), is sent to the active
// renderer over `PLUGIN_UI_PROMPT_REQUEST`, rendered by a queue-driven dialog,
// and answered back over `PLUGIN_UI_PROMPT_RESPONSE`. These types describe the
// serializable shapes that cross that boundary — the public option/item types
// they reference live in `plugin.ts` (the frozen SDK surface).

import type {
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginInputBoxOptions,
  PluginConfirmOptions,
  PluginSendToAgentResult,
} from "./plugin.js";

/**
 * Discriminant for the imperative prompt kinds. `sendToAgent` is
 * `host.sendToAgent`: it rides this bridge because, without a `terminalId`, it
 * is a picker the user answers — and with one it still has to reach the one
 * renderer that owns the project's drafts.
 */
export type PluginUiPromptKind = "quickPick" | "inputBox" | "confirm" | "sendToAgent";

/**
 * A validated `host.sendToAgent` call on its way to the renderer. `sourceLabel`
 * is the plugin's display name, resolved by the host rather than taken from the
 * plugin, so the draft's heading cannot claim to come from someone else.
 */
export interface PluginSendToAgentRequest {
  text: string;
  title?: string;
  sourceLabel: string;
  terminalId?: string;
  worktreeId?: string;
}

/** Kind-tagged parameters for one prompt request. */
export type PluginUiPromptParams =
  | { kind: "quickPick"; items: PluginQuickPickItem[]; options: PluginQuickPickOptions }
  | { kind: "inputBox"; options: PluginInputBoxOptions }
  | { kind: "confirm"; options: PluginConfirmOptions }
  | { kind: "sendToAgent"; request: PluginSendToAgentRequest };

/**
 * Whether a prompt puts a dialog in front of the user. A `sendToAgent` with a
 * target drafts and answers at once, so it neither waits behind nor counts
 * against the plugin's one open dialog.
 */
export function promptOpensDialog(params: PluginUiPromptParams): boolean {
  return !(params.kind === "sendToAgent" && params.request.terminalId !== undefined);
}

/**
 * One prompt request sent main → renderer. `promptId` correlates the eventual
 * `PluginUiPromptResponse`; `pluginId` drives provenance display and the
 * unload-cancel drain.
 */
export interface PluginUiPromptRequest {
  promptId: string;
  pluginId: string;
  params: PluginUiPromptParams;
}

/**
 * The resolved value for a prompt, by kind. `undefined` is the dismiss/cancel
 * outcome for quick-pick and input-box; `false` for confirm. Survives the
 * structured-clone IPC boundary (Electron serializes `undefined`).
 */
export type PluginUiPromptResultValue =
  | PluginQuickPickItem
  | PluginQuickPickItem[]
  | string
  | boolean
  | PluginSendToAgentResult
  | undefined;

/** Renderer → main reply carrying the user's answer (fire-and-forget). */
export interface PluginUiPromptResponse {
  promptId: string;
  result: PluginUiPromptResultValue;
}

/**
 * Main → renderer broadcast telling the renderer to drop pending prompts —
 * sent when a plugin is unloaded with a prompt still open. `promptId` cancels
 * one specific prompt; omitting it cancels every prompt for `pluginId`.
 */
export interface PluginUiPromptCancel {
  pluginId: string;
  promptId?: string;
}
