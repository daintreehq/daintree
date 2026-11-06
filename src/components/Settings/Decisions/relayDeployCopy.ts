import type { DecisionsRelayDeploy, DecisionsRelayDeployClaim } from "@shared/types/decisions";
import { hostOf } from "./relayCheckCopy";
import { describeConnectResult } from "./relayIdentityCopy";

/**
 * What the outcome row offers next: checking a relay the deploy left
 * unclaimed, finishing a claim main started with the secret it still holds
 * (with weaker key storage, when that is all there was), or pairing a phone
 * once the relay is this computer's.
 */
export type RelayDeployNext = "use" | "finish-claim" | "accept-weak" | "pair";

export interface RelayDeployDescription {
  label: string;
  detail: string;
  severity?: "warning" | "error";
  /** The relay to check and claim, when the deploy reported one and nothing claimed it here. */
  url?: string;
  next?: RelayDeployNext;
}

/** What agents get once the relay is claimed, true of launches only (#16012). */
export const AGENTS_AFTER_CLAIM =
  "Supported agents launched from now on get ask_human. Agents already running get it at their next launch.";

/** A reason from the CLI or main as one sentence, however it ended. */
function sentence(text: string): string {
  return `${text.trim().replace(/[.\s]+$/, "")}.`;
}

/** What the claim secret's whereabouts mean for claiming the relay. */
function claimNote(deploy: DecisionsRelayDeploy): string {
  if (deploy.holdsClaimSecret) {
    return "Daintree holds its claim secret until you claim it here or quit, and the terminal never shows it.";
  }
  if (deploy.claimState === "claimed") {
    return "It was already claimed, so the deploy set no claim secret: restore its owner's identity from a recovery kit.";
  }
  return "Daintree received no claim secret for it.";
}

/** Main's claim of a completed deploy's relay (#16200), from start to end. */
function describeClaim(
  deploy: DecisionsRelayDeploy,
  url: string,
  claim: DecisionsRelayDeployClaim
): RelayDeployDescription {
  const host = hostOf(url);
  switch (claim.state) {
    case "claiming":
      return {
        label: "Claiming the deployed relay",
        detail: `Daintree is checking ${host} and claiming it with this computer's Decisions identity.`,
      };
    case "claimed":
      return {
        label: "Relay deployed and claimed",
        detail: `${hostOf(claim.origin)} is this computer's relay now. ${AGENTS_AFTER_CLAIM} Pair a phone to answer their questions.`,
        next: "pair",
      };
    case "failed": {
      const { failure } = claim;
      const observed =
        failure.result === "error"
          ? {
              severity: "error" as const,
              label: "Couldn't claim the deployed relay",
              detail: sentence(failure.message),
            }
          : describeConnectResult(failure);
      const label = observed?.label ?? "Couldn't claim the deployed relay";
      const severity = observed?.severity === "error" ? "error" : "warning";
      const reason = observed ? `${observed.detail} ` : "";
      if (!deploy.holdsClaimSecret) {
        return { label, detail: `${reason}${claimNote(deploy)}`, severity, url, next: "use" };
      }
      const weak = failure.result === "key-storage" && failure.kind === "weak-storage-unconfirmed";
      return {
        label,
        detail: weak
          ? `${reason}A fixed key keeps the keys only from someone who can't read this computer's files. Daintree holds the deploy's claim secret in memory until you quit, so the claim can finish with it.`
          : `${reason}Daintree holds the deploy's claim secret in memory until you quit, so the claim can be finished with it.`,
        severity,
        next: weak ? "accept-weak" : "finish-claim",
      };
    }
  }
}

/**
 * The guided deploy, as its CLI reported it (#16199), and main's claim of the
 * relay it completed (#16200). Only what was observed: a URL nothing claimed
 * here is offered for checking whatever the outcome, since a deploy that
 * stopped late may still have created the Worker.
 */
export function describeRelayDeploy(deploy: DecisionsRelayDeploy): RelayDeployDescription {
  const url = deploy.url !== undefined ? { url: deploy.url, next: "use" as const } : {};
  // A claim of the deployed relay is the latest thing that happened to it,
  // whether main started it or the person did for a deploy that stopped late.
  if (deploy.claim && deploy.url !== undefined)
    return describeClaim(deploy, deploy.url, deploy.claim);
  switch (deploy.state) {
    case "waiting":
      return {
        label: "Starting the guided deploy",
        detail:
          "Waiting for its terminal to start the CLI, which npx may download first. Starting another deploy replaces this one.",
      };
    case "running":
      return {
        label: "The guided deploy is running",
        detail:
          "Answer its questions in its terminal. Nothing is created in Cloudflare until you confirm the summary there.",
      };
    case "completed":
      if (deploy.url === undefined) {
        return { label: "Deploy finished", detail: "The CLI reported no Worker URL." };
      }
      return { label: "Relay deployed", detail: `${deploy.url}. ${claimNote(deploy)}`, ...url };
    case "cancelled": {
      // Connection stays as it was: nothing is claimed for a deploy that didn't finish.
      const reason = deploy.error !== undefined ? `${sentence(deploy.error)} ` : "";
      return deploy.url !== undefined
        ? {
            label: "Deploy cancelled",
            detail: `${reason}It stopped after creating ${deploy.url}, so Daintree didn't claim it. ${claimNote(deploy)}`,
            severity: "warning",
            ...url,
          }
        : {
            label: "Deploy cancelled",
            detail: `${reason}It stopped before creating the Worker.`,
          };
    }
    case "failed": {
      const reason = sentence(deploy.error ?? "The CLI gave no reason");
      return deploy.url !== undefined
        ? {
            label: "Deploy failed",
            detail: `${reason} It had created ${deploy.url}, so Daintree didn't claim it. ${claimNote(deploy)}`,
            severity: "error",
            ...url,
          }
        : { label: "Deploy failed", detail: reason, severity: "error" };
    }
    case "interrupted":
      return {
        label: "The guided deploy stopped without a result",
        detail: `${sentence(deploy.error ?? "The channel to its CLI closed")} If it got as far as creating a Worker, check that relay before deploying again: a deploy to a relay nobody has claimed sets a new claim secret.`,
        severity: "warning",
      };
  }
}

/**
 * Whether a check found the relay the deploy reported, so its held secret may
 * claim it. `checkedOrigin` is the origin main checked, already normalized
 * from whatever was typed (a bare host included).
 */
export function isDeployedRelay(
  deploy: DecisionsRelayDeploy | undefined,
  checkedOrigin: string
): boolean {
  if (!deploy?.holdsClaimSecret || deploy.url === undefined) return false;
  try {
    return new URL(deploy.url).origin === new URL(checkedOrigin).origin;
  } catch {
    return false;
  }
}
