import type { DecisionsRelayDeploy } from "@shared/types/decisions";

export interface RelayDeployDescription {
  label: string;
  detail: string;
  severity?: "warning" | "error";
  /** The relay to check and claim, when the deploy reported one. */
  url?: string;
}

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

/**
 * The guided deploy, as its CLI reported it (#16199). Only what was observed:
 * a URL is offered for checking whatever the outcome, since a deploy that
 * stopped late may still have created the Worker.
 */
export function describeRelayDeploy(deploy: DecisionsRelayDeploy): RelayDeployDescription {
  const url = deploy.url !== undefined ? { url: deploy.url } : {};
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
      return deploy.url !== undefined
        ? { label: "Relay deployed", detail: `${deploy.url}. ${claimNote(deploy)}`, ...url }
        : { label: "Deploy finished", detail: "The CLI reported no Worker URL." };
    case "cancelled":
      return deploy.url !== undefined
        ? {
            label: "Deploy cancelled",
            detail: `It stopped after creating ${deploy.url}. ${claimNote(deploy)}`,
            severity: "warning",
            ...url,
          }
        : {
            label: "Deploy cancelled",
            detail: "It stopped before creating the Worker.",
          };
    case "failed": {
      const reason = sentence(deploy.error ?? "The CLI gave no reason");
      return deploy.url !== undefined
        ? {
            label: "Deploy failed",
            detail: `${reason} It had created ${deploy.url}. ${claimNote(deploy)}`,
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

/** Whether `checkedUrl` is the relay the deploy reported, so its held secret may claim it. */
export function isDeployedRelay(deploy: DecisionsRelayDeploy | undefined, checkedUrl: string) {
  if (!deploy?.holdsClaimSecret || deploy.url === undefined) return false;
  try {
    return new URL(deploy.url).origin === new URL(checkedUrl.trim()).origin;
  } catch {
    return false;
  }
}
