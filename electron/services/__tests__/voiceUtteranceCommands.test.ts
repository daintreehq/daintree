import { describe, expect, it } from "vitest";
import {
  UtteranceCommands,
  type UtteranceBoundary,
  type UtteranceEmission,
  type UtteranceOptions,
  type UtteranceRelease,
} from "../voiceUtteranceCommands.js";
import { buildVoiceCommandVocabulary } from "../../../shared/utils/voiceAgentCommands.js";
import { getBuiltinSlashCommands } from "../../../shared/types/slashCommands.js";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";

const CUT: UtteranceBoundary = { endOfSpeech: false, endsAtPause: false };
const PAUSE: UtteranceBoundary = { endOfSpeech: false, endsAtPause: true };
const END: UtteranceBoundary = { endOfSpeech: true, endsAtPause: false };
const STOPPING_PAUSE: UtteranceBoundary = { ...PAUSE, stopping: true };

const dictation: UtteranceOptions = { spokenCommands: true, vocabulary: null };
const withCommands: UtteranceOptions = {
  spokenCommands: true,
  vocabulary: buildVoiceCommandVocabulary(
    getBuiltinSlashCommands("claude"),
    getAgentConfig("claude")!.completionSources!
  ),
};

type Segment = readonly [text: string, boundary: UtteranceBoundary];

function feed(segments: readonly Segment[], options = dictation) {
  const utterance = new UtteranceCommands();
  const releases = segments.map(([text, boundary], i) =>
    utterance.push({ itemId: `i${i}`, text }, boundary, options)
  );
  return { utterance, releases };
}

// Emissions as compared below: no unsure words, no field for them.
function shown(emissions: readonly UtteranceEmission[] | null | undefined) {
  return emissions?.map(({ uncertain, ...rest }) =>
    uncertain.length > 0 ? { ...rest, uncertain } : rest
  );
}

// What the draft gets: each emission's text in order, breaks as ¶, then ⏎ for a send.
function written(releases: ReadonlyArray<UtteranceRelease | null>): string {
  const tokens = releases.flatMap((release) => {
    if (!release) return [];
    const texts = release.emissions.map((emission) => emission.text.replace(/\s*\n+\s*/g, "¶"));
    return [...texts.filter(Boolean), ...(release.send ? ["⏎"] : [])];
  });
  return tokens.join(" ").replace(/ (?=[¶⏎])/g, "");
}

// Every way to cut `words` into segments mid-speech, the last ending speech
// unless a stop ends it instead.
function segmentations(sentence: string, last = END): Segment[][] {
  const words = sentence.split(" ");
  const results: Segment[][] = [];
  for (let mask = 0; mask < 1 << (words.length - 1); mask++) {
    const segments: string[] = [];
    let current = words[0]!;
    for (let i = 1; i < words.length; i++) {
      if (mask & (1 << (i - 1))) {
        segments.push(current);
        current = words[i]!;
      } else {
        current += ` ${words[i]}`;
      }
    }
    segments.push(current);
    results.push(segments.map((text, i) => [text, i === segments.length - 1 ? last : CUT]));
  }
  return results;
}

describe("UtteranceCommands — however the provider cut the utterance", () => {
  it.each([
    [
      "sends a 'send it' that ends the utterance",
      "Fix the login bug send it.",
      "Fix the login bug⏎",
    ],
    [
      "keeps a 'new line' mid-sentence as words",
      "Make the parser accept a new line inside quoted strings.",
      "Make the parser accept a new line inside quoted strings.",
    ],
    [
      "breaks on a 'new paragraph' that ends what was said",
      "Fix the bug new paragraph",
      "Fix the bug¶",
    ],
    [
      "keeps a 'send it' the speaker went on past as words",
      "then send it to the API",
      "then send it to the API",
    ],
    ["breaks, then sends, on a chain closing the utterance", "hello new line send it", "hello¶⏎"],
    ["breaks on a command run up against punctuation", "Fix this—new line", "Fix this—¶"],
  ])("%s", (_, sentence, expected) => {
    for (const segments of segmentations(sentence)) {
      expect(written(feed(segments).releases), JSON.stringify(segments)).toBe(expected);
    }
    // A stop is end of speech too: nothing more is coming (#14803).
    for (const segments of segmentations(sentence, CUT)) {
      const { utterance, releases } = feed(segments);
      const stopped = [...releases, utterance.flush("stop", dictation)];
      expect(written(stopped), `stop: ${JSON.stringify(segments)}`).toBe(expected);
    }
  });
});

describe("UtteranceCommands — holding and releasing", () => {
  it("lands a segment at once when nothing at its end could be a command", () => {
    const { releases } = feed([["fix the login", CUT]]);
    expect(shown(releases[0]?.emissions)).toEqual([{ itemId: "i0", text: "fix the login" }]);
  });

  it("lets an earlier held 'new line' go as words while a later command waits", () => {
    const { releases } = feed([
      ["fix it new line", CUT],
      ["and add the new", CUT],
    ]);
    expect(releases[0]).toBeNull();
    expect(shown(releases[1]?.emissions)).toEqual([{ itemId: "i0", text: "fix it new line" }]);
    expect(releases[1]).toMatchObject({ send: false, literal: null });
  });

  it("retires the items a send swallowed ahead of the one carrying it", () => {
    const { releases } = feed([
      ["Fix the login bug, send", CUT],
      ["it.", END],
    ]);
    expect(shown(releases[1]?.emissions)).toEqual([
      { itemId: "i1", text: "" },
      { itemId: "i0", text: "Fix the login bug" },
    ]);
    expect(releases[1]?.send).toBe(true);
    expect(shown(releases[1]?.literal)).toEqual([
      { itemId: "i0", text: "Fix the login bug, send" },
      { itemId: "i1", text: "it." },
    ]);
  });

  it("sends when only a bare end of speech closes the utterance", () => {
    const utterance = new UtteranceCommands();
    expect(utterance.push({ itemId: "i0", text: "Fix it, send it." }, CUT, dictation)).toBeNull();
    const release = utterance.push({ text: "" }, END, dictation);
    expect(shown(release?.emissions)).toEqual([{ itemId: "i0", text: "Fix it" }]);
    expect(release?.send).toBe(true);
    expect(utterance.flush("stop", dictation)).toBeNull();
  });

  it("breaks at a pause the speaker talked past, but never sends there", () => {
    const { releases } = feed([
      ["fix the bug new line", PAUSE],
      ["then send it", PAUSE],
    ]);
    expect(written(releases)).toBe("fix the bug¶ then send it");
  });

  it("never reads a command out of words that already landed", () => {
    const { releases } = feed([
      ["Fix the login bug, send it", PAUSE],
      ["", END],
    ]);
    expect(written(releases)).toBe("Fix the login bug, send it");
    expect(releases[1]).toMatchObject({ emissions: [{ itemId: "i1", text: "" }], send: false });
  });

  it("reads a send with the clause earlier segments opened", () => {
    expect(
      written(
        feed([
          ["Where should the handler", CUT],
          ["send it", END],
        ]).releases
      )
    ).toBe("Where should the handler send it");
    expect(
      written(
        feed([
          ["Don't", CUT],
          ["send it", END],
        ]).releases
      )
    ).toBe("Don't send it");
  });

  it("starts the next utterance's clause afresh after an end of speech", () => {
    const utterance = new UtteranceCommands();
    utterance.push({ itemId: "i0", text: "Where should the handler" }, CUT, dictation);
    utterance.push({ text: "" }, END, dictation);
    const release = utterance.push({ itemId: "i1", text: "send it" }, END, dictation);
    expect(release?.send).toBe(true);
  });

  it("reads break commands when a stop ends what was said, and sends nothing past them", () => {
    const { utterance } = feed([["Fix the bug, send it new line", CUT]]);
    const release = utterance.flush("stop", dictation);
    expect(shown(release?.emissions)).toEqual([{ itemId: "i0", text: "Fix the bug, send it\n" }]);
    expect(release?.send).toBe(false);
  });

  it("sends a trailing 'send it' when a stop ends what was said", () => {
    const { utterance } = feed([
      ["Fix the bug, send", CUT],
      ["it.", CUT],
    ]);
    const release = utterance.flush("stop", dictation);
    expect(shown(release?.emissions)).toEqual([
      { itemId: "i1", text: "" },
      { itemId: "i0", text: "Fix the bug" },
    ]);
    expect(release?.send).toBe(true);
    expect(shown(release?.literal)).toEqual([
      { itemId: "i0", text: "Fix the bug, send" },
      { itemId: "i1", text: "it." },
    ]);
  });

  it("keeps a 'send it' that belongs to the sentence as words at a stop", () => {
    for (const sentence of [
      "Where should the handler send it",
      "Don't send it.",
      "Let me review it before you send it",
    ]) {
      const { utterance } = feed([[sentence, CUT]]);
      const release = utterance.flush("stop", dictation);
      expect(shown(release?.emissions), sentence).toEqual([{ itemId: "i0", text: sentence }]);
      expect(release?.send, sentence).toBe(false);
    }
  });

  it("sends at a pause heard while a stop drains", () => {
    const { releases } = feed([["Fix the login bug, send it.", STOPPING_PAUSE]]);
    expect(shown(releases[0]?.emissions)).toEqual([{ itemId: "i0", text: "Fix the login bug" }]);
    expect(releases[0]?.send).toBe(true);
  });

  it("reads a send after a pause heard while stopping with the clause it carries on", () => {
    const { utterance, releases } = feed([
      ["Where should the handler", STOPPING_PAUSE],
      ["send it", CUT],
    ]);
    const stopped = [...releases, utterance.flush("stop", dictation)];
    expect(written(stopped)).toBe("Where should the handler send it");
  });

  it("keeps a trailing 'send it' as words when the connection is lost", () => {
    const { utterance } = feed([["Fix the bug, send it", CUT]]);
    const release = utterance.flush("literal", dictation);
    expect(shown(release?.emissions)).toEqual([{ itemId: "i0", text: "Fix the bug, send it" }]);
    expect(release?.send).toBe(false);
  });

  it("keeps held words as said when the connection is lost", () => {
    const { utterance } = feed([["fix the bug new line", CUT]]);
    expect(shown(utterance.flush("literal", dictation)?.emissions)).toEqual([
      { itemId: "i0", text: "fix the bug new line" },
    ]);
    expect(utterance.flush("literal", dictation)).toBeNull();
  });

  it("forgets everything it held when cleared", () => {
    const { utterance } = feed([["fix the bug new line", CUT]]);
    utterance.clear();
    expect(utterance.flush("stop", dictation)).toBeNull();
  });

  it("leaves commands as words with spoken commands off", () => {
    const options = { spokenCommands: false, vocabulary: null };
    const { releases } = feed(
      [
        ["fix the bug new line", CUT],
        ["send it", END],
      ],
      options
    );
    expect(written(releases)).toBe("fix the bug new line send it");
  });
});

describe("UtteranceCommands — the opening command", () => {
  it("writes a command whose name follows a pause after its prefix", () => {
    const { releases } = feed(
      [
        ["Slash.", END],
        ["compact.", END],
      ],
      withCommands
    );
    expect(releases[0]).toBeNull();
    expect(shown(releases[1]?.emissions)).toEqual([
      { itemId: "i1", text: "" },
      { itemId: "i0", text: "Slash. compact.", opensUtterance: true },
    ]);
  });

  it("writes a command cut mid-speech, with its arguments", () => {
    const { releases } = feed(
      [
        ["Slash", CUT],
        ["review the last commit.", END],
      ],
      withCommands
    );
    expect(shown(releases[1]?.emissions)?.at(-1)).toEqual({
      itemId: "i0",
      text: "Slash review the last commit.",
      opensUtterance: true,
    });
  });

  it("lets a prefix with no command after it go as words", () => {
    const { releases } = feed(
      [
        ["Slash.", END],
        ["the budget in half.", END],
      ],
      withCommands
    );
    expect(shown(releases[1]?.emissions)).toEqual([
      { itemId: "i0", text: "Slash.", opensUtterance: true },
      { itemId: "i1", text: "the budget in half." },
    ]);
  });

  it("never opens a command after words the utterance already landed", () => {
    const { releases } = feed(
      [
        ["Okay,", CUT],
        ["slash compact", END],
      ],
      withCommands
    );
    expect(shown(releases.flatMap((release) => release?.emissions ?? []))).toEqual([
      { itemId: "i0", text: "Okay,", opensUtterance: true },
      { itemId: "i1", text: "slash compact" },
    ]);
  });

  it("still sends a dictated command and 'send it'", () => {
    const { releases } = feed([["Slash compact, send it.", END]], withCommands);
    expect(shown(releases[0]?.emissions)).toEqual([
      { itemId: "i0", text: "Slash compact", opensUtterance: true },
    ]);
    expect(releases[0]?.send).toBe(true);
  });

  it("writes the command with spoken commands off", () => {
    const { releases } = feed(
      [
        ["Slash.", END],
        ["compact.", END],
      ],
      { ...withCommands, spokenCommands: false }
    );
    expect(shown(releases[1]?.emissions)?.at(-1)).toEqual({
      itemId: "i0",
      text: "Slash. compact.",
      opensUtterance: true,
    });
  });

  it("lets a waiting prefix go as words at a stop", () => {
    const { utterance } = feed([["Slash.", END]], withCommands);
    expect(shown(utterance.flush("stop", withCommands)?.emissions)).toEqual([
      { itemId: "i0", text: "Slash.", opensUtterance: true },
    ]);
  });
});

describe("UtteranceCommands — the provider's unsure words", () => {
  it("keeps the spans in words that land, and drops those a command took", () => {
    const utterance = new UtteranceCommands();
    // "logn" and "send" unsure; the send takes "send" with it.
    utterance.push(
      {
        itemId: "i0",
        text: " Fix the logn bug, send",
        uncertain: [
          { from: 9, to: 13 },
          { from: 19, to: 23 },
        ],
      },
      CUT,
      dictation
    );
    const release = utterance.push({ itemId: "i1", text: "it.", uncertain: [] }, END, dictation);
    expect(release?.emissions).toEqual([
      { itemId: "i1", text: "", uncertain: [] },
      { itemId: "i0", text: "Fix the logn bug", uncertain: [{ from: 8, to: 12 }] },
    ]);
  });

  it("moves each segment's spans into a command they merge into", () => {
    const utterance = new UtteranceCommands();
    utterance.push(
      { itemId: "i0", text: "Slash.", uncertain: [{ from: 0, to: 5 }] },
      END,
      withCommands
    );
    const release = utterance.push(
      { itemId: "i1", text: "review the lgin page.", uncertain: [{ from: 11, to: 15 }] },
      END,
      withCommands
    );
    expect(release?.emissions.at(-1)).toEqual({
      itemId: "i0",
      text: "Slash. review the lgin page.",
      uncertain: [
        { from: 0, to: 5 },
        { from: 18, to: 22 },
      ],
      opensUtterance: true,
    });
  });
});

describe("UtteranceCommands — the speaker's pauses", () => {
  const GAP: UtteranceBoundary = { ...CUT, paused: true };
  const PAUSED: UtteranceBoundary = { ...PAUSE, paused: true };
  const PAUSED_END: UtteranceBoundary = { ...END, paused: true };

  // Each emission's text and where the speaker paused in it.
  const pausesOf = (emissions: readonly UtteranceEmission[] | null | undefined) =>
    emissions?.map(({ text, pauses }) => ({ text, pauses: pauses ?? [] }));

  it("marks where a segment the speaker paused after ends, and nothing where one was cut", () => {
    const { releases } = feed([
      ["fix the bug", GAP],
      ["and the parser", CUT],
      ["done.", PAUSED_END],
    ]);
    expect(releases.map((release) => pausesOf(release?.emissions))).toEqual([
      [{ text: "fix the bug", pauses: [11] }],
      [{ text: "and the parser", pauses: [] }],
      [{ text: "done.", pauses: [5] }],
    ]);
  });

  it("moves a pause after a stripped break back onto the words the cut kept", () => {
    const { releases } = feed([
      ["fix the bug new", CUT],
      ["line.", PAUSED],
    ]);
    expect(pausesOf(releases[1]?.emissions)).toEqual([
      { text: "", pauses: [] },
      { text: "fix the bug\n", pauses: [11] },
    ]);
  });

  it("moves a pause after a stripped send onto the words it kept, and keeps it as said in the literal", () => {
    const { releases } = feed([
      ["Fix the login bug, send", CUT],
      ["it.", PAUSED_END],
    ]);
    expect(releases[1]?.send).toBe(true);
    expect(pausesOf(releases[1]?.emissions)).toEqual([
      { text: "", pauses: [] },
      { text: "Fix the login bug", pauses: [17] },
    ]);
    expect(pausesOf(releases[1]?.literal)).toEqual([
      { text: "Fix the login bug, send", pauses: [] },
      { text: "it.", pauses: [3] },
    ]);
  });

  it("puts a pause after words already released ahead of the break that took the rest", () => {
    const { releases } = feed([
      ["fix the bug", CUT],
      ["new line.", PAUSED],
    ]);
    expect(pausesOf(releases[1]?.emissions)).toEqual([{ text: "\n", pauses: [0] }]);
  });

  it("ends the last held words at a pause with no words of its own", () => {
    const utterance = new UtteranceCommands();
    expect(utterance.push({ itemId: "i0", text: "Fix it, send it." }, CUT, dictation)).toBeNull();
    const release = utterance.push({ text: "" }, PAUSED_END, dictation);
    expect(release?.send).toBe(true);
    expect(pausesOf(release?.emissions)).toEqual([{ text: "Fix it", pauses: [6] }]);
  });

  it("sends a wordless pause after released words once, and none after a pause already marked", () => {
    const utterance = new UtteranceCommands();
    utterance.push({ itemId: "i0", text: "fix the bug" }, CUT, dictation);
    const bare = utterance.push({ text: "" }, PAUSED_END, dictation);
    expect(bare).toEqual({
      emissions: [{ text: "", uncertain: [], pauses: [0] }],
      send: false,
      literal: null,
    });
    expect(utterance.push({ text: "" }, PAUSED_END, dictation)).toBeNull();

    utterance.push({ itemId: "i1", text: "and the parser" }, PAUSED_END, dictation);
    expect(utterance.push({ text: "" }, PAUSED_END, dictation)).toBeNull();
  });

  it("keeps a pause inside a command its segments merge into", () => {
    const { releases } = feed(
      [
        ["Slash.", PAUSED_END],
        ["compact.", PAUSED_END],
      ],
      withCommands
    );
    expect(releases[1]?.emissions.at(-1)).toMatchObject({
      text: "Slash. compact.",
      pauses: [6, 15],
      opensUtterance: true,
    });
  });

  it("marks no pause a stop or a lost connection lets go of", () => {
    for (const mode of ["stop", "literal"] as const) {
      const utterance = new UtteranceCommands();
      utterance.push({ itemId: "i0", text: "fix the bug new" }, CUT, dictation);
      const release = utterance.flush(mode, dictation);
      expect(release?.emissions.every((emission) => !emission.pauses)).toBe(true);
    }
  });
});
