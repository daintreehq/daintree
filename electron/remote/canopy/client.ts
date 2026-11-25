import { randomUUID } from "node:crypto";
import type { ClientRef } from "../../ipc/endpoint.js";
import {
  ASSISTANT_VIEWER_VERSION,
  isCanopyHostChannel,
  type AssistantViewerChannel,
  type CanopyHostEvent,
  type CanopyHostPushChannel,
  type HostAssistantDirectory,
  type HostSignInStep,
  type HostSignInTerminal,
  type SignInShownAnswer,
} from "../../../shared/types/ipc/canopyHost.js";
import type {
  AssistantOpenDestination,
  CanopySnapshot,
  CanopyTerminalData,
  CanopyTerminalView,
} from "../../../shared/types/ipc/canopy.js";
import {
  AgentDirectorySubjectSchema,
  agentDirectoryAs,
  unreadAgentDirectory,
  type AgentDirectory,
  type AgentDirectorySubject,
} from "../../../shared/types/agentDirectory.js";
import type { FleetSnapshot } from "../../../shared/types/ipc/fleet.js";
import { isIpcEnvelope } from "../../../shared/types/ipc/errors.js";
import { LOCAL_HOST_ID, isLocalHostId, type HostId } from "../../../shared/types/remoteHosts.js";
import { deserializeError } from "../../../shared/utils/ipcErrorSerialization.js";
import { AppError } from "../../utils/errorTypes.js";
import type { EventMessage } from "../link/messages.js";
import type { LinkSession } from "../link/session.js";
import {
  CANOPY_VIEWER_ENDPOINT_PREFIX,
  CanopyAssistantsAnswerSchema,
  CanopyAssistantWorkAnswerSchema,
  CanopyLinkMethod,
  CanopySignInStartAnswerSchema,
  CanopyViewerLostPayloadSchema,
  isCanopyViewerId,
} from "./linkMethods.js";
import type { CanopyViewers } from "./viewer.js";
import {
  ASSISTANT_WORK_VERSION,
  unreadAssistantWork,
  type AssistantWorkReading,
} from "../../../shared/types/assistantWork.js";
import { resolveAssistantWork } from "../../services/assistants/assistantWork.js";

export interface CanopyHostConnection {
  callHost(method: string, payload: unknown): Promise<unknown>;
}

/** How often, and how far apart, a release the host didn't take is sent again. */
export const RELEASE_RETRIES = 5;
export const RELEASE_RETRY_MS = 1_000;

/**
 * How long the window showing an assistant has to open the sign-in started for
 * it (#18197), counted from the call: past it the sign-in ends on its host.
 */
export const SIGN_IN_OFFER_MS = 30_000;

/**
 * What became of a sign-in started for an assistant (#18197). `shown`: the
 * window's dialog opened its terminal live. `withdrawn`: it ended before that,
 * closed in the window, refused there over another sign-in, or its view went.
 * `busy`: a sign-in was already open in that window, so none started.
 * `undelivered`: it started, but the window couldn't be told of it.
 */
export type SignInOfferAnswer =
  | "shown"
  | "withdrawn"
  | "busy"
  | "expired"
  | "cancelled"
  | "no_window"
  | "undelivered"
  | "unsupported"
  | "disconnected"
  | "rate_limited"
  | "failed";

interface SignInOffer {
  finish(answer: SignInOfferAnswer, release: boolean): void;
  /** Whether its window is still on screen, showing the assistant it was started for. */
  stillShown(): boolean;
  expiresAt: number;
}

export interface CanopyHostsClientOptions {
  manager: {
    get(hostId: HostId): CanopyHostConnection | undefined;
    connect(hostId: HostId): unknown;
    touch(hostId: HostId): void;
    addUseCheck(check: (hostId: HostId) => boolean): () => void;
    onSessionOpened(
      listener: (hostId: HostId, session: Pick<LinkSession, "registerCallHandler">) => void
    ): () => void;
    onViewerEvent(listener: (hostId: HostId, event: EventMessage) => void): () => void;
  };
  registry: {
    get(hostId: HostId): unknown;
    onChange(listener: () => void): () => void;
  };
  /** The host a view is bound to, or null for one of this machine's. */
  hostForView(webContentsId: number): HostId | null;
  /** This machine's Canopy, for a remote-bound view reading This Mac. */
  local: CanopyViewers;
  localClient: ClientRef;
  /** Push to one view; false when it is gone. */
  send(webContentsId: number, event: CanopyHostEvent): boolean;
  /** Told once when the view reloads or goes away, which ends every panel it showed. */
  watchView(webContentsId: number, onGone: () => void): () => void;
  /** This machine's agent directory, for a picker listing This Mac; absent, it reads none. */
  readLocalAgents?: (options: {
    projectId?: string;
    assistantsOnly?: boolean;
  }) => Promise<AgentDirectory>;
  /** This machine's assistant work, for Canopy showing This Mac; absent, it reads none. */
  readLocalAssistantWork?: () => Promise<AssistantWorkReading>;
  /** The sender this Shell proves to a host, without minting one; null when it never has. */
  ownSenderFor?: (hostId: HostId) => string | null;
  /** Finds this Shell's live assistant whose session a host's reading keys, or null. */
  localAssistants?: () => Promise<(sessionKey: string) => AgentDirectorySubject | null>;
  newViewerId?: () => string;
}

interface Subscription {
  webContentsId: number;
  hostId: HostId;
  viewerId: string;
  /** The assistant viewer's consumer in its view; null for the view's Canopy panel. */
  consumer: string | null;
  /** The exact run an assistant viewer shows, for as long as it lives. */
  subjectKey: string | null;
  /**
   * A sign-in viewer's terminal once its host started it, and the stream the
   * view has open on it; absent for every other viewer.
   */
  signIn?: { terminalId: string | null; watchId: number | null };
}

interface ViewRecord {
  hosts: Map<HostId, Subscription>;
  /** Each assistant consumer's one viewer, on the host of the assistant it shows. */
  assistants: Map<string, Subscription>;
  /** Each sign-in consumer's one viewer, on the host it signs an agent in on. */
  signIns: Map<string, Subscription>;
  unwatch: () => void;
}

/** The assistant viewer's calls that ride a watch it already has. */
type AssistantStreamChannel = Exclude<
  AssistantViewerChannel,
  "canopy:watch-assistant-terminal" | "canopy:resolve-assistant"
>;

const ASSISTANT_STREAM_CHANNELS: ReadonlySet<string> = new Set<AssistantStreamChannel>([
  "canopy:unwatch-terminal",
  "canopy:terminal-input",
  "canopy:terminal-submit",
  "canopy:terminal-send-key",
]);

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** A host from before the assistant viewer: its workers read on, its assistants don't. */
function assistantsUnsupported(hostId: HostId): AppError {
  return new AppError({
    code: "UNSUPPORTED",
    message: `Host ${hostId} has no assistant viewer`,
    userMessage: "This host needs a newer Daintree to show its assistants.",
    context: { hostId },
  });
}

/** A host from before sign-ins answers the method as unknown. */
function signInsUnsupported(hostId: HostId): AppError {
  return new AppError({
    code: "UNSUPPORTED",
    message: `Host ${hostId} has no agent sign-ins`,
    userMessage: "This host needs a newer Daintree to sign in its agents from here.",
    context: { hostId },
  });
}

function signInGone(): AppError {
  return new AppError({
    code: "NOT_FOUND",
    message: "No sign-in is running for this consumer",
    userMessage: "That sign-in isn't running any more.",
  });
}

/**
 * Typing whose answer the link lost: it may have reached the assistant or
 * not, and only its screen can say. It is never sent again from here.
 */
function deliveryUnknown(error: unknown): AppError {
  return new AppError({
    code: "OUTCOME_UNKNOWN",
    message: "The link dropped before the host answered an assistant's input",
    userMessage:
      "The connection dropped while sending, so this may not have reached the assistant. Check its screen before sending again.",
    cause: error instanceof Error ? error : undefined,
  });
}

/** The same entries as this Shell names the host: never the id the host gave itself. */
function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function eventFor(
  hostId: HostId,
  channel: CanopyHostPushChannel,
  payload: unknown
): CanopyHostEvent {
  switch (channel) {
    case "canopy:snapshot-updated":
      return { kind: "canopy-snapshot", hostId, snapshot: payload as CanopySnapshot };
    case "fleet:snapshot-updated":
      return { kind: "fleet-snapshot", hostId, snapshot: payload as FleetSnapshot };
    case "canopy:terminal-data":
      return { kind: "terminal-data", hostId, chunk: payload as CanopyTerminalData };
  }
}

/**
 * Canopy reading a host the view isn't bound to: another remote host, or This
 * Mac from a remote-bound view. A view's own host is never reached this way;
 * its Canopy calls take the view's ordinary route, exactly as before.
 *
 * Each view gets one viewer per host it reads, which the host serves with its
 * own Canopy handlers and consent. Its pushes come back tagged with the id
 * this Shell knows the host by, and the link stays up while any view reads it.
 */
export class CanopyHostsClient {
  private readonly views = new Map<number, ViewRecord>();
  private readonly byViewer = new Map<string, Subscription>();
  private readonly disposers: Array<() => void> = [];
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();
  /** Sign-ins started for an assistant that their window hasn't opened yet, by view and consumer. */
  private readonly offers = new Map<string, SignInOffer>();
  private disposed = false;

  constructor(private readonly options: CanopyHostsClientOptions) {}

  start(): void {
    const { manager, registry } = this.options;
    this.disposers.push(
      manager.addUseCheck((hostId) => this.isRead(hostId)),
      manager.onViewerEvent((hostId, event) => this.onViewerEvent(hostId, event)),
      manager.onSessionOpened((hostId, session) => {
        session.registerCallHandler(
          CanopyLinkMethod.VIEWER_LOST,
          CanopyViewerLostPayloadSchema,
          ({ viewerId }) => {
            const sub = this.byViewer.get(viewerId);
            if (sub?.hostId === hostId) this.tellToResync(sub);
            return null;
          }
        );
        // A fresh or resumed link: the host's viewers went with the old one.
        this.resync(hostId);
      }),
      registry.onChange(() => this.dropRemovedHosts())
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const offer of [...this.offers.values()]) offer.finish("cancelled", false);
    for (const webContentsId of [...this.views.keys()]) this.releaseView(webContentsId);
    this.disposed = true;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
    this.options.local.dispose();
  }

  /** Whether any view reads the host through Canopy right now. */
  isRead(hostId: HostId): boolean {
    for (const sub of this.byViewer.values()) if (sub.hostId === hostId) return true;
    return false;
  }

  async invoke(
    webContentsId: number,
    hostId: unknown,
    channel: unknown,
    args: unknown
  ): Promise<unknown> {
    const target = this.targetOf(webContentsId, hostId);
    if (!isCanopyHostChannel(channel)) {
      throw invalid(`${String(channel)} can't be called on another host's Canopy`);
    }
    if (!Array.isArray(args)) throw invalid("args must be an array");
    // Ending a watch on a host the view no longer reads: nothing is open there
    // to end, and subscribing to say so would open it again.
    if (
      channel === "canopy:unwatch-terminal" &&
      !this.views.get(webContentsId)?.hosts.has(target)
    ) {
      return undefined;
    }
    const sub = this.subscribe(webContentsId, target);
    if (isLocalHostId(target)) {
      const envelope = await this.options.local.invoke(
        sub.viewerId,
        () => ({
          endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + sub.viewerId,
          clientId: this.options.localClient.clientId,
          onPush: (pushed, payload) => {
            if (this.byViewer.get(sub.viewerId) !== sub) return;
            this.options.send(webContentsId, eventFor(LOCAL_HOST_ID, pushed, payload));
          },
        }),
        this.options.localClient,
        channel,
        args
      );
      if (!envelope.ok) throw deserializeError(envelope.error);
      return envelope.data;
    }
    this.options.manager.touch(target);
    const connection = this.options.manager.get(target);
    if (!connection) {
      // Dialled now; the view hears `resync` once it's up and asks again.
      this.options.manager.connect(target);
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${target} is not connected`,
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    }
    const answer = await connection.callHost(CanopyLinkMethod.INVOKE, {
      viewerId: sub.viewerId,
      channel,
      args,
      interactive: true,
    });
    if (!isIpcEnvelope(answer)) {
      throw new AppError({ code: "INTERNAL", message: `Host ${target} sent an invalid answer` });
    }
    if (!answer.ok) throw deserializeError(answer.error);
    return answer.data;
  }

  /**
   * The assistants a host holds, for a person's picker: summaries only, no
   * screen and no stream. A host that predates the assistant viewer reads as
   * unsupported, never as one with no assistants.
   */
  async listAssistants(
    webContentsId: number,
    hostId: unknown,
    projectId?: unknown
  ): Promise<HostAssistantDirectory> {
    const target = this.assistantHostOf(webContentsId, hostId, { allowOwnLocal: true });
    if (projectId !== undefined && (typeof projectId !== "string" || projectId.length === 0)) {
      throw invalid("projectId must be a non-empty string");
    }
    const options = projectId === undefined ? {} : { projectId };
    if (isLocalHostId(target)) {
      const read = this.options.readLocalAgents;
      const directory = read
        ? await read({ ...options, assistantsOnly: true }).catch(() =>
            unreadAgentDirectory("unreachable")
          )
        : unreadAgentDirectory("unsupported");
      return {
        hostId: LOCAL_HOST_ID,
        version: read ? ASSISTANT_VIEWER_VERSION : null,
        directory: agentDirectoryAs(LOCAL_HOST_ID, assistantEntries(directory)),
      };
    }
    this.options.manager.touch(target);
    const connection = this.options.manager.get(target);
    if (!connection) {
      this.options.manager.connect(target);
      return { hostId: target, version: null, directory: unreadAgentDirectory("unreachable") };
    }
    let raw: unknown;
    try {
      raw = await connection.callHost(CanopyLinkMethod.ASSISTANTS, options);
    } catch (error) {
      if (codeOf(error) === "UNSUPPORTED") {
        return { hostId: target, version: null, directory: unreadAgentDirectory("unsupported") };
      }
      return { hostId: target, version: null, directory: unreadAgentDirectory("unreachable") };
    }
    const answer = CanopyAssistantsAnswerSchema.safeParse(raw);
    if (!answer.success) {
      throw new AppError({ code: "INTERNAL", message: `Host ${target} sent an invalid answer` });
    }
    return {
      hostId: target,
      version: answer.data.version,
      directory: agentDirectoryAs(target, assistantEntries(answer.data.directory)),
    };
  }

  /**
   * Which of a host's workers an assistant made or holds (#14166), with every
   * assistant named as this Shell knows it. A host that predates it reads as
   * unsupported, and one that can't be reached as unreachable: never as a
   * host whose workers no assistant made.
   */
  async readAssistantWork(webContentsId: number, hostId: unknown): Promise<AssistantWorkReading> {
    const target = this.assistantHostOf(webContentsId, hostId, { allowOwnLocal: true });
    if (isLocalHostId(target)) {
      const read = this.options.readLocalAssistantWork;
      return read
        ? read().catch(() => unreadAssistantWork("unreachable"))
        : unreadAssistantWork("unsupported");
    }
    this.options.manager.touch(target);
    const connection = this.options.manager.get(target);
    if (!connection) {
      this.options.manager.connect(target);
      return unreadAssistantWork("unreachable");
    }
    let raw: unknown;
    try {
      raw = await connection.callHost(CanopyLinkMethod.ASSISTANT_WORK, {});
    } catch (error) {
      return unreadAssistantWork(codeOf(error) === "UNSUPPORTED" ? "unsupported" : "unreachable");
    }
    const answer = CanopyAssistantWorkAnswerSchema.safeParse(raw);
    if (!answer.success) {
      throw new AppError({ code: "INTERNAL", message: `Host ${target} sent an invalid answer` });
    }
    if (answer.data.version !== ASSISTANT_WORK_VERSION) return unreadAssistantWork("unsupported");
    const bySessionKey = (await this.options.localAssistants?.()) ?? (() => null);
    return resolveAssistantWork(answer.data.reading, {
      hostId: target,
      ownSenderId: this.options.ownSenderFor?.(target) ?? null,
      assistantBySessionKey: bySessionKey,
    });
  }

  /**
   * Stream one assistant to the view's `consumer`, as the exact run the
   * subject names. The Shell says which host it is; that host checks the
   * lane (or global session) and launch generation against its own hold on
   * the run. Only this assistant's terminal is watched there.
   */
  async watchAssistant(
    webContentsId: number,
    consumer: unknown,
    rawSubject: unknown
  ): Promise<CanopyTerminalView> {
    const { target, subject } = this.assistantSubjectOf(webContentsId, rawSubject);
    const sub = this.subscribeAssistant(webContentsId, consumerOf(consumer), target, subject);
    const view = (await this.callAssistant(sub, "canopy:watch-assistant-terminal", [
      subject,
    ])) as CanopyTerminalView;
    // Released, replaced or resynced while the host answered: that stream is gone.
    if (this.byViewer.get(sub.viewerId) !== sub) return { watchId: null, snapshot: null };
    return view;
  }

  /** Where "Open in Assistant" would land for the subject, as its own host says; null once it ended. */
  async resolveAssistant(
    webContentsId: number,
    consumer: unknown,
    rawSubject: unknown
  ): Promise<AssistantOpenDestination | null> {
    const { target, subject } = this.assistantSubjectOf(webContentsId, rawSubject);
    const sub = this.subscribeAssistant(webContentsId, consumerOf(consumer), target, subject);
    const destination = (await this.callAssistant(sub, "canopy:resolve-assistant", [
      subject,
    ])) as AssistantOpenDestination | null;
    return destination ? { ...destination, hostId: target } : null;
  }

  /**
   * Typing to, keying or ending the consumer's stream. Never sent again: an
   * answer the link lost is said as unknown, not retried.
   */
  async assistantInvoke(
    webContentsId: number,
    consumer: unknown,
    channel: unknown,
    args: unknown
  ): Promise<unknown> {
    const name = consumerOf(consumer);
    if (typeof channel !== "string" || !ASSISTANT_STREAM_CHANNELS.has(channel)) {
      throw invalid(`${String(channel)} isn't an assistant viewer's call`);
    }
    if (!Array.isArray(args)) throw invalid("args must be an array");
    const sub = this.views.get(webContentsId)?.assistants.get(name);
    if (!sub) {
      if (channel === "canopy:unwatch-terminal") return undefined;
      throw new AppError({
        code: "NOT_FOUND",
        message: "No assistant is watched by this consumer",
        userMessage: "That assistant isn't open here any more.",
      });
    }
    try {
      return await this.callAssistant(sub, channel as AssistantStreamChannel, args);
    } catch (error) {
      if (codeOf(error) === "OUTCOME_UNKNOWN") throw deliveryUnknown(error);
      throw error;
    }
  }

  /**
   * Start an agent CLI's own sign-in on a connected host, for the view's
   * `consumer` (#18196). The host runs it in a terminal of its own, placed in
   * no project, which lasts as long as this viewer: the consumer letting go,
   * the view going or the link dropping all end it there. A host that isn't
   * connected is never dialled for one.
   */
  async startSignIn(
    webContentsId: number,
    consumer: unknown,
    hostId: unknown,
    agentId: unknown
  ): Promise<HostSignInTerminal> {
    const name = consumerOf(consumer);
    // As long as an agent id a host's inventory reports may be.
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 256) {
      throw invalid("agentId must be a non-empty string");
    }
    const target = this.assistantHostOf(webContentsId, hostId, { allowOwnLocal: true });
    if (isLocalHostId(target)) throw invalid("Sign-ins run on a connected host");
    const record = this.recordOf(webContentsId);
    if (record.signIns.has(name)) {
      throw invalid("A consumer runs one sign-in; release it before starting another");
    }
    const viewerId = this.options.newViewerId?.() ?? randomUUID();
    const sub: Subscription = {
      webContentsId,
      hostId: target,
      viewerId,
      consumer: name,
      subjectKey: null,
      signIn: { terminalId: null, watchId: null },
    };
    record.signIns.set(name, sub);
    this.byViewer.set(viewerId, sub);
    try {
      const answer = CanopySignInStartAnswerSchema.safeParse(
        await this.callSignIn(sub, { op: "start", agentId })
      );
      if (!answer.success) {
        throw new AppError({ code: "INTERNAL", message: `Host ${target} sent an invalid answer` });
      }
      // Let go while it started: the release ended it there.
      if (this.byViewer.get(viewerId) !== sub) throw signInGone();
      sub.signIn!.terminalId = answer.data.terminalId;
      return answer.data;
    } catch (error) {
      this.drop(sub);
      this.forgetIfEmpty(webContentsId, record);
      throw error;
    }
  }

  /** Watch, type into, size or let go of the stream of the consumer's sign-in. */
  async signInStep(
    webContentsId: number,
    consumer: unknown,
    step: unknown
  ): Promise<CanopyTerminalView | null> {
    const name = consumerOf(consumer);
    const parsed = signInStepOf(step);
    const sub = this.views.get(webContentsId)?.signIns.get(name);
    if (!sub?.signIn || sub.signIn.terminalId === null) {
      if (parsed.op === "unwatch") return null;
      throw signInGone();
    }
    try {
      const answer = await this.callSignIn(sub, parsed);
      if (parsed.op === "unwatch" && sub.signIn.watchId === parsed.watchId) {
        sub.signIn.watchId = null;
      }
      if (parsed.op !== "watch") return null;
      const view = answer as CanopyTerminalView;
      // Released or ended while the host answered: that stream is gone.
      if (this.byViewer.get(sub.viewerId) !== sub) return { watchId: null, snapshot: null };
      sub.signIn.watchId = view.watchId;
      return view;
    } catch (error) {
      if (codeOf(error) === "OUTCOME_UNKNOWN" && parsed.op === "input") {
        throw deliveryUnknown(error);
      }
      throw error;
    }
  }

  /** The consumer closed its sign-in: the host ends its terminal. */
  releaseSignIn(webContentsId: number, consumer: unknown): void {
    if (!isCanopyViewerId(consumer)) return;
    const record = this.views.get(webContentsId);
    const sub = record?.signIns.get(consumer);
    if (!record || !sub) return;
    this.drop(sub);
    this.forgetIfEmpty(webContentsId, record);
  }

  /**
   * Start an agent CLI's own sign-in on a connected host for one of this
   * machine's assistants (#18197), in the view showing it, and wait until that
   * view's dialog opens it. Main starts it, so the view only ever adopts a
   * sign-in under way: it watches it and lets it go, and the person types into
   * it. Never started over another sign-in open in that view; one nobody
   * opened within {@link SIGN_IN_OFFER_MS}, or whose call was cancelled first,
   * is let go on its host.
   */
  offerSignIn(
    webContentsId: number,
    hostId: HostId,
    agentId: string,
    options: { hostName: string; stillShown: () => boolean; signal?: AbortSignal }
  ): Promise<SignInOfferAnswer> {
    if (options.signal?.aborted === true) return Promise.resolve("cancelled");
    if ((this.views.get(webContentsId)?.signIns.size ?? 0) > 0) return Promise.resolve("busy");
    const consumer = `offer-${randomUUID()}`;
    const key = offerKey(webContentsId, consumer);
    const expiresAt = Date.now() + SIGN_IN_OFFER_MS;
    return new Promise<SignInOfferAnswer>((resolve) => {
      let settled = false;
      const finish = (answer: SignInOfferAnswer, release: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (this.offers.get(key) === offer) this.offers.delete(key);
        if (release) this.releaseSignIn(webContentsId, consumer);
        resolve(answer);
      };
      const onAbort = () => finish("cancelled", true);
      const offer: SignInOffer = { finish, stillShown: options.stillShown, expiresAt };
      // Armed before the start, so a slow one is held to the same deadline.
      const timer = setTimeout(() => finish("expired", true), SIGN_IN_OFFER_MS);
      timer.unref?.();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.offers.set(key, offer);
      this.startSignIn(webContentsId, consumer, hostId, agentId).then(
        (terminal) => {
          if (settled) return;
          const sent = this.options.send(webContentsId, {
            kind: "sign-in-offer",
            hostId,
            hostName: options.hostName,
            agentId,
            consumer,
            terminal,
            expiresAt,
          });
          if (!sent) finish("undelivered", true);
        },
        (error: unknown) => finish(signInOfferFailure(error), false)
      );
    });
  }

  /**
   * The view's dialog opened the terminal of a sign-in started for an
   * assistant, live (#18197). Taken only from the view it was started in,
   * while a watch this Shell served it is open, before its deadline, and while
   * that view is on screen showing the assistant; nothing it sends is read.
   */
  signInShown(webContentsId: number, consumer: unknown): SignInShownAnswer {
    if (!isCanopyViewerId(consumer)) return "gone";
    const offer = this.offers.get(offerKey(webContentsId, consumer));
    const sub = this.views.get(webContentsId)?.signIns.get(consumer);
    if (!offer || !sub?.signIn || sub.signIn.terminalId === null) return "gone";
    if (Date.now() >= offer.expiresAt) return "gone";
    if (sub.signIn.watchId === null || !offer.stillShown()) return "not_shown";
    offer.finish("shown", false);
    return "shown";
  }

  /** The consumer stopped showing its assistant: its viewer and watch there end. */
  releaseAssistant(webContentsId: number, consumer: unknown): void {
    if (!isCanopyViewerId(consumer)) return;
    const record = this.views.get(webContentsId);
    const sub = record?.assistants.get(consumer);
    if (!record || !sub) return;
    this.drop(sub);
    this.forgetIfEmpty(webContentsId, record);
  }

  /** The view's panel stopped reading the host: its state there goes too. */
  release(webContentsId: number, hostId: unknown): void {
    if (typeof hostId !== "string") return;
    const record = this.views.get(webContentsId);
    const sub = record?.hosts.get(isLocalHostId(hostId) ? LOCAL_HOST_ID : hostId);
    if (!record || !sub) return;
    this.drop(sub);
    this.forgetIfEmpty(webContentsId, record);
  }

  private forgetIfEmpty(webContentsId: number, record: ViewRecord): void {
    if (record.hosts.size > 0 || record.assistants.size > 0 || record.signIns.size > 0) return;
    if (this.views.get(webContentsId) !== record) return;
    this.views.delete(webContentsId);
    record.unwatch();
  }

  /**
   * The host an assistant viewer reads, by the id this Shell knows it by. A
   * view's own remote host is read this way too: its windows answer for this
   * machine's assistants, not that host's. This Mac's own views watch its
   * assistants directly, so naming This Mac from one is refused, except to list.
   */
  private assistantHostOf(
    webContentsId: number,
    hostId: unknown,
    { allowOwnLocal = false }: { allowOwnLocal?: boolean } = {}
  ): HostId {
    if (typeof hostId !== "string" || hostId.length === 0 || hostId.length > 64) {
      throw invalid("hostId must be a non-empty string");
    }
    const target = isLocalHostId(hostId) ? LOCAL_HOST_ID : hostId;
    if (!isLocalHostId(target) && !this.options.registry.get(target)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id "${target}"`,
        userMessage: "That host isn't in the host list.",
      });
    }
    if (
      !allowOwnLocal &&
      isLocalHostId(target) &&
      this.options.hostForView(webContentsId) === null
    ) {
      throw invalid("This machine's own views watch its assistants directly");
    }
    return target;
  }

  /** The subject as its own host names it: the host is this Shell's to say, and says itself as local. */
  private assistantSubjectOf(
    webContentsId: number,
    rawSubject: unknown
  ): { target: HostId; subject: AgentDirectorySubject } {
    const parsed = AgentDirectorySubjectSchema.safeParse(rawSubject);
    if (!parsed.success) throw invalid("Invalid assistant subject");
    const target = this.assistantHostOf(webContentsId, parsed.data.hostId);
    return { target, subject: { ...parsed.data, hostId: LOCAL_HOST_ID } };
  }

  /**
   * The consumer's viewer, for the one run it shows. A watch id is only its
   * host's, so a consumer is never moved to another run: input still in flight
   * for the old one would carry an id the new one could also hold.
   */
  private subscribeAssistant(
    webContentsId: number,
    consumer: string,
    hostId: HostId,
    subject: AgentDirectorySubject
  ): Subscription {
    const subjectKey = JSON.stringify([
      hostId,
      subject.scope,
      subject.terminalId,
      subject.incarnation,
      subject.lane ?? null,
    ]);
    const record = this.recordOf(webContentsId);
    const existing = record.assistants.get(consumer);
    if (existing) {
      if (existing.subjectKey === subjectKey) return existing;
      throw invalid("A consumer shows one assistant; release it before showing another");
    }
    const viewerId = this.options.newViewerId?.() ?? randomUUID();
    const sub: Subscription = { webContentsId, hostId, viewerId, consumer, subjectKey };
    record.assistants.set(consumer, sub);
    this.byViewer.set(viewerId, sub);
    return sub;
  }

  private async callAssistant(
    sub: Subscription,
    channel: AssistantViewerChannel,
    args: unknown[]
  ): Promise<unknown> {
    const consumer = sub.consumer as string;
    if (isLocalHostId(sub.hostId)) {
      const envelope = await this.options.local.invokeAssistant(
        sub.viewerId,
        () => ({
          endpointId: CANOPY_VIEWER_ENDPOINT_PREFIX + sub.viewerId,
          clientId: this.options.localClient.clientId,
          onPush: (pushed, payload) => {
            if (this.byViewer.get(sub.viewerId) !== sub || pushed !== "canopy:terminal-data") {
              return;
            }
            this.options.send(sub.webContentsId, {
              kind: "assistant-terminal-data",
              hostId: LOCAL_HOST_ID,
              consumer,
              chunk: payload as CanopyTerminalData,
            });
          },
        }),
        this.options.localClient,
        channel,
        args
      );
      if (!envelope.ok) throw deserializeError(envelope.error);
      return envelope.data;
    }
    this.options.manager.touch(sub.hostId);
    const connection = this.options.manager.get(sub.hostId);
    if (!connection) {
      this.options.manager.connect(sub.hostId);
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${sub.hostId} is not connected`,
        userMessage: "Couldn't reach this host. Check that it is on and try again.",
      });
    }
    let answer: unknown;
    try {
      answer = await connection.callHost(CanopyLinkMethod.ASSISTANT_INVOKE, {
        viewerId: sub.viewerId,
        channel,
        args,
        interactive: true,
      });
    } catch (error) {
      // An unknown method: the host predates the assistant viewer.
      if (codeOf(error) === "UNSUPPORTED") throw assistantsUnsupported(sub.hostId);
      throw error;
    }
    if (!isIpcEnvelope(answer)) {
      throw new AppError({
        code: "INTERNAL",
        message: `Host ${sub.hostId} sent an invalid answer`,
      });
    }
    if (!answer.ok) throw deserializeError(answer.error);
    return answer.data;
  }

  private async callSignIn(
    sub: Subscription,
    step: HostSignInStep | { op: "start"; agentId: string }
  ): Promise<unknown> {
    this.options.manager.touch(sub.hostId);
    const connection = this.options.manager.get(sub.hostId);
    if (!connection) {
      throw new AppError({
        code: "HOST_DISCONNECTED",
        message: `Host ${sub.hostId} is not connected`,
        userMessage: "This host isn't connected. Connect to it and try again.",
      });
    }
    try {
      return await connection.callHost(CanopyLinkMethod.SIGN_IN, {
        viewerId: sub.viewerId,
        ...step,
      });
    } catch (error) {
      // An unknown method: the host predates sign-ins.
      if (codeOf(error) === "UNSUPPORTED") throw signInsUnsupported(sub.hostId);
      throw error;
    }
  }

  private targetOf(webContentsId: number, hostId: unknown): HostId {
    if (typeof hostId !== "string" || hostId.length === 0 || hostId.length > 64) {
      throw invalid("hostId must be a non-empty string");
    }
    const target = isLocalHostId(hostId) ? LOCAL_HOST_ID : hostId;
    if (!isLocalHostId(target) && !this.options.registry.get(target)) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No host with id "${target}"`,
        userMessage: "That host isn't in the host list.",
      });
    }
    const own = this.options.hostForView(webContentsId) ?? LOCAL_HOST_ID;
    if (own === target) {
      throw invalid("A view's own host is read through its own Canopy, not by naming it");
    }
    return target;
  }

  private recordOf(webContentsId: number): ViewRecord {
    let record = this.views.get(webContentsId);
    if (!record) {
      const created: ViewRecord = {
        hosts: new Map(),
        assistants: new Map(),
        signIns: new Map(),
        unwatch: () => {},
      };
      this.views.set(webContentsId, created);
      created.unwatch = this.options.watchView(webContentsId, () => {
        if (this.views.get(webContentsId) === created) this.releaseView(webContentsId);
      });
      record = created;
    }
    return record;
  }

  private subscribe(webContentsId: number, hostId: HostId): Subscription {
    const record = this.recordOf(webContentsId);
    let sub = record.hosts.get(hostId);
    if (!sub) {
      const viewerId = this.options.newViewerId?.() ?? randomUUID();
      sub = { webContentsId, hostId, viewerId, consumer: null, subjectKey: null };
      record.hosts.set(hostId, sub);
      this.byViewer.set(viewerId, sub);
    }
    return sub;
  }

  private drop(sub: Subscription): void {
    if (this.byViewer.get(sub.viewerId) !== sub) return;
    this.byViewer.delete(sub.viewerId);
    const record = this.views.get(sub.webContentsId);
    if (sub.consumer === null) record?.hosts.delete(sub.hostId);
    else if (sub.signIn) {
      if (record?.signIns.get(sub.consumer) === sub) record.signIns.delete(sub.consumer);
      // Ended before its window opened it. One still starting answers with why it didn't.
      if (sub.signIn.terminalId !== null) {
        this.offers.get(offerKey(sub.webContentsId, sub.consumer))?.finish("withdrawn", false);
      }
    } else if (record?.assistants.get(sub.consumer) === sub) {
      record.assistants.delete(sub.consumer);
    }
    if (isLocalHostId(sub.hostId)) {
      this.options.local.close(sub.viewerId);
      return;
    }
    this.releaseOnHost(sub.hostId, sub.viewerId, 0);
    // The idle release counts from the last panel reading the host, not from its first.
    this.options.manager.touch(sub.hostId);
  }

  /**
   * A release the host didn't take leaves its panel open there, reading
   * screens, so it is sent again while the link is up. A dropped link took
   * the viewer with it.
   */
  private releaseOnHost(hostId: HostId, viewerId: string, attempt: number): void {
    const connection = this.options.manager.get(hostId);
    if (!connection || this.disposed) return;
    connection.callHost(CanopyLinkMethod.RELEASE, { viewerId }).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "HOST_DISCONNECTED" || attempt + 1 >= RELEASE_RETRIES || this.disposed) return;
      const timer = setTimeout(
        () => {
          this.retries.delete(timer);
          this.releaseOnHost(hostId, viewerId, attempt + 1);
        },
        RELEASE_RETRY_MS * (attempt + 1)
      );
      timer.unref?.();
      this.retries.add(timer);
    });
  }

  private releaseView(webContentsId: number): void {
    const record = this.views.get(webContentsId);
    if (!record) return;
    this.views.delete(webContentsId);
    record.unwatch();
    for (const sub of [
      ...record.hosts.values(),
      ...record.assistants.values(),
      ...record.signIns.values(),
    ]) {
      this.drop(sub);
    }
  }

  private onViewerEvent(hostId: HostId, event: EventMessage): void {
    const viewerId = event.endpointId?.slice(CANOPY_VIEWER_ENDPOINT_PREFIX.length);
    const sub = viewerId === undefined ? undefined : this.byViewer.get(viewerId);
    // Only the host the viewer was opened on speaks for it.
    if (!sub || sub.hostId !== hostId) return;
    const channel = event.channel;
    if (sub.signIn) {
      if (channel !== "canopy:terminal-data") return;
      this.options.send(sub.webContentsId, {
        kind: "sign-in-terminal-data",
        hostId,
        consumer: sub.consumer as string,
        chunk: event.args[0] as CanopyTerminalData,
      });
      return;
    }
    if (sub.consumer !== null) {
      // An assistant viewer hears its own stream and nothing else the host says.
      if (channel !== "canopy:terminal-data") return;
      this.options.send(sub.webContentsId, {
        kind: "assistant-terminal-data",
        hostId,
        consumer: sub.consumer,
        chunk: event.args[0] as CanopyTerminalData,
      });
      return;
    }
    if (
      channel !== "canopy:snapshot-updated" &&
      channel !== "fleet:snapshot-updated" &&
      channel !== "canopy:terminal-data"
    ) {
      return;
    }
    this.options.send(sub.webContentsId, eventFor(hostId, channel, event.args[0]));
  }

  private resync(hostId: HostId): void {
    for (const sub of [...this.byViewer.values()]) {
      if (sub.hostId === hostId) this.tellToResync(sub);
    }
  }

  private tellToResync(sub: Subscription): void {
    if (sub.signIn) {
      this.endSignIn(sub);
      return;
    }
    const event: CanopyHostEvent =
      sub.consumer === null
        ? { kind: "resync", hostId: sub.hostId }
        : { kind: "assistant-resync", hostId: sub.hostId, consumer: sub.consumer };
    if (!this.options.send(sub.webContentsId, event)) {
      this.releaseView(sub.webContentsId);
    }
  }

  /**
   * The sign-in's viewer went on its host, and its terminal with it: a link
   * that dropped, or a lost push. Its stream says it ended, and nothing of it
   * is opened again.
   */
  private endSignIn(sub: Subscription): void {
    const signIn = sub.signIn;
    if (!signIn || this.byViewer.get(sub.viewerId) !== sub) return;
    this.drop(sub);
    const record = this.views.get(sub.webContentsId);
    if (record) this.forgetIfEmpty(sub.webContentsId, record);
    if (signIn.terminalId === null || signIn.watchId === null) return;
    this.options.send(sub.webContentsId, {
      kind: "sign-in-terminal-data",
      hostId: sub.hostId,
      consumer: sub.consumer as string,
      chunk: { kind: "ended", watchId: signIn.watchId, runId: signIn.terminalId },
    });
  }

  private dropRemovedHosts(): void {
    for (const sub of [...this.byViewer.values()]) {
      if (isLocalHostId(sub.hostId) || this.options.registry.get(sub.hostId)) continue;
      this.drop(sub);
      const record = this.views.get(sub.webContentsId);
      if (record) this.forgetIfEmpty(sub.webContentsId, record);
    }
  }
}

const SIGN_IN_GRID_MAX = 1_000;

function isGridSize(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= SIGN_IN_GRID_MAX;
}

/** The step as the view asked it, never with anything else riding along to the host. */
function signInStepOf(step: unknown): HostSignInStep {
  const raw = (typeof step === "object" && step !== null ? step : {}) as Record<string, unknown>;
  const watchId = raw.watchId;
  const hasWatch = Number.isSafeInteger(watchId);
  switch (raw.op) {
    case "watch":
      return { op: "watch" };
    case "input":
      if (hasWatch && typeof raw.data === "string" && raw.data.length > 0) {
        return { op: "input", watchId: watchId as number, data: raw.data };
      }
      break;
    case "resize":
      if (hasWatch && isGridSize(raw.cols) && isGridSize(raw.rows)) {
        return { op: "resize", watchId: watchId as number, cols: raw.cols, rows: raw.rows };
      }
      break;
    case "unwatch":
      if (hasWatch) return { op: "unwatch", watchId: watchId as number };
      break;
  }
  throw invalid("Invalid sign-in step");
}

function offerKey(webContentsId: number, consumer: string): string {
  return `${webContentsId}:${consumer}`;
}

/** Why a sign-in started for an assistant didn't start, by the error its start ended in. */
function signInOfferFailure(error: unknown): SignInOfferAnswer {
  switch (codeOf(error)) {
    case "UNSUPPORTED":
      return "unsupported";
    // A link that drops ends the sign-ins on it, a start in flight included.
    case "HOST_DISCONNECTED":
    case "OUTCOME_UNKNOWN":
      return "disconnected";
    case "RATE_LIMITED":
      return "rate_limited";
    // Its viewer went while it started: the view, the link or the host.
    case "NOT_FOUND":
    case "CANCELLED":
      return "withdrawn";
    default:
      return "failed";
  }
}

function consumerOf(consumer: unknown): string {
  if (!isCanopyViewerId(consumer)) throw invalid("consumer must be a short id");
  return consumer;
}

function assistantEntries(directory: AgentDirectory): AgentDirectory {
  return { ...directory, entries: directory.entries.filter((entry) => entry.role === "assistant") };
}
