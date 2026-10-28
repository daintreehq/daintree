import { describe, expect, it } from "vitest";
import { matchesFileEditorGlob, relativeFilePath } from "../fileEditorGlob";

describe("matchesFileEditorGlob (#13809)", () => {
  it("matches * within one segment only", () => {
    expect(matchesFileEditorGlob("content/a.json", "content/*.json")).toBe(true);
    expect(matchesFileEditorGlob("content/sub/a.json", "content/*.json")).toBe(false);
    expect(matchesFileEditorGlob("content/a.jsonx", "content/*.json")).toBe(false);
  });

  it("matches ** across zero or more directories", () => {
    expect(matchesFileEditorGlob("data/a.record", "data/**/*.record")).toBe(true);
    expect(matchesFileEditorGlob("data/x/y/a.record", "data/**/*.record")).toBe(true);
    expect(matchesFileEditorGlob("other/a.record", "data/**/*.record")).toBe(false);
    expect(matchesFileEditorGlob("data/x/y", "data/**")).toBe(true);
  });

  it("treats ? as one character and everything else literally", () => {
    expect(matchesFileEditorGlob("v1.cfg", "v?.cfg")).toBe(true);
    expect(matchesFileEditorGlob("v10.cfg", "v?.cfg")).toBe(false);
    expect(matchesFileEditorGlob("axcfg", "a.cfg")).toBe(false);
    expect(matchesFileEditorGlob("A.cfg", "a.cfg")).toBe(false);
  });
});

describe("relativeFilePath", () => {
  it("returns the forward-slash path under the root", () => {
    expect(relativeFilePath("/repo", "/repo/content/a.json")).toBe("content/a.json");
    expect(relativeFilePath("C:\\repo\\", "C:\\repo\\content\\a.json")).toBe("content/a.json");
  });

  it("returns null outside the root, for the root itself and through ..", () => {
    expect(relativeFilePath("/repo", "/repo2/a.json")).toBeNull();
    expect(relativeFilePath("/repo", "/repo")).toBeNull();
    expect(relativeFilePath("/repo", "/repo/../etc/a.json")).toBeNull();
    expect(relativeFilePath("", "/repo/a.json")).toBeNull();
  });
});
