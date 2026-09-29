import { useEffect } from "react";
import { enqueueUiPrompt, usePluginPromptStore } from "@/store/pluginPromptStore";
import { draftAgentContext } from "@/services/agentHandoff/agentDraft";

/**
 * Sets up the renderer-side bridge for imperative plugin UI prompts (#10522).
 *
 * Listens for `host.showQuickPick`/`showInputBox`/`showConfirm` requests from
 * the main process, enqueues each into `pluginPromptStore` (which drives the
 * singleton dialogs), and sends the user's answer back over the response
 * channel once the dialog settles. A main-process cancel (plugin unloaded
 * mid-prompt) drops the matching queued prompts.
 *
 * Sending a response for an already-cancelled prompt is harmless: the main-side
 * pending entry was resolved and removed by `cancelForPlugin`, so the late
 * response simply finds no match and is ignored.
 */
export function usePluginPromptBridge(): void {
  useEffect(() => {
    if (!window.electron?.pluginBridge?.onUiPromptRequest) return;

    let disposed = false;

    const cleanupRequest = window.electron.pluginBridge.onUiPromptRequest(async (request) => {
      // A send-to-agent that names its pane is not a dialog: it drafts now and
      // answers, without queueing behind (or blocking) a prompt on screen.
      const { params } = request;
      if (params.kind === "sendToAgent" && params.request.terminalId !== undefined) {
        // Main has already answered a request past its deadline (a view that
        // was frozen when it arrived); drafting now would contradict that.
        if (request.expiresAt !== undefined && Date.now() > request.expiresAt) return;
        const drafted = draftAgentContext(params.request.terminalId, params.request);
        if (disposed) return;
        window.electron.pluginBridge.sendUiPromptResponse({
          promptId: request.promptId,
          result: drafted,
        });
        return;
      }
      // A picker row that starts an agent closes the picker at once and
      // answers when the agent is up. Main hears of the acceptance first, so a
      // cancel from the plugin in between waits for that answer rather than
      // reporting "cancelled" for an agent the user is starting.
      const value = await enqueueUiPrompt(request, () => {
        if (disposed) return;
        window.electron.pluginBridge.sendUiPromptResponse({
          promptId: request.promptId,
          accepted: true,
        });
      });
      if (disposed) return;
      window.electron.pluginBridge.sendUiPromptResponse({
        promptId: request.promptId,
        result: value,
      });
    });

    const cleanupCancel = window.electron.pluginBridge.onUiPromptCancel(
      ({ pluginId, promptId }) => {
        usePluginPromptStore.getState().cancelByPluginId(pluginId, promptId);
      }
    );

    return () => {
      disposed = true;
      cleanupRequest();
      cleanupCancel();
    };
  }, []);
}
