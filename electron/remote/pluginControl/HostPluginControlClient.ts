import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { HostProjectSummary } from "../../../shared/types/ipc/remoteHosts.js";
import type { PluginRemoteHost } from "../../../shared/types/plugin.js";
import type { HostConnectionState, HostId } from "../../../shared/types/remoteHosts.js";
import { RemoteDispatchAnswerSchema } from "../../services/plugin/pluginFrontendRequests.js";
import type {
  PluginHostAgentInput,
  PluginHostAgentInputAnswer,
  PluginHostTarget,
  PluginHostTargets,
} from "../../services/plugin/pluginHostTargets.js";
import type { LinkSession } from "../link/session.js";
import {
  PLUGIN_CONTROL_CALL_MS,
  PluginControlAgentInputAnswerSchema,
  PluginControlMethod,
} from "./linkMethods.js";

/** A host as this Shell last observed it. */
export interface PluginControlObservedHost {
  hostId: HostId;
  name: string;
  connection: HostConnectionState;
  /** The person disconnected it and nothing has dialled it since. */
  disconnectedByPerson?: boolean;
}

export interface HostPluginControlClientDeps {
  /** Every Remote Host this Shell knows, as last observed. */
  hosts(): PluginControlObservedHost[];
  /** A connected host's projects. */
  listHostProjects(hostId: HostId): Promise<readonly HostProjectSummary[]>;
  /** Dials a host this Shell holds no link to; one the person disconnected is left alone. */
  connect(hostId: HostId, timeoutMs: number): Promise<unknown>;
  /** The host's open session, connecting it if need be; null when it can't be reached. */
  session(hostId: HostId): Promise<LinkSession | null>;
  /** This Shell's plugin credential for a host; null when none can be kept here. */
  credential(hostId: HostId): string | null;
}

/** How long a listing waits for a host whose link went idle to connect. */
const LIST_CONNECT_MS = 8_000;
/** How long a listing waits for a connected host to name its projects. */
const PROJECTS_READ_MS = 5_000;

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function withinMs<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function observedConnection(state: HostConnectionState): PluginRemoteHost["connection"] {
  return state.status === "connected" || state.status === "connecting" ? state.status : "disconnected";
}

/**
 * This Shell's side of its installed plugins reaching its Remote Hosts
 * (#16767): listing them, and carrying one plugin's dispatch or agent input
 * to a host, proven with this Shell's plugin credential for it. Holds no
 * state, listener or timer of its own; a link is dialled only for a call.
 */
export class HostPluginControlClient implements PluginHostTargets {
  constructor(private readonly deps: HostPluginControlClientDeps) {}

  /**
   * Every Remote Host, with each connected host's projects. A host whose link
   * went idle is dialled first, as a dispatch to it would be; one the person
   * disconnected stays as it is.
   */
  async listHosts(): Promise<PluginRemoteHost[]> {
    const idle = this.deps
      .hosts()
      .filter(
        (host) =>
          host.disconnectedByPerson !== true &&
          (host.connection.status === "disconnected" || host.connection.status === "connecting")
      );
    await Promise.all(
      idle.map((host) =>
        withinMs(
          Promise.resolve().then(() => this.deps.connect(host.hostId, LIST_CONNECT_MS)),
          LIST_CONNECT_MS,
          undefined
        )
      )
    );
    const hosts = this.deps.hosts();
    const projects = await Promise.all(
      hosts.map((host) =>
        host.connection.status === "connected"
          ? withinMs(
              Promise.resolve().then(() => this.deps.listHostProjects(host.hostId)),
              PROJECTS_READ_MS,
              null
            )
          : Promise.resolve(null)
      )
    );
    return hosts.map((host, index) => {
      const listed = projects[index];
      return {
        hostId: host.hostId,
        name: host.name,
        connection: observedConnection(host.connection),
        projects: listed ? listed.map((project) => ({ projectId: project.id, name: project.name })) : null,
      };
    });
  }

  async dispatch(
    target: PluginHostTarget,
    request: { projectId: string; actionId: string; args: unknown }
  ): Promise<ActionDispatchResult> {
    const opened = await this.open(target.hostId);
    if (!opened.ok) return opened.result;
    let answer: unknown;
    try {
      answer = await opened.session.call(
        PluginControlMethod.DISPATCH,
        {
          credential: opened.credential,
          pluginId: target.pluginId,
          projectId: request.projectId,
          actionId: request.actionId,
          ...(request.args !== undefined ? { args: request.args } : {}),
        },
        { timeoutMs: PLUGIN_CONTROL_CALL_MS }
      );
    } catch (error) {
      return this.failed(target.hostId, request.actionId, error);
    }
    const parsed = RemoteDispatchAnswerSchema.safeParse(answer);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "EXECUTION_ERROR",
          message: `Malformed answer to ${request.actionId} from ${this.nameOf(target.hostId)}`,
        },
      };
    }
    return parsed.data as ActionDispatchResult;
  }

  /**
   * Input to an agent the plugin launched on the host. The host answers from
   * its own record of what this plugin launched there from this Shell.
   */
  async agentInput(
    target: PluginHostTarget,
    terminalId: string,
    input: PluginHostAgentInput
  ): Promise<PluginHostAgentInputAnswer> {
    const opened = await this.open(target.hostId);
    if (!opened.ok) return { status: "unavailable" };
    let answer: unknown;
    try {
      answer = await opened.session.call(
        PluginControlMethod.AGENT_INPUT,
        { credential: opened.credential, pluginId: target.pluginId, terminalId, input },
        { timeoutMs: PLUGIN_CONTROL_CALL_MS }
      );
    } catch (error) {
      if (codeOf(error) === "UNSUPPORTED") {
        return {
          status: "refused",
          reason: `${this.nameOf(target.hostId)} runs a Daintree that plugins on other machines can't reach. It needs a newer Daintree.`,
        };
      }
      // Input may already have been written, so this is never `unavailable`.
      throw new Error(
        `Plugin "${target.pluginId}" agents.${input.op}: no answer came back from ${this.nameOf(target.hostId)}; the input may or may not have been written`,
        { cause: error }
      );
    }
    const parsed = PluginControlAgentInputAnswerSchema.safeParse(answer);
    if (!parsed.success) {
      throw new Error(
        `Plugin "${target.pluginId}" agents.${input.op}: malformed answer from ${this.nameOf(target.hostId)}`
      );
    }
    return parsed.data;
  }

  /** Whether this Shell knows `hostId` as one of its Remote Hosts. */
  knows(hostId: string): boolean {
    return this.deps.hosts().some((host) => host.hostId === hostId);
  }

  nameOf(hostId: HostId): string {
    return this.deps.hosts().find((host) => host.hostId === hostId)?.name ?? hostId;
  }

  private async open(
    hostId: HostId
  ): Promise<
    | { ok: true; session: LinkSession; credential: string }
    | { ok: false; result: ActionDispatchResult }
  > {
    const unreachable = (): { ok: false; result: ActionDispatchResult } => ({
      ok: false,
      result: {
        ok: false,
        error: {
          code: "HOST_UNREACHABLE",
          message: `Couldn't reach ${this.nameOf(hostId)}. Nothing was sent.`,
        },
      },
    });
    let credential: string | null;
    try {
      credential = this.deps.credential(hostId);
    } catch {
      credential = null;
    }
    if (credential === null) return unreachable();
    const session = await this.deps.session(hostId).catch(() => null);
    if (!session || !session.isOpen) return unreachable();
    return { ok: true, session, credential };
  }

  private failed(hostId: HostId, actionId: string, error: unknown): ActionDispatchResult {
    const code = codeOf(error);
    if (code === "UNSUPPORTED") {
      return {
        ok: false,
        error: {
          code: "HOST_REFUSED",
          message: `${this.nameOf(hostId)} runs a Daintree that plugins on other machines can't reach. It needs a newer Daintree.`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "EXECUTION_ERROR",
        message: `No answer came back from ${this.nameOf(hostId)} for ${actionId}; it may or may not have run.`,
      },
    };
  }
}
