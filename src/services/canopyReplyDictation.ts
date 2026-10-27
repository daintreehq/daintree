import { isolatedComposerScope, makeDraftKey } from "@/lib/draftKey";
import type { VoiceRecordingTarget } from "@/store/voiceRecordingStore";

/**
 * Marks a surface inside an isolated pane that takes the dictation key itself:
 * Canopy's agent pane, which routes it to the selected row's reply.
 */
export const DICTATION_OWNER_ATTR = "data-dictation-owner";

/**
 * A Canopy reply's dictation is its own, apart from the pane composer typing to
 * the same terminal: its id is the reply's draft key, so what the voice service
 * writes under it, with no project, lands in the reply's own draft.
 */
export function canopyReplyVoiceId(runId: string, otherHostId?: string): string {
  return makeDraftKey(runId, isolatedComposerScope(otherHostId));
}

export function isCanopyReplyTarget(target: VoiceRecordingTarget | null | undefined): boolean {
  return target?.surface === "canopy-reply";
}

/** The terminal main reads a dictation's context from: none for another host's. */
export function voiceContextTerminalId(target: VoiceRecordingTarget): string | undefined {
  return isCanopyReplyTarget(target) ? target.terminalId : target.panelId;
}

export type CanopyReplyDictation =
  | {
      ok: true;
      target: VoiceRecordingTarget;
      /** Puts the keyboard in the reply, once it is ready to take it. */
      focus: () => void;
    }
  | { ok: false; message: string };

type Resolver = () => CanopyReplyDictation;

let resolver: Resolver | null = null;

/** The open Canopy view says where the dictation key goes. One view at a time. */
export function registerCanopyReplyDictation(next: Resolver): () => void {
  resolver = next;
  return () => {
    if (resolver === next) resolver = null;
  };
}

/** Null while Canopy is open but its view hasn't loaded yet. */
export function resolveCanopyReplyDictation(): CanopyReplyDictation | null {
  return resolver?.() ?? null;
}
