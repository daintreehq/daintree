import { randomUUID } from "node:crypto";
import type { ClientRef } from "../../ipc/endpoint.js";
import {
  ASSISTANT_VIEWER_VERSION,
  isCanopyHostChannel,
  type AssistantViewerChannel,
  type CanopyHostEvent,
  type CanopyHostPushChannel,
  type HostAssistantDirectory,
} from "../../../shared/types/ipc/canopyHost.js";
import type {
  AssistantOpenDestination,
  CanopySnapshot,
  CanopyTerminalData,
  CanopyTerminalView,
} from "../../../shared/types/ipc/canopy.js";
import {
  AgentDirectorySubjectSchema,
  unreadAgentDirectory,
  type AgentDirectory,
  type AgentDirectoryEntry,
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
  CanopyLinkMethod,
  CanopyViewerLostPayloadSchema,
  isCanopyViewerId,
} from "./linkMethods.js";
import type { CanopyViewers } from "./viewer.js";

export interface CanopyHostConnection {
  callHost(method: string, payload: unknown): Promise<unknown>;
}

/** How often, and how far apart, a release the host didn't take is sent again. */
export const RELEASE_RETRIES = 5;
export const RELEASE_RETRY_MS = 1_000;

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
  readLocalAgents?: (options: { projectId?: string }) => Promise<AgentDirectory>;
  newViewerId?: () => string;
}

interface Subscription {
  webContentsId: number;
  hostId: HostId;
  viewerId: string;
  /** The assistant viewer's consumer in its view; null for the view's Canopy panel. */
  consumer: string | null;
}

interface ViewRecord {
  hosts: Map<HostId, Subscription>;
  /** Each assistant consumer's one viewer, on the host of the assistant it shows. */
  assistants: Map<string, Subscription>;
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
function directoryAs(hostId: HostId, directory: AgentDirectory): AgentDirectory {
  return {
    ...directory,
    entries: directory.entries.map((entry): AgentDirectoryEntry =>
      entry.state === "live"
        ? { ...entry, subject: { ...entry.subject, hostId } }
        : { ...entry, hostId }
    ),
  };
}

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
        ? await read(options).catch(() => unreadAgentDirectory("unreachable"))
        : unreadAgentDirectory("unsupported");
      return {
        hostId: LOCAL_HOST_ID,
        version: read ? ASSISTANT_VIEWER_VERSION : null,
        directory: directoryAs(LOCAL_HOST_ID, assistantEntries(directory)),
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
      directory: directoryAs(target, assistantEntries(answer.data.directory)),
    };
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
    const sub = this.subscribeAssistant(webContentsId, consumerOf(consumer), target);
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
    const sub = this.subscribeAssistant(webContentsId, consumerOf(consumer), target);
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
    if (record.hosts.size > 0 || record.assistants.size > 0) return;
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

  private subscribeAssistant(
    webContentsId: number,
    consumer: string,
    hostId: HostId
  ): Subscription {
    const record = this.recordOf(webContentsId);
    const existing = record.assistants.get(consumer);
    if (existing?.hostId === hostId) return existing;
    // Moving to an assistant on another host: the one it showed goes first.
    if (existing) this.drop(existing);
    const viewerId = this.options.newViewerId?.() ?? randomUUID();
    const sub: Subscription = { webContentsId, hostId, viewerId, consumer };
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
      const created: ViewRecord = { hosts: new Map(), assistants: new Map(), unwatch: () => {} };
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
      sub = { webContentsId, hostId, viewerId, consumer: null };
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
    else if (record?.assistants.get(sub.consumer) === sub) record.assistants.delete(sub.consumer);
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
    for (const sub of [...record.hosts.values(), ...record.assistants.values()]) this.drop(sub);
  }

  private onViewerEvent(hostId: HostId, event: EventMessage): void {
    const viewerId = event.endpointId?.slice(CANOPY_VIEWER_ENDPOINT_PREFIX.length);
    const sub = viewerId === undefined ? undefined : this.byViewer.get(viewerId);
    // Only the host the viewer was opened on speaks for it.
    if (!sub || sub.hostId !== hostId) return;
    const channel = event.channel;
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
    const event: CanopyHostEvent =
      sub.consumer === null
        ? { kind: "resync", hostId: sub.hostId }
        : { kind: "assistant-resync", hostId: sub.hostId, consumer: sub.consumer };
    if (!this.options.send(sub.webContentsId, event)) {
      this.releaseView(sub.webContentsId);
    }
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

function consumerOf(consumer: unknown): string {
  if (!isCanopyViewerId(consumer)) throw invalid("consumer must be a short id");
  return consumer;
}

function assistantEntries(directory: AgentDirectory): AgentDirectory {
  return { ...directory, entries: directory.entries.filter((entry) => entry.role === "assistant") };
}
