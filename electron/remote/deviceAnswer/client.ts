import type { HostId } from "../../../shared/types/remoteHosts.js";
import type {
  DeviceWaitingHostStatus,
  WaitingRunView,
} from "../../services/deviceAnswer/deviceAnswerRuns.js";
import { answerRefused } from "../../services/terminalAnswer.js";
import type { AppError } from "../../utils/errorTypes.js";
import { DeviceAnswerLinkMethod, DeviceAnswerListResultSchema } from "./linkMethods.js";

/** Long enough for a host to read its screens; a slower one is shown as unreachable this poll. */
export const HOST_LIST_TIMEOUT_MS = 5_000;
/** Past the host's own budget for pressing keys, so a slow answer is the host's to stop. */
export const HOST_ANSWER_TIMEOUT_MS = 15_000;
const MAX_HOST_REFUSAL_LENGTH = 300;

export interface DeviceAnswerHostSession {
  readonly isOpen: boolean;
  call(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

export interface DeviceAnswerHostsClientDeps {
  /** Every host in the host list, by the id and name this Shell knows it by. */
  hosts(): Array<{ hostId: HostId; name: string }>;
  /** The host's current session, or null while it has none. Never dials. */
  sessionFor(hostId: HostId): DeviceAnswerHostSession | null;
  touch(hostId: HostId): void;
  hold(hostId: HostId): () => void;
}

export interface HostWaitingRuns {
  hostId: HostId;
  host: string;
  status: DeviceWaitingHostStatus;
  runs: WaitingRunView[];
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/**
 * Shell side of answering, from a device paired here, the agents waiting on
 * the hosts this Shell is connected to. Only hosts already connected are
 * read; a device polling never dials one, and is told of the rest as not
 * connected. Each host lists and answers its
 * own runs under its own drive lease, and this side trusts nothing it sends
 * back until it has been read against the schema.
 */
export class DeviceAnswerHostsClient {
  constructor(private readonly deps: DeviceAnswerHostsClientDeps) {}

  hostName(hostId: HostId): string | null {
    const entry = this.deps.hosts().find((candidate) => candidate.hostId === hostId);
    return entry ? entry.name || hostId : null;
  }

  /** Every host's waiting runs, read together: a slow or older host holds up none of the rest. */
  listWaiting(): Promise<HostWaitingRuns[]> {
    return Promise.all(
      this.deps.hosts().map(async ({ hostId, name }): Promise<HostWaitingRuns> => {
        const host = name || hostId;
        const session = this.deps.sessionFor(hostId);
        if (!session?.isOpen) return { hostId, host, status: "not-connected", runs: [] };
        try {
          // A device watching a host's agents is using it: the idle release starts counting again.
          this.deps.touch(hostId);
          const raw = await session.call(
            DeviceAnswerLinkMethod.LIST,
            {},
            { timeoutMs: HOST_LIST_TIMEOUT_MS }
          );
          const parsed = DeviceAnswerListResultSchema.safeParse(raw);
          if (parsed.success) return { hostId, host, status: "ok", runs: parsed.data.runs };
          return { hostId, host, status: "unreachable", runs: [] };
        } catch (error) {
          const status = errorCode(error) === "UNSUPPORTED" ? "needs-update" : "unreachable";
          return { hostId, host, status, runs: [] };
        }
      })
    );
  }

  /**
   * Press the option labelled `label` in one of a host's runs. Resolves once
   * the host pressed every key; rejects with the reason, in words the page
   * shows. Never sent twice: a link lost mid-answer may have pressed it.
   */
  async answer(request: {
    hostId: HostId;
    runId: string;
    spawnedAt: number;
    label: string;
  }): Promise<void> {
    const { hostId, runId, spawnedAt, label } = request;
    const host = this.hostName(hostId);
    if (host === null) {
      throw answerRefused("That host isn't in Daintree's host list any more. Nothing was pressed.");
    }
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) throw answerRefused(`${host} isn't connected. Nothing was pressed.`);
    const release = this.deps.hold(hostId);
    try {
      await session.call(
        DeviceAnswerLinkMethod.ANSWER,
        { runId, spawnedAt, label },
        { timeoutMs: HOST_ANSWER_TIMEOUT_MS }
      );
    } catch (error) {
      throw refusalFrom(error, host);
    } finally {
      release();
    }
  }
}

function refusalFrom(error: unknown, host: string): AppError {
  switch (errorCode(error)) {
    case "UNSUPPORTED":
      return answerRefused(
        `${host} needs a newer Daintree to be answered from another device. Nothing was pressed.`
      );
    case "HOST_DISCONNECTED":
      return answerRefused(`${host} isn't connected. Nothing was pressed.`);
    case "OUTCOME_UNKNOWN":
      return answerRefused(
        `The connection to ${host} dropped while answering. It may have been pressed, so check before answering again.`
      );
    case "NOT_FOUND": {
      // The host's own refusal, which says what it did and didn't press.
      const said = (error as { userMessage?: unknown }).userMessage;
      if (typeof said === "string" && said !== "") {
        return answerRefused(said.slice(0, MAX_HOST_REFUSAL_LENGTH));
      }
      break;
    }
  }
  return answerRefused(`${host} couldn't answer. Check its screen before answering again.`);
}
