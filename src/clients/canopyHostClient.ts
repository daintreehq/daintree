import type {
  AssistantViewerChannel,
  CanopyHostChannel,
  CanopyHostEvent,
  HostAssistantDirectory,
  HostSignInStep,
  HostSignInTerminal,
} from "@shared/types/ipc/canopyHost";
import type { AssistantOpenDestination, CanopyTerminalView } from "@shared/types/ipc/canopy";
import type { AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { AssistantWorkReading } from "@shared/types/assistantWork";
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

  /** Which of a host's workers an assistant made or holds; a host without it says so. */
  readAssistantWork: (hostId: string): Promise<AssistantWorkReading> => {
    return window.electron.canopyHost.readAssistantWork(hostId);
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

  /**
   * Start an agent CLI's own sign-in in a terminal on a connected host, for
   * `consumer`; it runs until the consumer lets go of it.
   */
  startSignIn: (consumer: string, hostId: string, agentId: string): Promise<HostSignInTerminal> => {
    return window.electron.canopyHost.startSignIn(consumer, hostId, agentId);
  },

  /** Watch, type into, size or let go of the consumer's sign-in terminal. */
  signInStep: (consumer: string, step: HostSignInStep): Promise<CanopyTerminalView | null> => {
    return window.electron.canopyHost.signInStep(consumer, step);
  },

  /** The consumer closed its sign-in: the host ends its terminal. */
  releaseSignIn: (consumer: string): Promise<void> => {
    return window.electron.canopyHost.releaseSignIn(consumer);
  },

  /**
   * The consumer's dialog opened, live, a sign-in started for an assistant
   * (#18197); its call answers with that.
   */
  signInShown: (consumer: string): Promise<void> => {
    return window.electron.canopyHost.signInShown(consumer);
  },

  /** Every host's pushes, each tagged with the host it came from. */
  onEvent: (callback: (event: CanopyHostEvent) => void): (() => void) => {
    return window.electron.canopyHost.onEvent(callback);
  },
} as const;
