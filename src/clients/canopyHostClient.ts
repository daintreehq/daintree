import type {
  AssistantViewerChannel,
  CanopyHostChannel,
  CanopyHostEvent,
  HostAssistantDirectory,
} from "@shared/types/ipc/canopyHost";
import type { AssistantOpenDestination, CanopyTerminalView } from "@shared/types/ipc/canopy";
import type { AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { IpcInvokeMap } from "@shared/types/ipc/maps";

/**
 * Canopy on a host the view names that isn't its own: This Mac from a remote
 * window, or another connected host. The view's own host is read through
 * `window.electron.canopy`, exactly as before; naming it here is refused.
 */
export const canopyHostClient = {
  invoke: <C extends CanopyHostChannel>(
    hostId: string,
    channel: C,
    ...args: IpcInvokeMap[C]["args"]
  ): Promise<IpcInvokeMap[C]["result"]> => {
    return window.electron.canopyHost.invoke(hostId, channel, args) as Promise<
      IpcInvokeMap[C]["result"]
    >;
  },

  /** The panel stopped reading the host: its open state, scope and watch there end. */
  release: (hostId: string): Promise<void> => {
    return window.electron.canopyHost.release(hostId);
  },

  /** A host's assistants, for a person's picker; a host without the viewer says so. */
  listAssistants: (hostId: string, projectId?: string): Promise<HostAssistantDirectory> => {
    return window.electron.canopyHost.listAssistants(hostId, projectId);
  },

  /** Stream the assistant `consumer` shows, by its exact subject, on its own host. */
  watchAssistant: (
    consumer: string,
    subject: AgentDirectorySubject
  ): Promise<CanopyTerminalView> => {
    return window.electron.canopyHost.watchAssistant(consumer, subject);
  },

  resolveAssistant: (
    consumer: string,
    subject: AgentDirectorySubject
  ): Promise<AssistantOpenDestination | null> => {
    return window.electron.canopyHost.resolveAssistant(consumer, subject);
  },

  /** Typing to, keying or ending the consumer's stream; each answers nothing. */
  assistantInvoke: <
    C extends Exclude<
      AssistantViewerChannel,
      "canopy:watch-assistant-terminal" | "canopy:resolve-assistant"
    >,
  >(
    consumer: string,
    channel: C,
    ...args: IpcInvokeMap[C]["args"]
  ): Promise<void> => {
    return window.electron.canopyHost.assistantInvoke(consumer, channel, args).then(() => {});
  },

  /** The consumer stopped showing its assistant: its viewer and watch end. */
  releaseAssistant: (consumer: string): Promise<void> => {
    return window.electron.canopyHost.releaseAssistant(consumer);
  },

  /** Every host's pushes, each tagged with the host it came from. */
  onEvent: (callback: (event: CanopyHostEvent) => void): (() => void) => {
    return window.electron.canopyHost.onEvent(callback);
  },
} as const;
