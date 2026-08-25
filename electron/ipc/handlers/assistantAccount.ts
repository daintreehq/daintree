import { z } from "zod";
import { defineIpcNamespace, op, opValidated } from "../define.js";
import { ASSISTANT_ACCOUNT_METHOD_CHANNELS } from "./assistantAccount.preload.js";
import { assistantAccountService } from "../../services/assistant-account/AssistantAccountService.js";
import { webContents } from "electron";
import { CHANNELS } from "../channels.js";
import type {
  AssistantAccountLoginResult,
  AssistantAccountStatusResult,
} from "../../../shared/types/ipc/assistantAccount.js";

/**
 * IPC surface for the Daintree Assistant account.
 *
 * Deliberately thin: four commands in, a progress stream out. All the process handling
 * lives in AssistantAccountService, so this layer only routes — and enforces the one
 * rule that cannot be enforced there.
 *
 * That rule is WHO gets the events. Both identities come from the IPC CONTEXT, never
 * from a payload: Daintree is multi-window, and a renderer must not be able to nominate
 * which view a sign-in — or its outcome — is delivered to. Every push is a targeted send
 * to the WebContents that started the login, never a broadcast, because an account is
 * personal and another project's window has no business seeing it.
 */
export const assistantAccountNamespace = defineIpcNamespace({
  name: "assistantAccount",
  ops: {
    getStatus: opValidated(
      ASSISTANT_ACCOUNT_METHOD_CHANNELS.getStatus,
      // Defaulted rather than optional, so a caller that sends nothing and one that sends
      // `{}` reach the service as the same value and the cheap local read stays the
      // default. `strict` keeps an unrecognised key from riding along into the argv the
      // service builds.
      z
        .object({ refresh: z.boolean().default(false) })
        .strict()
        .default({ refresh: false }),
      async (payload): Promise<AssistantAccountStatusResult> =>
        assistantAccountService.getStatus(payload)
    ),
    login: op(
      ASSISTANT_ACCOUNT_METHOD_CHANNELS.login,
      async (ctx): Promise<AssistantAccountLoginResult> => {
        const target = ctx.webContentsId;
        return assistantAccountService.login(target, (event) => {
          deliver(target, CHANNELS.ASSISTANT_ACCOUNT_LOGIN_PROGRESS, event);
        });
      },
      { withContext: true }
    ),
    cancelLogin: op(
      ASSISTANT_ACCOUNT_METHOD_CHANNELS.cancelLogin,
      async (ctx): Promise<{ cancelled: boolean }> => ({
        // Scoped to the caller: one window must not cancel another's sign-in.
        cancelled: assistantAccountService.cancelLogin(ctx.webContentsId),
      }),
      { withContext: true }
    ),
    logout: op(
      ASSISTANT_ACCOUNT_METHOD_CHANNELS.logout,
      async (): Promise<{ signedOut: boolean; message?: string }> =>
        assistantAccountService.logout()
    ),
  },
});

export function registerAssistantAccountHandlers(): () => void {
  return assistantAccountNamespace.register();
}

/**
 * Sends one payload to a specific view, and to no other.
 *
 * Fails CLOSED: if the owning view is gone the event is dropped rather than delivered
 * somewhere else. Daintree is multi-window and each project has its own renderer, so a
 * fallback would put one person's account state — their email, their plan — on another
 * project's screen. Mirrors AssistantHostService.deliver (lesson #7003).
 */
function deliver(webContentsId: number, channel: string, payload: unknown): void {
  const target = webContents.fromId(webContentsId) ?? undefined;
  if (!target || target.isDestroyed()) return;
  try {
    target.send(channel, payload);
  } catch {
    // Destroyed between the check and the send. Electron throws synchronously here and
    // this runs inside a child-process callback, so letting it escape would surface as an
    // unhandled main-loop error rather than as the owner simply going away.
  }
}
