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

/** Where main reads a dictation's terminal, vocabulary and file links from. */
export interface VoiceContext {
  terminalId?: string;
  /** Typed to another host: nothing of this machine's belongs in the text. */
  otherHost?: true;
}

export function voiceContext(target: VoiceRecordingTarget): VoiceContext {
  if (!isCanopyReplyTarget(target)) return { terminalId: target.panelId };
  if (target.otherHostId !== undefined) return { otherHost: true };
  return target.terminalId !== undefined ? { terminalId: target.terminalId } : {};
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

export const NO_CANOPY_REPLY: CanopyReplyDictation = {
  ok: false,
  message: "Select an agent in Canopy to dictate a reply to it.",
};

/** With no inbox showing (still loading, or Canopy is off), there is no reply to dictate into. */
export function resolveCanopyReplyDictation(): CanopyReplyDictation {
  return resolver?.() ?? NO_CANOPY_REPLY;
}
