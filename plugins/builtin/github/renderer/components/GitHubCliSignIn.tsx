import { useEffect, useRef, useState, type ReactNode } from "react";
import { Checkbox, ConfirmDialog, Icon, SettingsRow } from "@daintreehq/plugin-ui";
import { logError } from "@/utils/logger";
import { GITHUB_PLUGIN_ID } from "../../shared/enterprise.js";
import {
  GH_SIGN_IN_CHANNELS,
  type GhAccountObservation,
  type GhAccountStatus,
  type GhSignInFailureReason,
  type GhSignInResult,
} from "../../shared/ghSignIn.js";

function invoke<T>(channel: string, args: unknown): Promise<T> {
  try {
    return window.electron.plugin.invoke(GITHUB_PLUGIN_ID, channel, args) as Promise<T>;
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Only this digest of the token leaves the form after the save itself: the
 * machine signing gh in matches it against the token it saved, so the
 * plaintext isn't held here while the person decides.
 */
async function digestToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A checked save, captured when it was submitted. */
interface GhSignInTicket {
  generation: number;
  host: string;
  tokenDigest: string | null;
}

interface PendingConfirm {
  generation: number;
  host: string;
  tokenDigest: string;
  account: string | null;
  current: Extract<GhAccountObservation, { signedIn: true }>;
}

type Phase = "idle" | "checking" | "confirming" | "signing-in";
type Outcome = { tone: "success" | "warning" | "error"; message: string };

const SAVED = "The token is saved in Daintree, but";

function failureMessage(
  reason: GhSignInFailureReason,
  machine: string,
  missingScopes?: string[]
): string {
  switch (reason) {
    case "cli-not-found":
      return `${SAVED} GitHub CLI (gh) isn't installed on ${machine}.`;
    case "cli-timeout":
      return `${SAVED} GitHub CLI didn't respond.`;
    case "refused":
      return `${SAVED} GitHub CLI refused it.`;
    case "missing-scopes":
      return missingScopes && missingScopes.length > 0
        ? `${SAVED} GitHub CLI refused it: gh needs the ${missingScopes.join(" and ")} ${
            missingScopes.length === 1 ? "scope" : "scopes"
          }.`
        : `${SAVED} GitHub CLI refused it.`;
    case "token-changed":
      return "GitHub CLI wasn't signed in: the saved token changed before it could be. Save the token again to use it for gh.";
    case "cancelled":
      return `${SAVED} GitHub CLI sign-in was cancelled.`;
    case "cli-failed":
    default:
      return `${SAVED} GitHub CLI couldn't be signed in.`;
  }
}

function asAccount(account: string | null): string {
  return account ? ` as @${account}` : "";
}

/**
 * The "also sign in gh" option of one token form. `host` is the GitHub host
 * the form saves a token for; `machine` names the machine whose Settings
 * these are ("this machine", or the attached host's name), where gh runs.
 */
export function useGhCliSignIn(host: string | null, machine: string) {
  // Each piece of state names the host it belongs to: when another window
  // points the form at a different server, what was set for the old one
  // reads as unset rather than carrying over.
  const [checkedFor, setCheckedFor] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Persists, unlike "Checked and saved": a failure says what to do next.
  const [outcome, setOutcome] = useState<(Outcome & { host: string }) | null>(null);
  // Bumped by every new attempt and on unmount, so a late reply from an
  // abandoned attempt changes nothing.
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );

  const checked = host !== null && checkedFor === host;
  const visiblePending = pending && pending.host === host ? pending : null;
  const visibleOutcome = outcome && outcome.host === host ? outcome : null;

  const isCurrent = (attempt: number) => attempt === generation.current;

  const finish = (attempt: number, target: string, next: Outcome) => {
    if (!isCurrent(attempt)) return;
    setPhase("idle");
    setOutcome({ ...next, host: target });
  };

  const commit = async (
    attempt: number,
    target: string,
    tokenDigest: string,
    account: string | null,
    expected: GhAccountObservation,
    retried = false
  ): Promise<void> => {
    setPhase("signing-in");
    let result: GhSignInResult;
    try {
      result = await invoke<GhSignInResult>(GH_SIGN_IN_CHANNELS.signIn, {
        host: target,
        tokenDigest,
        expected,
      });
    } catch (error) {
      logError("Failed to sign in GitHub CLI", error);
      finish(attempt, target, {
        tone: "error",
        message: `${SAVED} GitHub CLI couldn't be signed in.`,
      });
      return;
    }
    if (!isCurrent(attempt)) return;
    if (result.ok) {
      finish(
        attempt,
        target,
        result.gitConfigured
          ? {
              tone: "success",
              message: `GitHub CLI on ${machine} is signed in to ${target}${asAccount(account)}.`,
            }
          : {
              tone: "warning",
              message: `GitHub CLI on ${machine} is signed in to ${target}${asAccount(account)}, but git isn't set up to use it. Run gh auth setup-git --hostname ${target} there.`,
            }
      );
      return;
    }
    if (result.reason === "gh-changed") {
      // Another sign-in landed while this one waited: ask about what gh holds now.
      if (result.current.signedIn) {
        setPending({
          generation: attempt,
          host: target,
          tokenDigest,
          account,
          current: result.current,
        });
        setPhase("confirming");
        return;
      }
      if (!retried) {
        await commit(attempt, target, tokenDigest, account, result.current, true);
        return;
      }
      finish(attempt, target, {
        tone: "error",
        message: `${SAVED} GitHub CLI's sign-in kept changing.`,
      });
      return;
    }
    finish(attempt, target, {
      tone: "error",
      message: failureMessage(result.reason, machine, result.missingScopes),
    });
  };

  return {
    checked,
    busy: phase !== "idle",

    /** Call as the save is submitted; null when the option is off. */
    async capture(token: string): Promise<GhSignInTicket | null> {
      if (!checked || !host) return null;
      const attempt = ++generation.current;
      setPending(null);
      setOutcome(null);
      try {
        return { generation: attempt, host, tokenDigest: await digestToken(token) };
      } catch (error) {
        logError("Failed to prepare the GitHub CLI sign-in", error);
        return { generation: attempt, host, tokenDigest: null };
      }
    },

    /** Call once the save validated. `account` is the token's, when the save named it. */
    async afterSave(ticket: GhSignInTicket | null, account?: string): Promise<void> {
      if (!ticket || !isCurrent(ticket.generation)) return;
      const attempt = ticket.generation;
      const target = ticket.host;
      setCheckedFor(null);
      if (!ticket.tokenDigest) {
        finish(attempt, target, {
          tone: "error",
          message: `${SAVED} GitHub CLI couldn't be signed in.`,
        });
        return;
      }
      setPhase("checking");
      let status: GhAccountStatus;
      try {
        status = await invoke<GhAccountStatus>(GH_SIGN_IN_CHANNELS.status, { host: target });
      } catch (error) {
        logError("Failed to read the GitHub CLI sign-in", error);
        finish(attempt, target, {
          tone: "error",
          message: `${SAVED} GitHub CLI couldn't be signed in.`,
        });
        return;
      }
      if (!isCurrent(attempt)) return;
      if (!status.ok) {
        finish(attempt, target, { tone: "error", message: failureMessage(status.reason, machine) });
        return;
      }
      if (status.signedIn) {
        setPending({
          generation: attempt,
          host: target,
          tokenDigest: ticket.tokenDigest,
          account: account ?? null,
          current: { signedIn: true, account: status.account },
        });
        setPhase("confirming");
        return;
      }
      await commit(attempt, target, ticket.tokenDigest, account ?? null, { signedIn: false });
    },

    /** The token being edited: a result belongs to the save it came from. */
    clearOutcome() {
      if (phase === "idle") setOutcome(null);
    },

    setChecked(next: boolean) {
      setCheckedFor(next ? host : null);
    },

    status: visibleOutcome ? (
      <span role="status" className="mt-1 flex items-start gap-1 select-text">
        <Icon
          name={
            visibleOutcome.tone === "success"
              ? "circle-check"
              : visibleOutcome.tone === "warning"
                ? "alert-triangle"
                : "circle-x"
          }
          className={
            visibleOutcome.tone === "success"
              ? "w-3 h-3 shrink-0 mt-0.5"
              : visibleOutcome.tone === "warning"
                ? "w-3 h-3 shrink-0 mt-0.5 text-status-warning"
                : "w-3 h-3 shrink-0 mt-0.5 text-status-error"
          }
        />
        <span>{visibleOutcome.message}</span>
      </span>
    ) : phase === "checking" || phase === "signing-in" ? (
      <span className="mt-1 block">Signing in GitHub CLI…</span>
    ) : null,

    pending: visiblePending,

    async confirm(): Promise<void> {
      if (!visiblePending || phase !== "confirming" || !isCurrent(visiblePending.generation)) {
        return;
      }
      const { generation: attempt, host: target, tokenDigest, account, current } = visiblePending;
      setPending(null);
      await commit(attempt, target, tokenDigest, account, current);
    },

    cancel() {
      if (!pending) return;
      const { generation: attempt, host: target, current } = pending;
      setPending(null);
      finish(attempt, target, {
        tone: "warning",
        message: current.account
          ? `GitHub CLI wasn't changed; it's still signed in as @${current.account}.`
          : "GitHub CLI wasn't changed.",
      });
    },
  };
}

type GhCliSignIn = ReturnType<typeof useGhCliSignIn>;

/** The option itself, for a token form's group, between the field and its actions. */
export function GhCliSignInRow({
  signIn,
  machine,
  disabled,
}: {
  signIn: GhCliSignIn;
  machine: string;
  disabled: boolean;
}) {
  return (
    <SettingsRow
      label={`Also sign in GitHub CLI (gh) on ${machine}`}
      description={`gh will hold this same token, with the same rights, so anything on ${machine} that uses gh gets them.`}
      disabled={disabled || signIn.busy}
      control={({ labelId, descriptionId, disabled: rowDisabled }) => (
        <Checkbox
          checked={signIn.checked}
          onCheckedChange={signIn.setChecked}
          disabled={rowDisabled}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
        />
      )}
    />
  );
}

/** Asks before gh's existing sign-in for the host is replaced. */
export function GhCliSignInConfirm({ signIn, machine }: { signIn: GhCliSignIn; machine: string }) {
  const pending = signIn.pending;
  const current = pending?.current.account ?? null;
  const incoming = pending?.account ?? null;
  const host = pending?.host ?? "";

  let title: string;
  let description: ReactNode;
  if (current && incoming && current.toLowerCase() === incoming.toLowerCase()) {
    title = `Replace GitHub CLI's token for @${current}?`;
    description = `GitHub CLI on ${machine} is already signed in to ${host} as @${current}. Its token for @${current} is replaced with the one you just saved.`;
  } else if (current) {
    title = `Replace GitHub CLI's sign-in for @${current}?`;
    description = `GitHub CLI on ${machine} is signed in to ${host} as @${current}. Continuing signs it in with the token you just saved${asAccount(incoming)}, which gh then uses for ${host}.`;
  } else {
    title = `Replace GitHub CLI's sign-in for ${host}?`;
    description = `GitHub CLI on ${machine} already has a sign-in for ${host} that it doesn't name. Continuing signs it in with the token you just saved${asAccount(incoming)}, which gh then uses for ${host}.`;
  }

  return (
    <ConfirmDialog
      open={pending !== null}
      onClose={signIn.cancel}
      onConfirm={() => void signIn.confirm()}
      title={title}
      description={description}
      confirmLabel="Sign in GitHub CLI"
      variant="default"
      layer="nested"
    />
  );
}
