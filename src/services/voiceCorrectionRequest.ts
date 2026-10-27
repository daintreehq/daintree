import type { VoiceContext } from "@/services/canopyReplyDictation";
import type { CorrectionPassage } from "@/services/voiceCorrectionPassages";
import { recentPromptsFor } from "@/services/voiceRecentPrompts";
import type { DictationTextSpan } from "@/store/dictationRangeStore";

/** One passage's cleanup request to main, less the stream its progress comes back on. */
export interface CorrectionRequest {
  rawText: string;
  terminalId?: string;
  outsideView?: true;
  recentContext?: string[];
  recentPrompts?: string[];
  startsPrompt: boolean;
  sessionId?: string;
  uncertain?: DictationTextSpan[];
}

/**
 * The request a passage is cleaned up with. The stop's pass and a pause's
 * prefetch both build it here, so a stop that changed nothing sends exactly
 * what the prefetch did and main can hand it the reply already on its way.
 * The recent prompts are read as it is built, so a prompt sent while the
 * dictation ran counts, and one sent after a prefetch makes the stop's differ.
 * A terminal outside the view names none.
 */
export function correctionRequest(
  passage: CorrectionPassage,
  context: VoiceContext,
  sessionId: string | null
): CorrectionRequest {
  const recentPrompts = context.terminalId ? recentPromptsFor(context.terminalId) : [];
  return {
    rawText: passage.text,
    ...context,
    ...(passage.context ? { recentContext: [passage.context] } : {}),
    ...(recentPrompts.length > 0 ? { recentPrompts } : {}),
    startsPrompt: passage.startsPrompt,
    ...(sessionId ? { sessionId } : {}),
    ...(passage.uncertain ? { uncertain: passage.uncertain } : {}),
  };
}
