import { useLayoutEffect, useRef, useState } from "react";
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
  const [checked, setChecked] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Persists, unlike "Checked and saved": a failure says what to do next.
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Bumped by every save, Clear and Import, a server change and unmount, so a
  // late reply from an abandoned attempt changes nothing.
  const generation = useRef({ value: 0 });

  // Another window pointed the form at a different server: nothing set for
  // the old one carries over.
  const [ownerHost, setOwnerHost] = useState(host);
  if (ownerHost !== host) {
    setOwnerHost(host);
    setChecked(false);
    setPhase("idle");
    setPending(null);
    setOutcome(null);
  }
  // At commit, before a reply for the old server can land.
  useLayoutEffect(() => {
    const counter = generation.current;
    counter.value++;
    return () => {
      counter.value++;
    };
  }, [host]);

  const isCurrent = (attempt: number) => attempt === generation.current.value;

  const supersede = () => {
    generation.current.value++;
    setPhase("idle");
    setPending(null);
    setOutcome(null);
  };

  const finish = (attempt: number, next: Outcome) => {
    if (!isCurrent(attempt)) return;
    setPhase("idle");
    setOutcome(next);
  };

  const ask = (attempt: number, next: PendingConfirm) => {
    if (!isCurrent(attempt)) return;
    setPending(next);
    setPhase("confirming");
  };

  const commit = async (
    attempt: number,
    target: string,
    tokenDigest: string,
    account: string | null,
    expected: GhAccountObservation,
    retried = false
  ): Promise<void> => {
    if (!isCurrent(attempt)) return;
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
      finish(attempt, { tone: "error", message: `${SAVED} GitHub CLI couldn't be signed in.` });
      return;
    }
    if (!isCurrent(attempt)) return;
    if (result.ok) {
      const who = asAccount(account) || " with the saved token";
      finish(
        attempt,
        result.gitConfigured
          ? {
              tone: "success",
              message: `GitHub CLI on ${machine} is signed in to ${target}${who}.`,
            }
          : {
              tone: "warning",
              message: `GitHub CLI on ${machine} is signed in to ${target}${who}, but git isn't set up to use it. Run gh auth setup-git --hostname ${target} there.`,
            }
      );
      return;
    }
    if (result.reason === "gh-changed") {
      // Another sign-in landed while this one waited: ask about what gh holds now.
      if (result.current.signedIn) {
        ask(attempt, {
          generation: attempt,
          host: target,
          tokenDigest,
          account,
          current: result.current,
        });
        return;
      }
      if (!retried) {
        await commit(attempt, target, tokenDigest, account, result.current, true);
        return;
      }
      finish(attempt, { tone: "error", message: `${SAVED} GitHub CLI's sign-in kept changing.` });
      return;
    }
    finish(attempt, {
      tone: "error",
      message: failureMessage(result.reason, machine, result.missingScopes),
    });
  };

  return {
    checked,
    busy: phase !== "idle",

    /**
     * Call as any save is submitted, ticked or not: a new save supersedes
     * whatever an earlier one started. Null when the option is off.
     */
    async capture(token: string): Promise<GhSignInTicket | null> {
      supersede();
      if (!checked || !host) return null;
      const attempt = generation.current.value;
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
      const tokenDigest = ticket.tokenDigest;
      setChecked(false);
      if (!tokenDigest) {
        finish(attempt, { tone: "error", message: `${SAVED} GitHub CLI couldn't be signed in.` });
        return;
      }
      setPhase("checking");
      let status: GhAccountStatus;
      try {
        status = await invoke<GhAccountStatus>(GH_SIGN_IN_CHANNELS.status, { host: target });
      } catch (error) {
        logError("Failed to read the GitHub CLI sign-in", error);
        finish(attempt, { tone: "error", message: `${SAVED} GitHub CLI couldn't be signed in.` });
        return;
      }
      if (!isCurrent(attempt)) return;
      if (!status.ok) {
        finish(attempt, { tone: "error", message: failureMessage(status.reason, machine) });
        return;
      }
      if (status.signedIn) {
        ask(attempt, {
          generation: attempt,
          host: target,
          tokenDigest,
          account: account ?? null,
          current: { signedIn: true, account: status.account, accounts: status.accounts },
        });
        return;
      }
      await commit(attempt, target, tokenDigest, account ?? null, { signedIn: false });
    },

    /** The credential changed another way (Clear, Import): drop what an earlier save started. */
    supersede,

    /** The token being edited: a finished result belongs to the save it came from. */
    clearOutcome() {
      if (phase === "idle") setOutcome(null);
    },

    setChecked,

    status: outcome ? (
      <span className="mt-1 flex items-start gap-1 select-text">
        <Icon
          name={
            outcome.tone === "success"
              ? "circle-check"
              : outcome.tone === "warning"
                ? "alert-triangle"
                : "circle-x"
          }
          className={
            outcome.tone === "success"
              ? "w-3 h-3 shrink-0 mt-0.5"
              : outcome.tone === "warning"
                ? "w-3 h-3 shrink-0 mt-0.5 text-status-warning"
                : "w-3 h-3 shrink-0 mt-0.5 text-status-error"
          }
        />
        <span>{outcome.message}</span>
      </span>
    ) : phase === "checking" || phase === "signing-in" ? (
      <span className="mt-1 block">Signing in GitHub CLI…</span>
    ) : null,

    pending,

    async confirm(): Promise<void> {
      if (!pending || phase !== "confirming" || !isCurrent(pending.generation)) return;
      const { generation: attempt, host: target, tokenDigest, account, current } = pending;
      setPending(null);
      await commit(attempt, target, tokenDigest, account, current);
    },

    cancel() {
      if (!pending) return;
      const attempt = pending.generation;
      setPending(null);
      // Only what Cancel establishes: gh may have changed elsewhere meanwhile.
      finish(attempt, { tone: "warning", message: "GitHub CLI wasn't changed." });
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
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  let title: string;
  let description: string;
  if (current && incoming && same(current, incoming)) {
    title = `Replace GitHub CLI's token for @${current}?`;
    description = `GitHub CLI on ${machine} is already signed in to ${host} as @${current}. Its token for @${current} is replaced with the one you just saved.`;
  } else {
    title = current
      ? `Replace GitHub CLI's sign-in for @${current}?`
      : `Replace GitHub CLI's sign-in for ${host}?`;
    description = `${
      current
        ? `GitHub CLI on ${machine} is signed in to ${host} as @${current}.`
        : `GitHub CLI on ${machine} already has a sign-in for ${host} that it doesn't name.`
    } Continuing signs it in with the token you just saved${asAccount(incoming)}, which gh then uses for ${host}.`;
    const heldInactive =
      incoming !== null && (pending?.current.accounts ?? []).some((login) => same(login, incoming));
    if (heldInactive) {
      description += ` gh also holds an older token for @${incoming}, which this replaces.`;
    } else if (incoming === null) {
      description += " Daintree couldn't tell which account that token belongs to.";
    }
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
