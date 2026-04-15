import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";

const STAGE_ROW_PATH = resolve(__dirname, "../ReviewHub/FileStageRow.tsx");
const CHANGE_LIST_PATH = resolve(__dirname, "../FileChangeList.tsx");

describe("File row hover contrast (issue #4611)", () => {
  it("FileStageRow hover uses daintree-text, not text-inverse", async () => {
    const content = await readFile(STAGE_ROW_PATH, "utf-8");
    expect(content).toContain("group-hover/stagerow:text-daintree-text");
    expect(content).not.toContain("group-hover/stagerow:text-text-inverse");
  });

  it("FileChangeList hover uses daintree-text, not text-inverse", async () => {
    const content = await readFile(CHANGE_LIST_PATH, "utf-8");
    expect(content).toContain("group-hover/filerow:text-daintree-text");
    expect(content).not.toContain("group-hover/filerow:text-text-inverse");
  });
});
