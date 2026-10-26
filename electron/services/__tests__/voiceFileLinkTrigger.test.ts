import { describe, expect, it } from "vitest";
import { mayReferenceFile } from "../voiceFileLinkTrigger.js";

describe("mayReferenceFile", () => {
  it.each([
    "link to the input bar component",
    "Link to the auth service.",
    "at file index ts",
    "at-file router",
    "add file router",
    "insert file config",
    "reference file auth flow",
  ])("passes an explicit command: %s", (utterance) => {
    expect(mayReferenceFile(utterance)).toBe(true);
  });

  it.each([
    "open a PR",
    "that is open source",
    "keep the file open",
    "at least one test file",
    "at the top of the file",
    "open the settings dialog",
    "please reference the old API",
    "look at the input bar component",
    "the link tooltip is wrong",
    "profile the add filter",
  ])("ignores ordinary speech: %s", (utterance) => {
    expect(mayReferenceFile(utterance)).toBe(false);
  });
});
