import { describe, it, expect } from "vitest";

import {
  formatEngineVersion,
  readEnginePin,
  versionsInBinary,
  describePackagedEngineProblem,
} from "./assistantEnginePin.cjs";

/**
 * The guard that stops a packaged app carrying an engine its own source tree does not
 * name.
 *
 * The failure it answers is invisible to every other check: `resources/assistant/` is
 * written only by an explicit `npm run build:assistant`, so moving the submodule and
 * packaging ships the PREVIOUS binary — correct name, correct arch, plausible size,
 * executable bit set, previous engine's bugs. It was live on this branch, where the
 * gitlink read `ffa9c05` and the built resource reported `daintree-e0e3f0b-dirty`.
 *
 * `spawnSync` is injected throughout so these run against scripted git output rather
 * than the repository's real submodule, whose state changes with every pin bump.
 */

const ROOT = "/repo";

/**
 * A git double. Each entry answers one `git` invocation, keyed by a distinguishing
 * argument, with `{ status, stdout }` — the shape `spawnSync` returns.
 */
function fakeGit(answers: Record<string, { status?: number; stdout?: string } | undefined>) {
  return (_cmd: string, args: string[]) => {
    const key = args.includes("submodule")
      ? "submodule"
      : args.includes("rev-parse")
        ? "rev-parse"
        : "porcelain";
    return answers[key] ?? { status: 0, stdout: "" };
  };
}

/** A full object id beginning with `shortSha`, as `git submodule status` prints it. */
function fullSha(shortSha: string) {
  return shortSha + "0".repeat(40 - shortSha.length);
}

/**
 * `git submodule status` output. The LEADING marker character is significant and the
 * space for a clean submodule is real output, not padding — a double that omitted it
 * would let a parser that trims pass its tests and fail on git.
 */
function submoduleStatus(marker: string, shortSha: string, suffix = " (heads/develop)") {
  return `${marker}${fullSha(shortSha)} vendor/daintree-assistant${suffix}\n`;
}

/** A pin whose submodule is checked out, matches the gitlink, and is clean. */
function cleanGit(shortSha: string) {
  return fakeGit({
    submodule: { status: 0, stdout: submoduleStatus(" ", shortSha) },
    "rev-parse": { status: 0, stdout: `${shortSha}\n` },
    porcelain: { status: 0, stdout: "" },
  });
}

/** A binary's bytes, with the given version strings embedded among other data. */
function binaryStamped(...versions: string[]) {
  return Buffer.from(`\x00\x01ELFgo1.25${versions.join("\x00")}\x00runtime.main`, "latin1");
}

/**
 * A binary carrying the linker's RECORD of the version it was asked to set, and nothing
 * else — what a build produces when `-X main.version=` names a symbol that no longer
 * exists. Go ignores the flag and records the request anyway.
 */
function binaryWithLinkerRequestOnly(version: string) {
  return Buffer.from(
    `\x00go1.25build\t-ldflags="-s -w -X main.version=${version}"\x00runtime.main`,
    "latin1"
  );
}

describe("assistant engine pin", () => {
  describe("readEnginePin", () => {
    it("reports the submodule's version when everything agrees", () => {
      const pin = readEnginePin({ root: ROOT, spawnSync: cleanGit("abc1234") });

      expect(pin.problem).toBeUndefined();
      expect(pin.dirty).toBe(false);
      expect(pin.version).toBe(formatEngineVersion("abc1234", false));
    });

    it("marks an edited submodule dirty, so the version cannot claim a commit", () => {
      // Untracked files count — a new `.go` file changes what gets built.
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: { status: 0, stdout: submoduleStatus(" ", "abc1234") },
          "rev-parse": { status: 0, stdout: "abc1234\n" },
          porcelain: { status: 0, stdout: "?? internal/auth/new.go\n" },
        }),
      });

      expect(pin.dirty).toBe(true);
      expect(pin.version).toBe(formatEngineVersion("abc1234", true));
      // Not a problem HERE: `npm run dev` builds from an edited submodule constantly.
      // It becomes one only at pack time.
      expect(pin.problem).toBeUndefined();
    });

    it("refuses a submodule that was never checked out", () => {
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: { status: 0, stdout: submoduleStatus("-", "abc1234", "") },
        }),
      });

      expect(pin.version).toBeUndefined();
      // The message has to name the fix: there is no separate install of this engine,
      // so "missing" sends someone hunting for a package that does not exist.
      expect(pin.problem).toMatch(/git submodule update/);
    });

    it("refuses a submodule checked out somewhere the repository does not pin", () => {
      // The `+` case: someone moved the submodule and did not commit the gitlink. The
      // app would package fine and be unreproducible from the tree it shipped with.
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: { status: 0, stdout: submoduleStatus("+", "deadbee") },
        }),
      });

      expect(pin.version).toBeUndefined();
      expect(pin.problem).toMatch(/does not pin/);
      // The offending commit is named, or there is nothing to act on.
      expect(pin.problem).toContain("deadbee");
    });

    it("refuses a submodule with unresolved conflicts", () => {
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: { status: 0, stdout: submoduleStatus("U", "abc1234", "") },
        }),
      });

      expect(pin.problem).toMatch(/conflict/i);
    });

    it("refuses when git itself cannot answer", () => {
      // A non-zero exit must not be read as an empty-and-therefore-clean tree: that
      // would turn a broken checkout into a silent pass.
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({ submodule: { status: 128, stdout: "" } }),
      });

      expect(pin.version).toBeUndefined();
      expect(pin.problem).toBeTruthy();
    });

    it("refuses a path git does not describe as a submodule at all", () => {
      // Empty output, which is what `git submodule status` returns for a path that is
      // tracked but is no longer a gitlink. Read leniently, the reads that follow walk
      // UP from that directory into the superproject and fabricate a pin out of
      // Daintree's own HEAD — a version that names a commit of the wrong repository.
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({ submodule: { status: 0, stdout: "" } }),
      });

      expect(pin.version).toBeUndefined();
      expect(pin.problem).toMatch(/not describe .* as a submodule/);
    });

    it("refuses output it cannot parse rather than reading past it", () => {
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({ submodule: { status: 0, stdout: "something else entirely\n" } }),
      });

      expect(pin.version).toBeUndefined();
    });

    it("refuses a multi-line listing rather than judging the first entry", () => {
      // What `--recursive` would produce. Reading line one and ignoring the rest would
      // report a nested submodule's state as the engine's.
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: {
            status: 0,
            stdout: submoduleStatus(" ", "abc1234") + submoduleStatus("+", "deadbee"),
          },
        }),
      });

      expect(pin.version).toBeUndefined();
    });

    it("refuses an abbreviation too short to be recognised later", () => {
      // `core.abbrev=4` is a legal git configuration, and a version stamped from it is
      // one this module's own pattern cannot find in a binary. Caught where the value is
      // read, not where it fails to match — the symptom there is "carries no version",
      // which sends someone rebuilding a binary that is already correct.
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: { status: 0, stdout: submoduleStatus(" ", "abc1234") },
          "rev-parse": { status: 0, stdout: "abc1\n" },
        }),
      });

      expect(pin.version).toBeUndefined();
    });

    it("refuses when the submodule's working tree cannot be read", () => {
      const pin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: { status: 0, stdout: submoduleStatus(" ", "abc1234") },
          "rev-parse": { status: 0, stdout: "abc1234\n" },
          porcelain: { status: 128, stdout: "" },
        }),
      });

      expect(pin.problem).toBeTruthy();
    });
  });

  describe("versionsInBinary", () => {
    it("finds every stamped version and de-duplicates them", () => {
      const found = versionsInBinary(binaryStamped("daintree-abc1234", "daintree-abc1234"));

      expect(found).toEqual(["daintree-abc1234"]);
    });

    it("reads a dirty stamp as its own distinct version", () => {
      // The whole reason this is a regex rather than a substring test. `-dirty` has to
      // come back attached, or the comparison below cannot tell the two apart.
      expect(versionsInBinary(binaryStamped("daintree-abc1234-dirty"))).toEqual([
        "daintree-abc1234-dirty",
      ]);
    });

    it("does not count the linker's record of what it was asked to set", () => {
      // Go writes the flags it was given into build metadata verbatim, and silently
      // ignores `-X` when the symbol it names does not exist. So a binary reporting its
      // compiled-in default still carries the SHA the build script asked for — and a
      // scan that counted it would confirm a pin the running binary knows nothing about.
      expect(versionsInBinary(binaryWithLinkerRequestOnly("daintree-abc1234"))).toEqual([]);
    });

    it("still counts a version the binary carries, beside the linker's record of it", () => {
      // The ordinary case: every real build contains both, and the exclusion must not
      // take the genuine occurrence with it.
      const real = Buffer.concat([
        binaryWithLinkerRequestOnly("daintree-abc1234"),
        binaryStamped("daintree-abc1234"),
      ]);

      expect(versionsInBinary(real)).toEqual(["daintree-abc1234"]);
    });

    it("finds nothing in a binary that carries no stamp", () => {
      expect(versionsInBinary(Buffer.from("\x7fELF not built by our script", "latin1"))).toEqual(
        []
      );
    });
  });

  describe("describePackagedEngineProblem", () => {
    const pin = readEnginePin({ root: ROOT, spawnSync: cleanGit("abc1234") });

    it("passes the binary built from the pinned commit", () => {
      expect(
        describePackagedEngineProblem({ pin, buffer: binaryStamped(pin.version!) })
      ).toBeNull();
    });

    it("fails a binary left over from an earlier pin", () => {
      // The regression itself: gitlink moved, `resources/assistant/` did not.
      const problem = describePackagedEngineProblem({
        pin,
        buffer: binaryStamped("daintree-e0e3f0b"),
      });

      // Both halves have to appear, or the reader cannot tell which way the skew runs.
      expect(problem).toContain("e0e3f0b");
      expect(problem).toContain(pin.version!);
      expect(problem).toMatch(/build:assistant/);
    });

    it("fails a dirty build of the pinned commit rather than passing on the prefix", () => {
      // The trap a substring check falls into: `daintree-abc1234-dirty` CONTAINS
      // `daintree-abc1234`, so a naive match would ship the one build that must not.
      const problem = describePackagedEngineProblem({
        pin,
        buffer: binaryStamped(`${pin.version}-dirty`),
      });

      expect(problem).toBeTruthy();
    });

    it("fails when the submodule itself is dirty, whatever the binary says", () => {
      // Decided from the pin alone: a build nobody can reproduce must not ship even if
      // the binary on disk faithfully reports that it is one.
      const dirtyPin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: { status: 0, stdout: submoduleStatus(" ", "abc1234") },
          "rev-parse": { status: 0, stdout: "abc1234\n" },
          porcelain: { status: 0, stdout: " M internal/auth/oauth.go\n" },
        }),
      });

      const problem = describePackagedEngineProblem({
        pin: dirtyPin,
        buffer: binaryStamped(dirtyPin.version!),
      });

      expect(problem).toMatch(/uncommitted|reproduce/);
    });

    it("fails a binary carrying a second version beside the pinned one", () => {
      // A macOS universal binary is two slices in one file. Merge a current arm64 with a
      // stale x64 and the result carries both strings — so "contains the pinned version"
      // passes an app half-built from a commit nobody named.
      const problem = describePackagedEngineProblem({
        pin,
        buffer: binaryStamped(pin.version!, "daintree-e0e3f0b"),
      });

      expect(problem).toBeTruthy();
      expect(problem).toContain("e0e3f0b");
    });

    it("fails a binary with no version string at all", () => {
      const problem = describePackagedEngineProblem({
        pin,
        buffer: Buffer.from("a placeholder file", "latin1"),
      });

      expect(problem).toMatch(/no version string/);
    });

    it("reports an unreadable pin rather than judging the binary", () => {
      // A pin that could not be resolved is the more fundamental failure, and reporting
      // "the engine is stale" for it would send someone rebuilding a correct binary.
      const brokenPin = readEnginePin({
        root: ROOT,
        spawnSync: fakeGit({
          submodule: { status: 0, stdout: submoduleStatus("-", "abc1234", "") },
        }),
      });

      expect(describePackagedEngineProblem({ pin: brokenPin, buffer: Buffer.alloc(0) })).toBe(
        brokenPin.problem
      );
    });
  });
});
