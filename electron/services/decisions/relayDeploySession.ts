import { randomUUID } from "node:crypto";
import type {
  ClaimDecisionsRelayPayload,
  ClaimDeployedDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsRelayDeploy,
  PreparedDecisionsRelayDeploy,
} from "../../../shared/types/decisions.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  openRelayDeployHost,
  type RelayDeployHost,
  type RelayDeployHostEvents,
  type RelayDeployHostOptions,
  type RelayDeployInterruption,
  type RelayDeployResult,
} from "./relayDeployHost.js";
import type { RelayDeployPrefill } from "./relayDeployPrefill.js";

const INTERRUPTION_ERROR: Record<RelayDeployInterruption, string> = {
  "not-started": "The deploy terminal didn't start the CLI in time",
  handshake: "The CLI that started didn't speak the guided deploy's channel",
  protocol: "The CLI sent Daintree something it couldn't read",
  closed: "The deploy stopped before the CLI said how it went",
};

interface Run {
  id: string;
  host: RelayDeployHost | null;
  snapshot: DecisionsRelayDeploy;
  /** Held in memory only, for this session, until the relay is claimed or the run is dropped. */
  claimSecret: string | null;
}

type OpenHost = (
  events: RelayDeployHostEvents,
  options?: RelayDeployHostOptions
) => Promise<RelayDeployHost>;

function snapshotOf(id: string, result: RelayDeployResult): DecisionsRelayDeploy {
  return {
    id,
    state: result.status,
    ...(result.url !== null ? { url: result.url } : {}),
    claimState: result.claimState,
    ...(result.claimSecret !== null ? { holdsClaimSecret: true as const } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/**
 * The guided relay deploy Settings started (#16199): one at a time, its
 * channel to the CLI, and what the CLI reported, the claim secret included,
 * kept in memory until the relay is claimed, another deploy starts, Decisions
 * turns off or Daintree quits. Nothing here is written anywhere. A deploy
 * whose CLI hasn't connected yet is replaced by a new one; one whose CLI is
 * asking its questions is not, since its relay may be about to exist.
 */
export class RelayDeploySessions {
  private run: Run | null = null;
  private closed = false;

  constructor(
    private readonly deps: {
      onChange: () => void;
      open?: OpenHost;
      hostOptions?: RelayDeployHostOptions;
    }
  ) {}

  snapshot(): DecisionsRelayDeploy | undefined {
    return this.run ? { ...this.run.snapshot } : undefined;
  }

  async prepare(readPrefill: () => RelayDeployPrefill): Promise<PreparedDecisionsRelayDeploy> {
    if (this.closed) {
      throw new AppError({ code: "CANCELLED", message: "Decisions has stopped" });
    }
    if (this.run?.snapshot.state === "running") {
      throw new AppError({
        code: "CANCELLED",
        message:
          "A guided deploy is already running. Finish it in its terminal, or close that terminal, first",
      });
    }
    this.drop();
    const id = randomUUID();
    const run: Run = { id, host: null, snapshot: { id, state: "waiting" }, claimSecret: null };
    this.run = run;
    const current = () => this.run === run;
    const open = this.deps.open ?? openRelayDeployHost;
    let host: RelayDeployHost;
    try {
      host = await open(
        {
          readPrefill,
          onRunning: () => {
            if (!current()) return;
            run.snapshot = { id, state: "running" };
            this.deps.onChange();
          },
          onResult: (result) => {
            if (!current()) return;
            run.claimSecret = result.claimSecret;
            run.snapshot = snapshotOf(id, result);
            this.deps.onChange();
          },
          onInterrupted: (reason) => {
            if (!current()) return;
            run.host = null;
            run.snapshot = { id, state: "interrupted", error: INTERRUPTION_ERROR[reason] };
            this.deps.onChange();
          },
        },
        this.deps.hostOptions
      );
    } catch {
      if (current()) this.run = null;
      throw new AppError({
        code: "UNSUPPORTED",
        message: "Daintree couldn't open the channel the guided deploy talks to",
      });
    }
    if (!current()) {
      host.dispose();
      throw new AppError({ code: "CANCELLED", message: "The guided deploy was replaced" });
    }
    run.host = host;
    this.deps.onChange();
    return { id, hostChannel: host.channelPath };
  }

  /** Drops a deploy whose CLI never connected, such as one whose pane didn't open. */
  cancel(id: string): void {
    if (this.run?.id !== id || this.run.snapshot.state !== "waiting") return;
    this.drop();
    this.deps.onChange();
  }

  /** The relay and secret to claim it with, while this deploy still holds them. */
  claimable(id: string): { url: string; claimSecret: string } | null {
    const run = this.run;
    if (run?.id !== id || run.claimSecret === null || run.snapshot.url === undefined) return null;
    return { url: run.snapshot.url, claimSecret: run.claimSecret };
  }

  /**
   * Claims the relay this deploy reported, with the secret it holds, through
   * `claimRelay`. The secret is dropped once a claim saves an identity, and
   * kept through anything else, so a refusal can be tried again this session.
   */
  async claim(
    payload: ClaimDeployedDecisionsRelayPayload,
    claimRelay: (claim: ClaimDecisionsRelayPayload) => Promise<DecisionsConnectResult>
  ): Promise<DecisionsConnectResult> {
    const held = this.claimable(payload.deployId);
    if (held === null) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "Daintree no longer holds the claim secret from that deploy",
      });
    }
    const outcome = await claimRelay({
      url: held.url,
      claimSecret: held.claimSecret,
      ...(payload.acceptWeakStorage === true ? { acceptWeakStorage: true } : {}),
    });
    if (outcome.result === "saved" && this.run?.id === payload.deployId) {
      this.drop();
      this.deps.onChange();
    }
    return outcome;
  }

  /** Decisions turned off: the channel closes and the secret goes, but new deploys may follow. */
  reset(): void {
    const had = this.run !== null;
    this.drop();
    if (had) this.deps.onChange();
  }

  /** Quit: as `reset`, and nothing starts again. */
  dispose(): void {
    this.closed = true;
    this.drop();
  }

  private drop(): void {
    this.run?.host?.dispose();
    this.run = null;
  }
}
