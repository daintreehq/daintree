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
} from "./plugin.js";

/** Discriminant for the three imperative prompt kinds. */
export type PluginUiPromptKind = "quickPick" | "inputBox" | "confirm";

/** Kind-tagged parameters for one prompt request. */
export type PluginUiPromptParams =
  | { kind: "quickPick"; items: PluginQuickPickItem[]; options: PluginQuickPickOptions }
  | { kind: "inputBox"; options: PluginInputBoxOptions }
  | { kind: "confirm"; options: PluginConfirmOptions };

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
  PluginQuickPickItem | PluginQuickPickItem[] | string | boolean | undefined;

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
