import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { IpcEnvelope } from "../../shared/types/ipc/errors.js";
import { isIpcEnvelope } from "../../shared/types/ipc/errors.js";
import { deserializeError, wrapError } from "../../shared/utils/ipcErrorSerialization.js";
import { AppError } from "../utils/errorTypes.js";
import { getChannelLocality } from "./channelLocality.js";
import type {
  EndpointInvocation,
  HybridSplit,
  InvokeListener,
  IpcDispatcher,
  RemoteRouter,
  SendListener,
} from "./endpoint.js";
import type { IpcContext } from "./types.js";

/**
 * Produces the IPC envelope for one invocation: arg-count and payload budget
 * checks, fault injection, success wrapping and the packaged-build error
 * sanitiser. Installed by the sender-validation setup so an `ipcMain` call and
 * a link call share a single envelope path. With `verbatim`, `call` resolves
 * to an envelope that is returned as-is (a host's answer is never re-wrapped).
 */
export type InvokeEnveloper = (
  channel: string,
  args: unknown[],
  call: () => unknown,
  options?: { verbatim?: boolean }
) => Promise<IpcEnvelope>;

type LocalInvokeListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type LocalSendListener = (event: IpcMainEvent, ...args: unknown[]) => unknown;

function notRemotable(channel: string, reason: string): AppError {
  return new AppError({
    code: "CHANNEL_NOT_REMOTABLE",
    message: `Channel ${channel} ${reason}`,
    context: { channel },
  });
}

const unconfiguredEnveloper: InvokeEnveloper = async (channel) =>
  wrapError(
    new AppError({
      code: "INTERNAL",
      message: `IPC envelope is not configured; refusing ${channel}`,
    })
  );

async function unwrapForwarded(envelope: Promise<IpcEnvelope>): Promise<unknown> {
  const result = await envelope;
  if (!isIpcEnvelope(result)) {
    throw new AppError({ code: "INTERNAL", message: "Host returned a malformed IPC envelope" });
  }
  if (!result.ok) throw deserializeError(result.error);
  return result.data;
}

export class IpcDispatcherImpl implements IpcDispatcher<IpcContext> {
  private readonly invokeListeners = new Map<string, InvokeListener<IpcContext>>();
  private readonly sendListeners = new Map<string, Set<SendListener<IpcContext>>>();
  private readonly hybridSplits = new Map<string, HybridSplit>();
  // Hybrid channels a link may call on this host. Opt-in: a hybrid handler
  // reads Shell-side state too, so answering it wholesale for a remote Shell
  // would leak this machine's half of the merge.
  private readonly linkHybrids = new Map<string, number>();
  private router: RemoteRouter | null = null;
  private enveloper: InvokeEnveloper = unconfiguredEnveloper;
  // Several ipcMain.on listeners can share one channel; a forwarded send must
  // leave this process once per message, not once per listener.
  private readonly routedSendEvents = new WeakSet<object>();

  registerInvoke(channel: string, listener: InvokeListener<IpcContext>): () => void {
    this.invokeListeners.set(channel, listener);
    return () => {
      if (this.invokeListeners.get(channel) === listener) this.invokeListeners.delete(channel);
    };
  }

  registerSend(channel: string, listener: SendListener<IpcContext>): () => void {
    let listeners = this.sendListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.sendListeners.set(channel, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.sendListeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.sendListeners.delete(channel);
    };
  }

  hasInvoke(channel: string): boolean {
    return this.invokeListeners.has(channel);
  }

  setInvokeEnveloper(enveloper: InvokeEnveloper | null): void {
    this.enveloper = enveloper ?? unconfiguredEnveloper;
  }

  setRemoteRouter(router: RemoteRouter | null): void {
    this.router = router;
  }

  registerHybridSplit(channel: string, split: HybridSplit): () => void {
    this.hybridSplits.set(channel, split);
    return () => {
      if (this.hybridSplits.get(channel) === split) this.hybridSplits.delete(channel);
    };
  }

  /**
   * Admit a hybrid channel for link calls: the host-side leg of a split. The
   * returned disposer drops the admission once every caller has released it.
   */
  allowHybridOverLink(channel: string): () => void {
    this.linkHybrids.set(channel, (this.linkHybrids.get(channel) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.linkHybrids.get(channel) ?? 0) - 1;
      if (count > 0) this.linkHybrids.set(channel, count);
      else this.linkHybrids.delete(channel);
    };
  }

  /**
   * A call that arrived over a link. Only handlers registered with a context
   * signature can serve it: a raw `ipcMain.handle` listener needs a real
   * `IpcMainInvokeEvent`, which a remote endpoint cannot provide. Shell and
   * unclassified channels have no meaning on a host and are refused, as are
   * hybrid channels no split has admitted via {@link allowHybridOverLink}.
   */
  invokeForEndpoint(
    invocation: EndpointInvocation,
    channel: string,
    args: unknown[]
  ): Promise<IpcEnvelope> {
    const listener = this.invokeListeners.get(channel);
    const refusal = this.refuseOverLink(channel, listener !== undefined);
    if (refusal) {
      return this.enveloper(channel, args, () => {
        throw refusal;
      });
    }
    const ctx = buildEndpointContext(invocation);
    return this.enveloper(channel, args, () => listener!(ctx, ...args));
  }

  sendForEndpoint(invocation: EndpointInvocation, channel: string, args: unknown[]): void {
    const listeners = this.sendListeners.get(channel);
    const refusal = this.refuseOverLink(channel, listeners !== undefined && listeners.size > 0);
    if (refusal) {
      console.warn(`[IPC] Dropped link send: ${refusal.message}`);
      return;
    }
    const ctx = buildEndpointContext(invocation);
    void this.enveloper(channel, args, () => {
      for (const listener of [...listeners!]) listener(ctx, ...args);
    }).then((envelope) => {
      if (!envelope.ok) {
        console.warn(`[IPC] Link send on ${channel} failed: ${envelope.error.message}`);
      }
    });
  }

  private refuseOverLink(channel: string, registered: boolean): AppError | null {
    const locality = getChannelLocality(channel);
    if (locality === null) return notRemotable(channel, "is not classified");
    if (locality === "shell") return notRemotable(channel, "is answered by the Shell, not a host");
    if (locality === "hybrid" && !this.linkHybrids.has(channel)) {
      return notRemotable(channel, "is hybrid and not admitted for link calls");
    }
    if (!registered) return notRemotable(channel, "has no context handler on this host");
    return null;
  }

  /**
   * Entry point for every `ipcMain` invoke after sender validation. With no
   * router installed, or a sender that is not bound to a remote host, the
   * local listener runs exactly as before.
   */
  dispatchLocalInvoke(
    channel: string,
    event: IpcMainInvokeEvent,
    args: unknown[],
    listener: LocalInvokeListener
  ): Promise<IpcEnvelope> {
    const runLocal = () => listener(event, ...args);
    const router = this.router;
    const hostId = router ? router.hostForSender(event.sender.id) : null;
    if (router === null || hostId === null) return this.enveloper(channel, args, runLocal);

    const webContentsId = event.sender.id;
    const locality = getChannelLocality(channel);
    switch (locality) {
      case "host":
        return this.enveloper(
          channel,
          args,
          () => router.forwardInvoke(hostId, webContentsId, channel, args),
          { verbatim: true }
        );
      case "shell":
        return this.enveloper(channel, args, runLocal);
      case "hybrid": {
        const split = this.hybridSplits.get(channel);
        if (!split) {
          return this.enveloper(channel, args, () => {
            throw notRemotable(channel, "is hybrid and has no split for a remote-bound window");
          });
        }
        return this.enveloper(channel, args, () =>
          split({
            hostId,
            webContentsId,
            args,
            local: async (replacement) => listener(event, ...(replacement ?? args)),
            remote: (remoteChannel, replacement) =>
              unwrapForwarded(
                router.forwardInvoke(
                  hostId,
                  webContentsId,
                  remoteChannel ?? channel,
                  replacement ?? args
                )
              ),
          })
        );
      }
      default:
        return this.enveloper(channel, args, () => {
          throw notRemotable(channel, "is not classified");
        });
    }
  }

  /**
   * Entry point for every `ipcMain.on` message after sender validation.
   * Hybrid sends stay local: a split merges a result, which a fire-and-forget
   * message does not have, so splits apply to invokes only.
   */
  dispatchLocalSend(
    channel: string,
    event: IpcMainEvent,
    args: unknown[],
    listener: LocalSendListener
  ): unknown {
    const router = this.router;
    const hostId = router ? router.hostForSender(event.sender.id) : null;
    if (router === null || hostId === null) return listener(event, ...args);

    const locality = getChannelLocality(channel);
    if (locality === "shell" || locality === "hybrid") return listener(event, ...args);
    if (this.routedSendEvents.has(event)) return undefined;
    this.routedSendEvents.add(event);
    if (locality === "host") {
      router.forwardSend(hostId, event.sender.id, channel, args);
      return undefined;
    }
    console.warn(`[IPC] Dropped send on unclassified channel ${channel} from a remote-bound view`);
    return undefined;
  }
}

function buildEndpointContext(invocation: EndpointInvocation): IpcContext {
  const { endpoint, client } = invocation;
  return {
    event: null,
    senderWindow: null,
    webContentsId: endpoint.handle,
    projectId: endpoint.projectId,
    endpoint,
    client,
  };
}

let dispatcher: IpcDispatcherImpl | null = null;

export function getIpcDispatcher(): IpcDispatcherImpl {
  dispatcher ??= new IpcDispatcherImpl();
  return dispatcher;
}

/** @internal Tests only. */
export function _resetIpcDispatcherForTesting(): void {
  dispatcher = null;
}
