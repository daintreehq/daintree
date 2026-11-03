import { randomUUID } from "node:crypto";
import type {
  ClaimDecisionsRelayPayload,
  ClaimDeployedDecisionsRelayPayload,
  DecisionsConnectResult,
  DecisionsRelayDeploy,
  DecisionsRelayDeployClaimFailure,
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
  /** The claim in flight with that secret, which a retry joins rather than repeats. */
  claiming: Promise<DecisionsConnectResult> | null;
}

type ClaimRelay = (claim: ClaimDecisionsRelayPayload) => Promise<DecisionsConnectResult>;

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

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Main's own refusals say what happened; anything else could say anything, so it isn't shown. */
function claimError(error: unknown): DecisionsRelayDeployClaimFailure {
  return {
    result: "error",
    message:
      error instanceof AppError
        ? error.message
        : "The claim stopped before Daintree heard how it went",
  };
}

function withoutSecret(snapshot: DecisionsRelayDeploy): DecisionsRelayDeploy {
  const next = { ...snapshot };
  delete next.holdsClaimSecret;
  return next;
}

/**
 * The guided relay deploy Settings started (#16199): one at a time, its
 * channel to the CLI, and what the CLI reported, the claim secret included,
 * kept in memory until the relay is claimed, another deploy starts, Decisions
 * turns off or Daintree quits. Nothing here is written anywhere. A deploy
 * whose CLI hasn't connected yet is replaced by a new one; one whose CLI is
 * asking its questions is not, since its relay may be about to exist, and
 * neither is one whose relay is being claimed.
 *
 * A deploy that completes is claimed here at once, with this computer's own
 * identity (#16200), whether or not Settings is open: the outcome stays on the
 * snapshot for Settings to show whenever it next looks. A cancelled or failed
 * deploy is never claimed by itself, so Connection stays as it was.
 */
export class RelayDeploySessions {
  private run: Run | null = null;
  private closed = false;

  constructor(
    private readonly deps: {
      onChange: () => void;
      /** The setup path's claim, which checks the relay first and records the identity it saves. */
      claimRelay: ClaimRelay;
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
    if (this.run?.claiming) {
      throw new AppError({
        code: "CANCELLED",
        message:
          "Daintree is still claiming the relay the last deploy created. Try again once it has",
      });
    }
    this.drop();
    const id = randomUUID();
    const run: Run = {
      id,
      host: null,
      snapshot: { id, state: "waiting" },
      claimSecret: null,
      claiming: null,
    };
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
            if (result.status === "completed" && this.claimable(id) !== null) {
              // Settled whatever happens: the outcome goes on the snapshot, not to a caller.
              this.startClaim(run, false).catch(() => {});
            } else {
              this.deps.onChange();
            }
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
   * Claims the relay this deploy reported with the secret it holds: a retry
   * of a claim that didn't save, joining one still in flight. The secret is
   * dropped once a claim saves an identity, and kept through anything else,
   * so a refusal can be tried again this session.
   */
  claim(payload: ClaimDeployedDecisionsRelayPayload): Promise<DecisionsConnectResult> {
    const run = this.run;
    if (run?.id === payload.deployId && run.claiming) return run.claiming;
    if (run === null || this.claimable(payload.deployId) === null) {
      return Promise.reject(
        new AppError({
          code: "NOT_FOUND",
          message: "Daintree no longer holds the claim secret from that deploy",
        })
      );
    }
    return this.startClaim(run, payload.acceptWeakStorage === true);
  }

  private startClaim(run: Run, acceptWeakStorage: boolean): Promise<DecisionsConnectResult> {
    const held = this.claimable(run.id);
    if (held === null) {
      return Promise.reject(new AppError({ code: "NOT_FOUND", message: "Nothing to claim with" }));
    }
    const current = () => this.run === run;
    const settle = (claim: DecisionsRelayDeploy["claim"], drop: boolean) => {
      if (!current()) return;
      if (drop) {
        run.claimSecret = null;
        run.host?.dispose();
        run.host = null;
      }
      run.snapshot = { ...(drop ? withoutSecret(run.snapshot) : run.snapshot), claim };
      this.deps.onChange();
    };
    run.snapshot = { ...run.snapshot, claim: { state: "claiming" } };
    this.deps.onChange();
    const attempt: Promise<DecisionsConnectResult> = Promise.resolve()
      .then(() => {
        // Dropped before it began: nothing goes to the relay.
        if (!current()) {
          throw new AppError({ code: "CANCELLED", message: "The guided deploy was dropped" });
        }
        return this.deps.claimRelay({
          url: held.url,
          claimSecret: held.claimSecret,
          ...(acceptWeakStorage ? { acceptWeakStorage: true } : {}),
        });
      })
      .then(
        (outcome) => {
          if (outcome.result === "saved") {
            const origin = outcome.status.relayOrigin ?? originOf(held.url);
            settle({ state: "claimed", origin }, true);
          } else {
            settle({ state: "failed", failure: outcome }, false);
          }
          return outcome;
        },
        (error: unknown) => {
          settle({ state: "failed", failure: claimError(error) }, false);
          throw error;
        }
      )
      .finally(() => {
        if (run.claiming === attempt) run.claiming = null;
      });
    run.claiming = attempt;
    return attempt;
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
    if (this.run) this.run.claimSecret = null;
    this.run?.host?.dispose();
    this.run = null;
  }
}
