import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAssistantAccount } from "@/hooks/useAssistantAccount";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { SettingsSection } from "./SettingsSection";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
import {
  SELECTABLE_ASSISTANT_BACKEND_ENVIRONMENTS,
  assistantBackendEnvironment,
  isSelectableAssistantBackendEnvironment,
  type AssistantBackendEnvironment,
} from "@shared/config/assistantBackend";
import {
  resolveAssistantAccountView,
  type AssistantAccountActionId,
  type AssistantAccountTone,
} from "./assistantAccountView";

/**
 * The Account section of the Daintree Assistant settings.
 *
 * Daintree implements no part of sign-in — the assistant CLI owns the credential and this
 * is a control surface over it. Nothing rendered here can be a token: the IPC that feeds
 * it has no field that could carry one.
 *
 * The state-to-copy mapping lives in `assistantAccountView.ts` so the rules can be tested
 * without a DOM; this file is the rendering and the wiring.
 */

/** Past this, a wait has to say it is still going rather than just sitting there. */
const STILL_WORKING_MS = 5_000;

const TONE_DOT: Record<AssistantAccountTone, string> = {
  neutral: "bg-daintree-text/30",
  success: "bg-status-success",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
};

const ACTION_LABEL: Record<AssistantAccountActionId, string> = {
  signIn: "Sign in",
  cancelSignIn: "Cancel",
  signOut: "Sign out",
  manageAccount: "Manage account",
  viewPlans: "View plans",
  retry: "Retry",
};

export interface AssistantAccountSectionProps {
  /**
   * The environment that is actually STORED.
   *
   * Load-bearing: the account is re-read whenever this changes, and that read runs
   * against whatever main has on disk. A value that has not landed yet would send the
   * first `auth status` after a switch to the environment the user just left.
   */
  backendEnvironment: AssistantBackendEnvironment;
  /**
   * A choice being written, shown in the picker until it lands.
   *
   * Separate from `backendEnvironment` on purpose. The control has to respond to the
   * click immediately or it reads as broken, but responding is not the same as being
   * saved — so the picker follows this while the write is in flight, and the reload
   * follows the stored value. When the write fails this goes back to null and the
   * picker snaps to what is really in force.
   */
  pendingBackendEnvironment?: AssistantBackendEnvironment | null;
  /** Persists a new choice. */
  onBackendEnvironmentChange: (value: AssistantBackendEnvironment) => void;
  /** True while settings are still loading, so the picker does not flash a wrong value. */
  settingsLoading?: boolean;
}

/**
 * The picker's options — the SELECTABLE environments, not every environment that
 * resolves. A legacy id still reads out of settings and still resolves to its endpoint;
 * it is canonicalised to a live one before it ever reaches this component, so there is
 * nothing here for it to fail to match.
 */
const ENVIRONMENT_OPTIONS: SettingsSelectOption[] = SELECTABLE_ASSISTANT_BACKEND_ENVIRONMENTS.map(
  (env) => ({
    value: env.id,
    label: env.label,
    description: env.description,
  })
);

export function AssistantAccountSection({
  backendEnvironment,
  pendingBackendEnvironment = null,
  onBackendEnvironmentChange,
  settingsLoading = false,
}: AssistantAccountSectionProps) {
  const account = useAssistantAccount();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  /** What the picker shows: the in-flight choice if there is one, else what is stored. */
  const shownEnvironment = pendingBackendEnvironment ?? backendEnvironment;

  /**
   * Re-read the account whenever the environment changes.
   *
   * A credential belongs to ONE backend. Without this the section keeps showing the
   * account from the environment you just left — so switching to Staging while signed
   * in to Production reads as "already signed in", and the first turn is the thing that
   * discovers otherwise.
   *
   * `reload` is the same call the section makes on mount, so this is a re-read rather
   * than a new code path.
   */
  const { reload } = account;
  /** The environment the last read was made against, so a CHANGE can be told from a mount. */
  const readAgainst = useRef<AssistantBackendEnvironment | null>(null);
  useEffect(() => {
    const changed = readAgainst.current !== null && readAgainst.current !== backendEnvironment;
    readAgainst.current = backendEnvironment;
    // `restart` only when the environment actually MOVED. Reads are coalesced, and an
    // in-flight one is bound to the endpoint its process was spawned against — so after
    // a switch, joining it would answer this question with a status about the
    // environment we just left, which is the wrong answer wearing the right one's
    // clothes. On the first run there is nothing to be stale about, and forcing a
    // second read there would spawn a redundant `auth status` on every mount.
    //
    // The hook surfaces its own errors into `account.lastError`, so there is nothing
    // useful to do with a rejection here beyond not dropping it on the floor.
    safeFireAndForget(Promise.resolve(reload(changed ? { restart: true } : undefined)));
  }, [backendEnvironment, reload]);

  const changeEnvironment = useCallback(
    (value: string) => {
      if (!isSelectableAssistantBackendEnvironment(value)) return;
      if (value === shownEnvironment) return;
      onBackendEnvironmentChange(value);
    },
    [shownEnvironment, onBackendEnvironmentChange]
  );

  /**
   * Two different waits, with different treatments.
   *
   * The FIRST read has no content to show, so it gets a skeleton — the shape is
   * predictable (a status line and a subtitle), and `animate-pulse-delayed` carries the
   * 400ms gate in CSS, so a read that beats the threshold never flashes anything.
   *
   * A LATER read already has an answer on screen, so it keeps it rather than collapsing
   * back to a placeholder. Only if that revalidation drags does the panel say so — an
   * explicit refresh is allowed a long time, and silence over a 150s wait reads as a
   * button that did nothing.
   */
  const initialLoad = !account.loaded;
  const revalidating = account.loaded && account.loading;
  const stillWorking = useDeferredLoading(initialLoad || revalidating, STILL_WORKING_MS);

  const view = useMemo(
    () =>
      resolveAssistantAccountView(account.result, {
        loaded: account.loaded,
        loginInProgress: account.loginInProgress,
        accountsUnavailable: account.accountsUnavailable,
      }),
    [account.result, account.loaded, account.loginInProgress, account.accountsUnavailable]
  );

  const run = useCallback(
    (action: AssistantAccountActionId) => {
      switch (action) {
        case "signIn":
          return safeFireAndForget(account.login());
        case "cancelSignIn":
          return safeFireAndForget(account.cancelLogin());
        case "signOut":
          // Local-irreversible (D1): it destroys the credential on this machine, and
          // getting back means a full browser sign-in rather than a one-click inverse.
          // It sits next to "Manage account", so it asks first. No typed-name gate —
          // nothing server-side is revoked; that is the website's "Disconnect".
          setConfirmSignOut(true);
          return;
        case "manageAccount":
          return safeFireAndForget(account.openAccount());
        case "viewPlans":
          return safeFireAndForget(account.openSubscribe());
        case "retry":
          // An explicit Retry is the one place a user has asked for a live answer, so it
          // re-verifies rather than re-reading what is already on disk.
          return safeFireAndForget(account.reload({ refresh: true }));
      }
    },
    [account]
  );

  const links = account.result?.available ? account.result.status.links : undefined;
  const environment = account.result?.available ? account.result.status.environment : undefined;

  return (
    <SettingsSection
      icon={UserRound}
      title="Account"
      description={
        // The section's own subtitle has to agree with the state below it. Left as-is it
        // told someone to sign in immediately above a line explaining there is nothing
        // to sign in to.
        account.accountsUnavailable
          ? "This backend serves the assistant without accounts, so there's nothing to sign in to."
          : "Sign in to use the Daintree Assistant. The assistant CLI holds the credential — Daintree never sees it."
      }
      {...(environment && environment !== "production" ? { badge: environment } : {})}
    >
      {/* ABOVE the account status, because it changes what that status means: the
          credential belongs to one backend, so "signed in" is only an answer once you
          know which. */}
      <SettingsSelect
        label="Environment"
        description={
          assistantBackendEnvironment(shownEnvironment).remote
            ? `Sign-in and every turn go to ${assistantBackendEnvironment(shownEnvironment).url}. Sessions already running keep the environment they started in.`
            : `${assistantBackendEnvironment(shownEnvironment).description} Sessions already running keep the environment they started in.`
        }
        value={shownEnvironment}
        onValueChange={changeEnvironment}
        options={ENVIRONMENT_OPTIONS}
        // Locked while the choice is being written, so a second click cannot start a
        // competing write whose answer arrives out of order.
        disabled={settingsLoading || account.loginInProgress || pendingBackendEnvironment !== null}
      />

      <div className="space-y-2">
        {initialLoad ? (
          <Skeleton label="Checking your Daintree account" className="space-y-1.5">
            <SkeletonText lines={1} className="w-48" />
            <SkeletonText lines={1} className="w-64" />
          </Skeleton>
        ) : (
          <div className="flex items-start gap-2" role="status" aria-live="polite">
            <div
              className={cn("w-2 h-2 rounded-full shrink-0 mt-1", TONE_DOT[view.tone])}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-xs text-daintree-text select-text break-words">{view.headline}</p>
              {view.detail && (
                <p className="text-xs text-daintree-text/60 leading-relaxed select-text mt-0.5">
                  {view.detail}
                </p>
              )}
            </div>
          </div>
        )}

        {stillWorking && (
          <p className="text-xs text-daintree-text/50" role="status" aria-live="polite">
            Still working…
          </p>
        )}

        {account.awaitingCheckout && (
          <p className="text-xs text-daintree-text/50 leading-relaxed select-text">
            Waiting for your purchase to come through. This updates on its own — or use Retry.
          </p>
        )}

        {account.lastError && (
          <InlineStatusBanner
            severity="error"
            icon={AlertCircle}
            title="Account action failed"
            description={account.lastError}
            onClose={account.dismissError}
            action={{
              id: "retry",
              label: "Retry",
              onClick: () => run("retry"),
            }}
          />
        )}

        {view.actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {view.actions.map((action) => (
              <Button
                key={action}
                type="button"
                variant="subtle"
                size="sm"
                onClick={() => run(action)}
                disabled={account.loading && action === "retry"}
              >
                {ACTION_LABEL[action]}
              </Button>
            ))}
          </div>
        )}

        {links?.account && view.presentsSignedIn && (
          <p className="text-xs text-daintree-text/50 leading-relaxed select-text">
            Signing out here removes the login from this machine only. To disconnect every device,
            use Authorized apps on your account page.
          </p>
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmSignOut}
        onClose={() => setConfirmSignOut(false)}
        variant="destructive"
        title="Sign out of the Daintree Assistant?"
        /*
         * Says only what is actually guaranteed.
         *
         * It used to promise that open sessions stop and their conversations are
         * discarded — `auth logout` does neither. The obvious correction, "a running
         * session keeps going until its next turn", is no better: the engine re-checks
         * the credential before every backend round, one turn can be several rounds, and
         * the supervisor is notified immediately and can cancel unattended work. The
         * timing is genuinely not ours to promise. What IS certain is that the
         * credential goes from this machine and that nothing is deleted.
         */
        description="This removes the assistant login from this machine. Conversations aren't deleted, and your other devices stay signed in."
        confirmLabel="Sign out of Daintree"
        onConfirm={() => {
          setConfirmSignOut(false);
          safeFireAndForget(account.logout());
        }}
      />
    </SettingsSection>
  );
}
