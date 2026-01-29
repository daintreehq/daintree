import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";

/**
 * Hook that listens for action dispatch requests from the main process.
 * Used by the Assistant panel's tool calling to execute renderer-side actions.
 *
 * This enables the AssistantService running in main to execute
 * renderer-side actions via ActionService and get results back.
 */
export function useAppAgentDispatcher(): void {
  useEffect(() => {
    if (!window.electron?.appAgent?.onDispatchActionRequest) {
      return;
    }

    const cleanup = window.electron.appAgent.onDispatchActionRequest(async (payload) => {
      const { requestId, actionId, args } = payload;

      try {
        // Dispatch the action through ActionService with agent source
        const result = await actionService.dispatch(actionId as ActionId, args, {
          source: "agent",
          confirmed: true, // Agent-dispatched actions are pre-confirmed
        });

        // Send the result back to main process
        window.electron.appAgent.sendDispatchActionResponse({
          requestId,
          result: result.ok
            ? { ok: true, result: result.result }
            : { ok: false, error: result.error },
        });
      } catch (err) {
        // Handle unexpected errors
        window.electron.appAgent.sendDispatchActionResponse({
          requestId,
          result: {
            ok: false,
            error: {
              code: "UNEXPECTED_ERROR",
              message: err instanceof Error ? err.message : String(err),
            },
          },
        });
      }
    });

    return cleanup;
  }, []);
}
