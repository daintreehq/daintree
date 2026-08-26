/**
 * The one place that decides what version string the vendored assistant engine carries,
 * and whether a given binary is the one the checked-out gitlink asks for.
 *
 * Two callers, deliberately: `build-assistant.mjs` STAMPS the string into the binary
 * (`-X main.version=`), and `afterPack.cjs` READS it back out of whatever is about to be
 * packaged. A second copy of the format would let those two disagree, and the failure
 * that produces is the one this whole vendoring scheme exists to prevent — a shipped app
 * whose engine is not the engine its source tree names.
 *
 * afterPack is where the verification lives rather than each `package:*` script, because
 * afterPack is the ONE hook every packaging path already goes through: `npm run package`,
 * the per-platform scripts, `package-local-dmg.mjs`, and all three release workflows. A
 * check copied into each of those is a check that a new path silently skips.
 *
 * `spawnSync` is injected rather than required here so the caller's own handle is used —
 * afterPack's tests drive the whole guard through a mocked `child_process`, and a module
 * that reached for its own copy would be untestable from there.
 */

/**
 * Every `daintree-<sha>` the Go linker could have written, `-dirty` included.
 *
 * Matched against the binary's bytes rather than executing it: a release runner
 * cross-packs Windows and Linux from one machine, and a foreign-arch binary cannot be
 * run to ask its version. The string is in the binary's data either way.
 *
 * The optional `-dirty` group is load-bearing. Without it, a plain substring test for
 * `daintree-abc1234` would PASS on a binary stamped `daintree-abc1234-dirty` — the exact
 * build that must never ship.
 */
const ENGINE_VERSION_PATTERN = /daintree-[0-9a-f]{7,40}(?:-dirty)?/g;

/**
 * The Go linker records the flags it was given, verbatim, in the binary's build
 * metadata: `build -ldflags="-s -w -X main.version=daintree-2d2416f"`. So the version
 * appears in a real binary THREE times — once as the value of `main.version`, and twice
 * more as the text of the request that set it.
 *
 * That difference is the whole point. `-X` is silently ignored when the symbol it names
 * does not exist, so an engine that renamed or dropped `main.version` would report its
 * compiled-in default while the metadata still recorded the SHA the build script asked
 * for — and a scan that counted the metadata would confirm a pin the running binary
 * knows nothing about. Occurrences preceded by `main.version=` are therefore evidence of
 * the request, never of the result, and are excluded.
 */
const LINKER_REQUEST_PREFIX = "main.version=";

/** The submodule path, relative to the repo root. Named once. */
const SUBMODULE_PATH = "vendor/daintree-assistant";

/**
 * One line of `git submodule status`: a marker, a full 40-character object id, the path.
 *
 * Matched strictly rather than read by offset. `git submodule status` reports a clean
 * submodule with a LEADING SPACE, which a trimmed read destroys — and every downstream
 * check then has to treat "not one of the three bad markers" as good, which makes empty
 * output good too. Empty output is not hypothetical: it is what the command returns for
 * a path that is tracked but is no longer a gitlink, and the reads that follow would
 * then walk up from that directory into the SUPERPROJECT and fabricate a pin out of
 * Daintree's own HEAD.
 */
const SUBMODULE_STATUS_LINE = /^([ +\-U])([0-9a-f]{40}) /;

/**
 * The version a build stamps, given the submodule's short SHA and whether its tree is
 * clean.
 *
 * The `-dirty` suffix is what tells two binaries that behave differently apart when both
 * would otherwise claim the SHA they were branched from.
 */
function formatEngineVersion(shortSha, dirty) {
  return `daintree-${shortSha}${dirty ? "-dirty" : ""}`;
}

function git(spawnSync, args, cwd, { trim = true } = {}) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (!res || res.error || res.status !== 0) return null;
  // `encoding: "utf8"` is what makes stdout a string rather than a Buffer; `String()`
  // covers a caller whose spawnSync ignores it, since a Buffer would otherwise reach
  // the regex below as "[object Object]" and be rejected as malformed.
  const out = String(res.stdout ?? "");
  return trim ? out.trim() : out;
}

/**
 * What the checked-out submodule says the engine version should be.
 *
 * Returns `{ version, shortSha, dirty, problem }`. `problem` is a complete, actionable
 * sentence when the pin cannot be trusted at all — the submodule is missing, or the
 * commit checked out is not the one the gitlink names. Both are packaging blockers:
 * the first ships no engine, the second ships an engine from a commit the repository
 * does not record, which is unreproducible from the source tree it shipped with.
 *
 * A dirty submodule is NOT reported here as a problem, because it is not one at build
 * time — `npm run dev` builds from an edited submodule constantly. It becomes a problem
 * only at pack time, and `describePackagedEngineProblem` is where that is decided.
 */
function readEnginePin({ root, spawnSync }) {
  const submodule = `${root}/${SUBMODULE_PATH}`;

  // `git submodule status` answers both questions in one call: the leading character is
  // `-` when the submodule was never initialized, `+` when the commit checked out is not
  // the one the index records, `U` on a merge conflict, and a space when all agree.
  //
  // Read UNTRIMMED and matched whole, because every unrecognised shape has to be a
  // refusal rather than a pass — see SUBMODULE_STATUS_LINE.
  const status = git(spawnSync, ["submodule", "status", "--", SUBMODULE_PATH], root, {
    trim: false,
  });
  if (status === null) {
    return {
      problem:
        `could not read the ${SUBMODULE_PATH} submodule status. Packaging cannot verify ` +
        `that the bundled engine matches the commit this repository pins.`,
    };
  }
  const lines = status.split("\n").filter((l) => l.length > 0);
  const parsed = lines.length === 1 ? SUBMODULE_STATUS_LINE.exec(lines[0]) : null;
  if (!parsed) {
    return {
      problem:
        `git does not describe ${SUBMODULE_PATH} as a submodule (\`git submodule status\` ` +
        `said ${JSON.stringify(status)}). Packaging cannot verify the bundled engine ` +
        `against a commit this repository does not record as a gitlink.`,
    };
  }
  const marker = parsed[1];
  if (marker === "-") {
    return {
      problem:
        `the ${SUBMODULE_PATH} submodule is not checked out, so there is no engine to ` +
        `package. Run: git submodule update --init --recursive`,
    };
  }
  if (marker === "+") {
    return {
      problem:
        `the ${SUBMODULE_PATH} submodule is checked out at a commit this repository does ` +
        `not pin (${status.trim()}). An app packaged now could not be rebuilt from its ` +
        `own source tree. Commit the gitlink, or run: git submodule update --recursive`,
    };
  }
  if (marker === "U") {
    return {
      problem: `the ${SUBMODULE_PATH} submodule has unresolved merge conflicts.`,
    };
  }

  // A FIXED width, never git's own `--short`. That default follows `core.abbrev` and the
  // repository's object count, so the same commit stamps differently on two machines —
  // and at `core.abbrev=4` it stamps a version too short for this module's own pattern
  // to recognise, which reports a correct, freshly built binary as carrying no version
  // at all. 12 is long enough to stay unambiguous for the life of the engine repo.
  const shortSha = git(spawnSync, ["rev-parse", "--short=12", "HEAD"], submodule);
  if (!shortSha || !/^[0-9a-f]{7,40}$/.test(shortSha)) {
    return { problem: `could not read HEAD of the ${SUBMODULE_PATH} submodule.` };
  }

  // Untracked files count: a new `.go` file changes the build, so it changes the version.
  const porcelain = git(spawnSync, ["status", "--porcelain"], submodule);
  if (porcelain === null) {
    return { problem: `could not read the working tree of the ${SUBMODULE_PATH} submodule.` };
  }
  const dirty = porcelain.length > 0;

  return { version: formatEngineVersion(shortSha, dirty), shortSha, dirty };
}

/**
 * Every engine version the binary actually CARRIES, de-duplicated.
 *
 * Read as `latin1` so each byte maps to one character and no multi-byte decode can
 * straddle — the version is plain ASCII in the string table, and a UTF-8 decode of an
 * arbitrary executable would mangle the surrounding bytes and could split it.
 *
 * Occurrences that are the linker's record of what it was ASKED to set are skipped; see
 * LINKER_REQUEST_PREFIX for why a request is not a result.
 */
function versionsInBinary(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer);
  const found = new Set();
  for (const match of text.matchAll(ENGINE_VERSION_PATTERN)) {
    const before = text.slice(Math.max(0, match.index - LINKER_REQUEST_PREFIX.length), match.index);
    if (before === LINKER_REQUEST_PREFIX) continue;
    found.add(match[0]);
  }
  return [...found];
}

/**
 * Why this binary must not be packaged, or `null` when it is the right one.
 *
 * The failure this answers is silent and was live in this branch: `resources/assistant/`
 * is written only by an explicit build, so moving the submodule and packaging shipped
 * the PREVIOUS engine. Every structural check afterPack already makes — present,
 * single-arch, plausible size, executable — passes on that binary, because it is a
 * perfectly good engine. It is just the wrong one.
 */
function describePackagedEngineProblem({ pin, buffer }) {
  if (pin.problem) return pin.problem;

  if (pin.dirty) {
    return (
      `the ${SUBMODULE_PATH} submodule has uncommitted changes, so the engine is stamped ` +
      `"${pin.version}". A build nobody can reproduce must not ship. Commit or stash the ` +
      `submodule's changes and rebuild with: npm run build:assistant:all`
    );
  }

  const found = versionsInBinary(buffer);
  if (found.length === 0) {
    return (
      `the packaged assistant engine carries no version string at all, so it cannot be ` +
      `matched against the pinned commit (${pin.version}). It was not built by ` +
      `scripts/build-assistant.mjs. Rebuild with: npm run build:assistant:all`
    );
  }
  // EXACTLY the pinned version, and nothing else. Not "contains it": a macOS universal
  // binary is two slices in one file, so a merge of a current arm64 and a stale x64
  // carries both strings — and a containment test passes it, shipping half an app built
  // from a commit nobody named. Two different engine versions in one file is never
  // legitimate, whatever the second one is.
  if (found.length !== 1 || found[0] !== pin.version) {
    return (
      `the packaged assistant engine reports ${found.join(", ")}, but this repository ` +
      `pins ${pin.version} and nothing else. A stale binary survives a submodule move — ` +
      `resources/assistant/ is only ever written by an explicit build — and a universal ` +
      `binary can carry one current slice beside one that is not. Rebuild with: ` +
      `npm run build:assistant:all`
    );
  }
  return null;
}

module.exports = {
  ENGINE_VERSION_PATTERN,
  SUBMODULE_PATH,
  formatEngineVersion,
  readEnginePin,
  versionsInBinary,
  describePackagedEngineProblem,
};
