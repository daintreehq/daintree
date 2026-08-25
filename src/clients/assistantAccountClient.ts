import type {
  AssistantAccountLoginProgress,
  AssistantAccountLoginResult,
  AssistantAccountStatusOptions,
  AssistantAccountStatusResult,
} from "@shared/types/ipc/assistantAccount";

/**
 * The renderer's view of the Daintree Assistant account.
 *
 * Daintree implements no part of sign-in — the assistant CLI owns the credential, the
 * main process drives it, and this is the thin seam the UI talks through. Nothing here
 * can return a token: the underlying IPC has no field that could carry one.
 *
 * @example
 * ```typescript
 * import { assistantAccountClient } from "@/clients/assistantAccountClient";
 *
 * const result = await assistantAccountClient.getStatus();
 * if (result.available && result.status.state === "signed_in_active") {
 *   // ...
 * }
 * ```
 */
export const assistantAccountClient = {
  /**
   * Reads the account state.
   *
   * The default is the cheap local read. Pass `{ refresh: true }` only when the cached
   * answer is known to be stale — after a checkout, or behind an explicit Retry — since
   * it costs a backend round trip.
   */
  getStatus: (options?: AssistantAccountStatusOptions): Promise<AssistantAccountStatusResult> => {
    return window.electron.assistantAccount.getStatus(options);
  },

  /**
   * Starts an interactive sign-in and resolves when it settles.
   *
   * One at a time across the whole app: the CLI binds a single fixed callback port, so a
   * second concurrent attempt would leave one browser tab that can never complete. A
   * caller that loses that race gets `login_in_progress` rather than a competing flow.
   */
  login: (): Promise<AssistantAccountLoginResult> => {
    return window.electron.assistantAccount.login();
  },

  /** Cancels a sign-in THIS window started. */
  cancelLogin: (): Promise<{ cancelled: boolean }> => {
    return window.electron.assistantAccount.cancelLogin();
  },

  /** Signs out on this machine. */
  logout: (): Promise<{ signedOut: boolean; message?: string }> => {
    return window.electron.assistantAccount.logout();
  },

  /**
   * Subscribes to progress from an in-flight sign-in.
   *
   * Events are a targeted send to this view only — an account is personal, and another
   * project's window has no business seeing whose it is.
   */
  onLoginProgress: (callback: (event: AssistantAccountLoginProgress) => void): (() => void) => {
    return window.electron.assistantAccount.onLoginProgress(callback);
  },
} as const;
