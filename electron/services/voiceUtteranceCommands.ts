/**
 * Spoken commands read over a whole utterance, however the provider cut it into
 * segments (#14801).
 *
 * A long utterance finalises as several segments, so a command can straddle two
 * ("…send" then "it."), sit in a segment before the one that ends speech, or be
 * cut just after its name ("…a new line" then "inside quoted strings"). The
 * renderer can't take words back, so a segment whose meaning still depends on
 * what comes next is held here, its preview still showing, until the utterance
 * says what it was. A pause ends what was said, so break commands are read
 * there; only end of speech can carry a send.
 */
import {
  pendingCommandStart,
  trailingDictationCommands,
  trailingSendCommand,
} from "./voiceDictationCommands.js";
import {
  classifySpokenCommandOpening,
  rewriteSpokenCommand,
  type VoiceCommandVocabulary,
} from "../../shared/utils/voiceAgentCommands.js";
import {
  shiftSpans,
  sliceSpans,
  type VoiceTextSpan,
} from "../../shared/utils/voiceUncertainWords.js";

export interface UtteranceSegment {
  itemId?: string;
  text: string;
  /** The words in `text` the provider was unsure of. */
  uncertain?: readonly VoiceTextSpan[];
}

export interface UtteranceBoundary {
  /** The speaker went quiet after it: the only boundary a send may end on. */
  endOfSpeech: boolean;
  /** The provider closed it at a pause, though the speaker may have gone on since. */
  endsAtPause: boolean;
}

export interface UtteranceOptions {
  /** Break commands and "send it" are read; the opening command is read regardless. */
  spokenCommands: boolean;
  vocabulary: VoiceCommandVocabulary | null;
}

/** One completion for the renderer: a provider item's text as it lands. */
export interface UtteranceEmission {
  itemId?: string;
  /** Break commands already written as line breaks. */
  text: string;
  /** The unsure words that survived into `text`, where they sit in it. */
  uncertain: VoiceTextSpan[];
  /** It opens the utterance, so a spoken command it starts with is written as one. */
  opensUtterance?: true;
}

export interface UtteranceRelease {
  /** In order; a send rides the last. Items a command swallowed retire with no text. */
  emissions: UtteranceEmission[];
  send: boolean;
  /** The same items with "send it" kept as words, for a send the speaker talked over. */
  literal: UtteranceEmission[] | null;
}

interface HeldSegment {
  itemId?: string;
  text: string;
  uncertain: readonly VoiceTextSpan[];
}

const PIECE_BREAK_RE = /\s*\n\s*/;

function firstPiece(text: string): string {
  return text.split(PIECE_BREAK_RE)[0]!.trim();
}

export class UtteranceCommands {
  // The utterance's words the renderer already has, as heard. A send is read
  // with the clause they opened, and a command never opens after them.
  private said = "";
  private held: HeldSegment[] = [];

  push(
    segment: UtteranceSegment,
    boundary: UtteranceBoundary,
    options: UtteranceOptions
  ): UtteranceRelease | null {
    const text = segment.text.trim();
    const lead = segment.text.length - segment.text.trimStart().length;
    // An empty segment with no item only marks the boundary.
    if (text || segment.itemId) {
      this.held.push({
        ...(segment.itemId ? { itemId: segment.itemId } : {}),
        text,
        uncertain: sliceSpans(segment.uncertain ?? [], lead, lead + text.length),
      });
    }
    const pause = boundary.endOfSpeech || boundary.endsAtPause;
    if (this.held.length === 0) {
      if (boundary.endOfSpeech) this.said = "";
      return null;
    }
    // "Slash" and a pause, then "compact": the name is still to come, even
    // after the pause.
    const opening = this.opening(options);
    if (opening === "pending" || (opening === "extendable" && !pause)) return null;
    if (pause) {
      return this.release(
        this.held.length,
        {
          send: boundary.endOfSpeech,
          breaks: true,
          endsUtterance: boundary.endOfSpeech,
        },
        options
      );
    }
    // Cut mid-speech: what comes before a command still being said goes out
    // as words. An opening command goes out whole, so it waits with it.
    const pendingAt = options.spokenCommands ? pendingCommandStart(this.layout().full) : -1;
    if (pendingAt < 0) return this.release(this.held.length, LITERAL, options);
    if (opening !== "none") return null;
    const { starts } = this.layout();
    let stable = 0;
    while (
      stable < this.held.length &&
      starts[stable]! + this.held[stable]!.text.length <= pendingAt
    ) {
      stable++;
    }
    return stable > 0 ? this.release(stable, LITERAL, options) : null;
  }

  /**
   * Lets go of everything held. A stop ends what was said, so break commands
   * are read; a lost connection or failed provider keeps the words as said.
   * Neither carries a send: only end of speech can.
   */
  flush(mode: "stop" | "literal", options: UtteranceOptions): UtteranceRelease | null {
    if (this.held.length === 0) {
      this.said = "";
      return null;
    }
    return this.release(
      this.held.length,
      { send: false, breaks: mode === "stop", endsUtterance: true },
      options
    );
  }

  clear(): void {
    this.held = [];
    this.said = "";
  }

  private opening(options: UtteranceOptions) {
    if (this.said || !options.vocabulary) return "none";
    return classifySpokenCommandOpening(
      this.held.map((segment) => segment.text).join(" "),
      options.vocabulary
    );
  }

  /** The utterance as heard, with where each held segment starts in it. */
  private layout(count = this.held.length): { full: string; starts: number[] } {
    let full = this.said;
    const starts: number[] = [];
    for (const segment of this.held.slice(0, count)) {
      if (segment.text && full) full += " ";
      starts.push(full.length);
      full += segment.text;
    }
    return { full, starts };
  }

  private release(
    count: number,
    decide: { send: boolean; breaks: boolean; endsUtterance: boolean },
    options: UtteranceOptions
  ): UtteranceRelease {
    const segments = this.held.slice(0, count);
    const { full, starts } = this.layout(count);
    const opens = this.said === "";
    const open = (emissions: UtteranceEmission[]) =>
      opens ? openUtterance(emissions, options.vocabulary) : emissions;
    // Words the renderer already has can open a command's clause, but never
    // be the command: one they ended in was read, or kept as words, then.
    const held = this.said.length;
    let cut = full.length;
    let send = false;
    if (decide.send && options.spokenCommands) {
      const command = trailingSendCommand(full);
      if (command && command.phraseAt >= held) {
        cut = command.cut;
        send = true;
      }
    }
    const read = (end: number) => {
      const text = full.slice(0, end);
      const chain =
        decide.breaks && options.spokenCommands ? trailingDictationCommands(text) : null;
      const wordAt = chain ? chain.start + text.slice(chain.start).search(/\S/) : -1;
      return chain && wordAt >= held
        ? { cut: Math.max(chain.start, held), replacement: chain.replacement }
        : { cut: Math.max(end, held), replacement: "" };
    };
    const decided = read(cut);
    const emissions = open(edit(segments, starts, decided));
    const literal = send ? open(edit(segments, starts, read(full.length))) : null;

    this.held = this.held.slice(count);
    // A break starts a new line of thought, so the next send reads its own clause.
    if (decide.endsUtterance || decided.replacement) {
      this.said = "";
    } else {
      const words = segments.map((segment) => segment.text).filter(Boolean);
      this.said = [this.said, ...words].filter(Boolean).join(" ");
    }
    return { emissions, send, literal };
  }
}

const LITERAL = { send: false, breaks: false, endsUtterance: false };

/**
 * Each segment's text once everything from `cut` on is replaced. The segment
 * the cut falls in takes the replacement and goes last, so a send rides its
 * words; segments wholly inside the command retire ahead of it.
 */
function edit(
  segments: readonly HeldSegment[],
  starts: readonly number[],
  { cut, replacement }: { cut: number; replacement: string }
): UtteranceEmission[] {
  let at = segments.findIndex((segment, i) => starts[i]! + segment.text.length > cut);
  if (at < 0) at = segments.length - 1;
  const emission = (i: number): UtteranceEmission => {
    const segment = segments[i]!;
    const id = segment.itemId ? { itemId: segment.itemId } : {};
    if (i < at) return { ...id, text: segment.text, uncertain: [...segment.uncertain] };
    if (i > at) return { ...id, text: "", uncertain: [] };
    const kept = Math.max(0, cut - starts[i]!);
    return {
      ...id,
      text: segment.text.slice(0, kept) + replacement,
      uncertain: sliceSpans(segment.uncertain, 0, kept),
    };
  };
  return [
    ...segments.slice(0, at).map((_, i) => emission(i)),
    ...segments.slice(at + 1).map((_, i) => emission(at + 1 + i)),
    emission(at),
  ];
}

/**
 * Marks where the utterance's words open, for its spoken command. One whose
 * command spans segments ("Slash." then "compact.") goes out as a single
 * completion with all of their words, the others retiring ahead of it.
 */
function openUtterance(
  emissions: UtteranceEmission[],
  vocabulary: VoiceCommandVocabulary | null
): UtteranceEmission[] {
  const worded = emissions.filter((emission) => emission.text);
  const first = worded[0];
  if (!first || !vocabulary) return emissions;
  const joined = worded.map((emission) => emission.text).join(" ");
  const command = worded.length > 1 ? rewriteSpokenCommand(firstPiece(joined), vocabulary) : null;
  const spansSegments =
    command !== null && command !== rewriteSpokenCommand(firstPiece(first.text), vocabulary);
  if (!spansSegments) {
    return emissions.map((emission) =>
      emission === first ? { ...first, opensUtterance: true } : emission
    );
  }
  let offset = 0;
  const uncertain = worded.flatMap((emission) => {
    const spans = shiftSpans(emission.uncertain, offset);
    offset += emission.text.length + 1;
    return spans;
  });
  return [
    ...emissions
      .filter((emission) => emission !== first)
      .map((emission) => ({
        ...(emission.itemId ? { itemId: emission.itemId } : {}),
        text: "",
        uncertain: [],
      })),
    { ...first, text: joined, uncertain, opensUtterance: true },
  ];
}
