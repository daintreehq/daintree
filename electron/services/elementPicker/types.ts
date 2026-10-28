import type { ElementPickerPushPayload } from "../../../shared/types/ipc/elementPicker.js";

/**
 * Where a core picker binding's traffic goes: the bridge's lifecycle events,
 * the page's admitted events, and what the host itself did about them.
 */
export type { ElementPickerPushPayload };

export type ElementPickerSink = (payload: ElementPickerPushPayload) => void;
