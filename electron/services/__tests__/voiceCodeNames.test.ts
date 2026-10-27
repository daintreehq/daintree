import { describe, expect, it } from "vitest";
import { buildCodeNameIndex, diffCodeNames, matchCodeNames } from "../voiceCodeNames.js";

const FILES = [
  "src/services/VoiceRecordingService.ts",
  "src/services/__tests__/VoiceRecordingService.chunks.test.ts",
  "electron/window/ProjectViewManager.ts",
  "electron/services/voice/OpenAITranscriptionProvider.ts",
  "electron/workspace-host/WorktreeMonitor.ts",
  "src/styles/dark-mode.css",
  "docs/README.md",
  "src/lib/toDo.ts",
];

describe("matchCodeNames", () => {
  const index = buildCodeNameIndex(FILES, ["node-pty", "@xterm/xterm", "drizzle-orm"]);

  it("finds the code names a passage spells out word by word", () => {
    expect(
      matchCodeNames(
        "Run npm test on the voice recording service test file, then open the project view manager.",
        index
      )
    ).toEqual(["VoiceRecordingService", "ProjectViewManager"]);
    expect(matchCodeNames("go through the OpenAI transcription provider", index)).toEqual([
      "OpenAITranscriptionProvider",
    ]);
  });

  it("finds a hyphenated repository name said as words, scope dropped", () => {
    expect(matchCodeNames("Node PTY fails to load, and so does x term", index)).toEqual([
      "node-pty",
    ]);
    expect(matchCodeNames("add a drizzle ORM migration", index)).toEqual(["drizzle-orm"]);
  });

  it("takes the longest run at each place, and each name once", () => {
    const nested = buildCodeNameIndex(["a/VoiceRecording.ts", "a/VoiceRecordingService.ts"]);
    expect(matchCodeNames("the voice recording service and the voice recording", nested)).toEqual([
      "VoiceRecordingService",
      "VoiceRecording",
    ]);
    expect(
      matchCodeNames("voice recording service, voice recording service again", nested)
    ).toEqual(["VoiceRecordingService"]);
  });

  it("leaves out a name already written as one word, ordinary file names and short keys", () => {
    expect(matchCodeNames("open VoiceRecordingService", index)).toEqual([]);
    expect(matchCodeNames("check it in dark mode", index)).toEqual([]);
    expect(matchCodeNames("add it to do list", index)).toEqual([]);
    expect(matchCodeNames("read me first", index)).toEqual([]);
  });

  it("never joins words across a sentence or clause break", () => {
    expect(matchCodeNames("Keep the voice recording. Service workers can wait.", index)).toEqual(
      []
    );
    expect(matchCodeNames("the voice recording, service and all", index)).toEqual([]);
    expect(matchCodeNames("the voice recording\nservice", index)).toEqual([]);
    expect(matchCodeNames("Keep the voice recording (service workers can wait).", index)).toEqual(
      []
    );
    expect(matchCodeNames('"Keep the voice recording." Service workers can wait.', index)).toEqual(
      []
    );
    expect(matchCodeNames("the voice recording — service workers", index)).toEqual([]);
    // A dot or colon inside a word is no break.
    expect(matchCodeNames("open package.json and the project view manager", index)).toEqual([
      "ProjectViewManager",
    ]);
    expect(
      matchCodeNames("see https://x.dev/a.b then version 1.5 of the project view manager", index)
    ).toEqual(["ProjectViewManager"]);
  });

  it("stops at the most a passage sends", () => {
    const words =
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(
        " "
      );
    const files = words.map((word) => `x/Alpha${word[0]!.toUpperCase()}${word.slice(1)}.ts`);
    const spoken = words.map((word) => `alpha ${word}`).join(", ");
    expect(matchCodeNames(spoken, buildCodeNameIndex(files))).toHaveLength(12);
  });
});

describe("buildCodeNameIndex", () => {
  it("keeps the spelling a key is seen in most, and a chosen name over a file's", () => {
    const index = buildCodeNameIndex([
      "a/voiceInput.ts",
      "b/voiceInput.preload.ts",
      "c/VoiceInput.tsx",
      "d/NodePty.ts",
    ]);
    expect(index.get("voiceinput")).toBe("voiceInput");
    expect(
      buildCodeNameIndex(["NodePty/NodePty.ts", "NodePty/NodePty.test.ts"], ["node-pty"]).get(
        "nodepty"
      )
    ).toBe("node-pty");
  });

  it("never indexes a secret-shaped name", () => {
    const index = buildCodeNameIndex(["config/sk-live-AbCdEf1234567890XyZ.ts"]);
    expect([...index.values()].some((name) => name.includes("sk-live"))).toBe(false);
  });
});

describe("diffCodeNames", () => {
  const diff = [
    "diff --git a/src/services/voiceCorrectionRequest.ts b/src/services/voiceCorrectionRequest.ts",
    "--- a/src/services/voiceCorrectionRequest.ts",
    "+++ b/src/services/voiceCorrectionRequest.ts",
    "@@ -1,2 +1,3 @@",
    "-const removedHelperName = 1;",
    "+export function annotateUncertainSpans(text, spans) {",
    "+  const project_id = readProjectId(text);",
    "+  return the plain words stay out;",
  ].join("\n");

  it("names the files a diff touches and the identifiers its added lines write", () => {
    expect(diffCodeNames(diff)).toEqual([
      "voiceCorrectionRequest",
      "annotateUncertainSpans",
      "project_id",
      "readProjectId",
    ]);
  });

  it("feeds code names that a passage then matches", () => {
    const index = buildCodeNameIndex([], diffCodeNames(diff));
    expect(matchCodeNames("make annotate uncertain spans skip the project ID", index)).toEqual([
      "annotateUncertainSpans",
      "project_id",
    ]);
  });
});
