import type { ElementPickerPushPayload } from "../../../shared/types/ipc/elementPicker.js";

/**
 * Where a core picker binding's traffic goes: the bridge's lifecycle events,
 * the page's admitted events, and what the host itself did about them. Never
 * the plugin push channel, whose consumers expect the plugin protocol.
 */
export type { ElementPickerPushPayload };

export type ElementPickerSink = (payload: ElementPickerPushPayload) => void;
