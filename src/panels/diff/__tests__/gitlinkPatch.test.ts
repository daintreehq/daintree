import { describe, expect, it } from "vitest";
import { isGitlinkPatch } from "../gitlinkPatch";

// The gitlink fixtures are real `git diff` output, captured from a scratch
// repository with a submodule rather than written from memory — the type-change
// shape in particular is not the one it looks like it should be.

const MOVED_COMMIT = `diff --git a/vendor/sub b/vendor/sub
index ada605e..029ae62 160000
--- a/vendor/sub
+++ b/vendor/sub
@@ -1 +1 @@
-Subproject commit ada605e3957df590939d8d977a26e1735b98390f
+Subproject commit 029ae62ae5f30fb47a84aa76407e4e42dd165e6d`;

const ADDED = `diff --git a/vendor/sub b/vendor/sub
new file mode 160000
index 0000000..ada605e
--- /dev/null
+++ b/vendor/sub
@@ -0,0 +1 @@
+Subproject commit ada605e3957df590939d8d977a26e1735b98390f`;

const DELETED = `diff --git a/vendor/sub b/vendor/sub
deleted file mode 160000
index ada605e..0000000
--- a/vendor/sub
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit ada605e3957df590939d8d977a26e1735b98390f`;

// Git spells a submodule → file replacement as two records, not `old mode` /
// `new mode`. The gitlink mode is present, but the new side is readable.
const REPLACED_BY_FILE = `diff --git a/vendor/sub b/vendor/sub
deleted file mode 160000
index ada605e..0000000
--- a/vendor/sub
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit ada605e3957df590939d8d977a26e1735b98390f
diff --git a/vendor/sub b/vendor/sub
new file mode 100644
index 0000000..2a79fdf
--- /dev/null
+++ b/vendor/sub
@@ -0,0 +1 @@
+now a real file`;

const ORDINARY_EDIT = `diff --git a/src/app.ts b/src/app.ts
index 83db48f..bf269f4 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
 export { a };`;

describe("isGitlinkPatch", () => {
  it("recognises a submodule whose recorded commit moved", () => {
    expect(isGitlinkPatch(MOVED_COMMIT)).toBe(true);
  });

  it("recognises an added and a deleted submodule", () => {
    expect(isGitlinkPatch(ADDED)).toBe(true);
    expect(isGitlinkPatch(DELETED)).toBe(true);
  });

  it("leaves an ordinary file edit alone", () => {
    expect(isGitlinkPatch(ORDINARY_EDIT)).toBe(false);
  });

  it("follows the new side when a submodule is replaced by a real file", () => {
    // The replacement is readable from disk, so the full-file scope stays on
    // offer even though the patch opens with a gitlink mode.
    expect(isGitlinkPatch(REPLACED_BY_FILE)).toBe(false);
  });

  it("follows the new side when a real file is replaced by a submodule", () => {
    const fileToSubmodule = `diff --git a/vendor/sub b/vendor/sub
deleted file mode 100644
index 2a79fdf..0000000
--- a/vendor/sub
+++ /dev/null
@@ -1 +0,0 @@
-was a real file
diff --git a/vendor/sub b/vendor/sub
new file mode 160000
index 0000000..ada605e
--- /dev/null
+++ b/vendor/sub
@@ -0,0 +1 @@
+Subproject commit ada605e3957df590939d8d977a26e1735b98390f`;
    expect(isGitlinkPatch(fileToSubmodule)).toBe(true);
  });

  it("ignores a permission-only change, which names both modes", () => {
    expect(
      isGitlinkPatch(`diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755`)
    ).toBe(false);
  });

  it("reads modes from the header only, never the patch body", () => {
    // A file documenting gitlink patches is not itself one. Every giveaway line
    // appears in the body, prefixed the way git prefixes body lines.
    expect(
      isGitlinkPatch(`diff --git a/docs/submodules.md b/docs/submodules.md
index 83db48f..bf269f4 100644
--- a/docs/submodules.md
+++ b/docs/submodules.md
@@ -1,3 +1,4 @@
 A submodule patch looks like this:
-index abc..def 160000
+new file mode 160000
+Subproject commit 029ae62ae5f30fb47a84aa76407e4e42dd165e6d
 and that is all it is.`)
    ).toBe(false);
  });

  it("survives CRLF headers and says no to sentinels and empty input", () => {
    expect(isGitlinkPatch(MOVED_COMMIT.replaceAll("\n", "\r\n"))).toBe(true);
    expect(isGitlinkPatch(undefined)).toBe(false);
    expect(isGitlinkPatch("")).toBe(false);
    expect(isGitlinkPatch("NO_CHANGES")).toBe(false);
    expect(isGitlinkPatch("BINARY_FILE")).toBe(false);
  });
});
