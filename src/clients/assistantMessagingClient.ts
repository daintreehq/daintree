import type {
  AssistantMessagingChangedEvent,
  AssistantMessagingEnrollResult,
  AssistantMessagingLaneRef as LaneRef,
  AssistantMessagingState,
} from "@shared/types/ipc/assistantMessaging";

export const assistantMessagingClient = {
  /** False in a renderer whose preload predates the namespace (and in partial test bridges). */
  isAvailable: (): boolean => {
    return typeof window !== "undefined" && window.electron?.assistantMessaging !== undefined;
  },

  getState: (lane: LaneRef): Promise<AssistantMessagingState> => {
    return window.electron.assistantMessaging.getState(lane);
  },

  setLaneEnrolled: (
    lane: LaneRef & { enrolled: boolean }
  ): Promise<AssistantMessagingEnrollResult> => {
    return window.electron.assistantMessaging.setLaneEnrolled(lane);
  },

  setPaused: (paused: boolean): Promise<boolean> => {
    return window.electron.assistantMessaging.setPaused(paused);
  },

  onChanged: (callback: (event: AssistantMessagingChangedEvent) => void): (() => void) => {
    return window.electron.assistantMessaging.onChanged(callback);
  },
} as const;
