#!/usr/bin/env node
// Decides which OSes, if any, need a release dry run, from evidence: whether a
// stabilize run finished green recently and how much has landed since, and
// whether files only the release pipeline exercises (packaging, signing,
// release workflows) changed since the last tag without a green nightly or dry
// run having built that exact content.
//
// Usage: node dry-run-check.mjs [--head <sha|ref>] [--max-age-hours 72] [--max-prs 15] [--max-lines 3000]
//
// Prints JSON: { recommend: "skip" | "dry-run", oses: [...], reasons: [...], facts: {...} }.
// Exits 2 on bad arguments or when the baseline can't be established.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!argv[i]?.startsWith("--") || !(key in spec) || value === undefined || value.startsWith("--")) {
      console.error(`bad argument near ${argv[i] ?? "(end)"}; accepted: ${Object.keys(spec).map((k) => `--${k}`).join(" ")}`);
      process.exit(2);
    }
    out[key] = value;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2), { head: 1, "max-age-hours": 1, "max-prs": 1, "max-lines": 1 });
const limit = (name, fallback) => {
  const n = Number(args[name] ?? fallback);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} must be a non-negative number`);
    process.exit(2);
  }
  return n;
};
const maxAgeHours = limit("max-age-hours", 72);
const maxPrs = limit("max-prs", 15);
const maxLines = limit("max-lines", 3000);

const run = (cmd, a) =>
  execFileSync(cmd, a, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).trim();
const git = (...a) => run("git", a);
const gh = (...a) => JSON.parse(run("gh", a));
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};
const haveCommit = (sha) => tryGit("cat-file", "-e", `${sha}^{commit}`) !== null || tryGit("fetch", "-q", "origin", sha) !== null;
const isAncestor = (a, b) => tryGit("merge-base", "--is-ancestor", a, b) !== null;
const blob = (ref, file) => tryGit("rev-parse", `${ref}:${file}`);

const head = git("rev-parse", args.head ?? "origin/develop");
const lastTag = git("tag", "-l", "v*", "--sort=-version:refname").split("\n")[0];
// The tag needn't be an ancestor of develop: past re-tags merged fixes
// develop -> main without merging main back, leaving the tag's merge commit
// off develop with no content of its own. Sharing history is enough for the
// tag..head range to mean "what develop has that the release didn't".
if (!lastTag || tryGit("merge-base", lastTag, head) === null) {
  console.error(`no release tag sharing history with ${head}; run git fetch origin --tags`);
  process.exit(2);
}
// A shallow checkout is fine as long as no graft falls inside the range.
if (git("rev-parse", "--is-shallow-repository") === "true") {
  const shallowFile = git("rev-parse", "--path-format=absolute", "--git-path", "shallow");
  const grafts = new Set(readFileSync(shallowFile, "utf8").split("\n").filter(Boolean));
  if (git("rev-list", `${lastTag}..${head}`).split("\n").some((sha) => grafts.has(sha))) {
    console.error(`shallow clone cuts the ${lastTag}..${head} range; run git fetch --unshallow`);
    process.exit(2);
  }
}

const OSES = ["macos", "linux", "windows"];
// Files only the release pipeline exercises, which OSes each affects, and
// which OSes a green nightly counts as proof for. The nightly packages, signs,
// notarizes and writes update metadata for macOS and Linux only, but for the
// shared packaging inputs it stands in for Windows too: a Windows-only break
// from a shared change surfaces in the tag run before Windows publishes, where
// a re-tag fixes it for about what a dry run would have cost, and shared
// builder config changes nearly every release. Windows-specific inputs still
// need Windows evidence. The publish actions are listed so they show up, but
// no dry run can prove them: dry runs skip publishing.
const RELEASE_ONLY = [
  { re: /^build\/windows\/|^build\/installer\.nsh$|^build\/icon\.ico$/, oses: ["windows"], nightly: [] },
  { re: /^build\/macos\/|^build\/entitlements|^build\/(AppIcon\.icon|icon\.icns)|^scripts\/notarize-macos\.cjs$|^scripts\/ci\/verify-.*\.sh$/, oses: ["macos"], nightly: ["macos"] },
  { re: /^build\/linux\//, oses: ["linux"], nightly: ["linux"] },
  { re: /^build\/|^electron-builder\.config\.cjs$|^scripts\/afterPack\.cjs$|^scripts\/run-packaged-smoke\.mjs$/, oses: OSES, nightly: OSES },
  { re: /^scripts\/ci\/(generate|validate)-update-metadata\.mjs$/, oses: OSES, nightly: OSES },
  { re: /^\.github\/workflows\/release-macos\.yml$/, oses: ["macos"], nightly: [] },
  { re: /^\.github\/workflows\/release-linux\.yml$/, oses: ["linux"], nightly: [] },
  { re: /^\.github\/workflows\/release-windows\.yml$/, oses: ["windows"], nightly: [] },
  { re: /^\.github\/actions\/resolve-update-metadata-prefix\//, oses: OSES, nightly: [] },
  { re: /^\.github\/actions\/(publish-daintree|website-notify)\//, oses: OSES, nightly: [], publishOnly: true },
];
const ruleFor = (file) => RELEASE_ONLY.find((r) => r.re.test(file));
// Shipped code: what the build users get is made from. Kept in step with
// SHIPPED in collect-changes.mjs.
const SHIPPED = /^(src|electron|shared|plugins\/builtin|packages\/tour\/src|assistant)\//;
const TEST = /(__tests__|\.test\.|\.spec\.|\/test\/|\/fixtures?\/)/;
const DEPENDENCY_FILES = ["package.json", "package-lock.json"];

function changesSince(base) {
  const subjects = git("log", "--merges", "--first-parent", "--format=%s", `${base}..${head}`);
  const numstat = git("-c", "diff.renames=false", "diff", "--numstat", `${base}..${head}`)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [add, del, file] = l.split("\t");
      return { file, lines: (Number(add) || 0) + (Number(del) || 0) };
    });
  return {
    prs: (subjects.match(/^Merge pull request #\d+/gm) ?? []).length,
    directCommits: git("log", "--no-merges", "--first-parent", "--format=%h", `${base}..${head}`).split("\n").filter(Boolean)
      .length,
    shippedLines: numstat.filter((f) => SHIPPED.test(f.file) && !TEST.test(f.file)).reduce((n, f) => n + f.lines, 0),
    releaseOnlyFiles: numstat.map((f) => f.file).filter((f) => ruleFor(f)),
    dependenciesChanged: DEPENDENCY_FILES.some((f) => blob(base, f) !== blob(head, f)),
  };
}

const reasons = [];
const oses = new Set();
const need = (why, which = OSES) => {
  reasons.push(why);
  which.forEach((os) => oses.add(os));
};

// Stabilize: the newest stabilize/* branch counts only once it has finished,
// which the skill marks by deleting the branch from origin (both close-out
// cases). Its runs are often scoped re-runs, so the last run's success alone
// says little while the branch is still open.
const stabilizeRuns = gh(
  "run",
  "list",
  "--workflow=stabilize.yml",
  "--limit",
  "100",
  "--json",
  "headBranch,headSha,status,conclusion,updatedAt,url"
).filter((r) => r.headBranch.startsWith("stabilize/"));
let stabilize = null;
if (!stabilizeRuns.length) need("no stabilize run found");
else {
  const branch = stabilizeRuns[0].headBranch;
  const runs = stabilizeRuns.filter((r) => r.headBranch === branch);
  const last = runs[0];
  // ls-remote --exit-code exits 2 when the ref is absent; any other failure
  // (network, auth) must not read as "finished".
  let open;
  try {
    execFileSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { stdio: "ignore" });
    open = true;
  } catch (err) {
    if (err.status !== 2) {
      console.error(`could not check whether ${branch} is still on origin: git ls-remote exited ${err.status}`);
      process.exit(2);
    }
    open = false;
  }
  const base = haveCommit(last.headSha) ? tryGit("merge-base", last.headSha, head) : null;
  stabilize = {
    branch,
    lastRun: last.url,
    conclusion: last.conclusion,
    finished: !open && runs.every((r) => r.status === "completed"),
    ageHours: Math.round(((Date.now() - Date.parse(last.updatedAt)) / 36e5) * 10) / 10,
    validatedSha: last.headSha.slice(0, 10),
    validatedBase: base?.slice(0, 10) ?? null,
    since: base ? changesSince(base) : null,
  };
  if (!stabilize.finished) need(`stabilize on ${branch} hasn't finished (branch still on origin or a run in flight)`);
  if (last.conclusion !== "success") need(`the last stabilize run on ${branch} ended ${last.conclusion}`);
  if (stabilize.ageHours > maxAgeHours) need(`stabilize last ran ${stabilize.ageHours} h ago (limit ${maxAgeHours} h)`);
  const s = stabilize.since;
  if (!s) need(`could not place ${branch}'s validated commit on develop`);
  else {
    if (s.prs > maxPrs) need(`${s.prs} PRs merged since stabilize (limit ${maxPrs})`);
    if (s.shippedLines > maxLines) need(`${s.shippedLines} lines of shipped code changed since stabilize (limit ${maxLines})`);
    if (s.dependenciesChanged) need("package.json or package-lock.json changed since stabilize");
  }
}

// Release-only files changed since the last tag. Each affected OS needs
// evidence that built this exact content: a green develop nightly (macOS and
// Linux, for the paths it exercises) or a green full dry run, compared blob by
// blob against the head. Ancestry alone isn't enough: a later commit can revert
// or change the file again.
const sinceRelease = changesSince(lastTag);
const nightly =
  gh("run", "list", "--workflow=nightly-publish.yml", "--branch", "develop", "--limit", "10", "--json", "headSha,conclusion,updatedAt,url").find(
    (r) => r.conclusion === "success"
  ) ?? null;
const nightlySha = nightly && haveCommit(nightly.headSha) ? nightly.headSha : null;

// A dry run counts only when it ran the full pipeline: the build job succeeded
// (a Windows dispatch with smoke_artifact_run_id skips it), on macOS the
// notarization staple was verified (skip_notarization bypasses it), and
// nothing in the dependency files differs from the head.
const dryRuns = {};
for (const os of OSES) {
  const candidates = gh("run", "list", `--workflow=release-${os}.yml`, "--event", "workflow_dispatch", "--limit", "10", "--json", "databaseId,headSha,conclusion,updatedAt,url").filter(
    (r) => r.conclusion === "success"
  );
  dryRuns[os] =
    candidates.find((r) => {
      if (!haveCommit(r.headSha)) return false;
      const jobs = gh("run", "view", String(r.databaseId), "--json", "jobs").jobs;
      const builds = jobs.filter((j) => /build/i.test(j.name) && !/e2e/i.test(j.name) && j.conclusion === "success");
      if (!builds.length) return false;
      return (
        os !== "macos" ||
        builds.some((j) => j.steps?.some((st) => /notarization staple/i.test(st.name) && st.conclusion === "success"))
      );
    }) ?? null;
}
const provenBy = (sha, file) => sha && blob(sha, file) === blob(head, file);
const dryRunProves = (os, file) => {
  const r = dryRuns[os];
  return r && provenBy(r.headSha, file) && DEPENDENCY_FILES.every((f) => provenBy(r.headSha, f));
};

const unproven = [];
const publishOnly = [];
for (const file of sinceRelease.releaseOnlyFiles) {
  const rule = ruleFor(file);
  if (rule.publishOnly) {
    publishOnly.push(file);
    continue;
  }
  const missing = rule.oses.filter((os) => !(rule.nightly.includes(os) && provenBy(nightlySha, file)) && !dryRunProves(os, file));
  if (missing.length) unproven.push({ file, oses: missing });
}
for (const os of OSES) {
  const files = unproven.filter((u) => u.oses.includes(os)).map((u) => u.file);
  if (files.length) need(`${os}: release-pipeline files changed since ${lastTag} that no green nightly or dry run has built: ${files.slice(0, 6).join(", ")}`, [os]);
}

const recommend = oses.size ? "dry-run" : "skip";
if (recommend === "skip") {
  reasons.push(
    `stabilize finished green ${stabilize.ageHours} h ago on ${stabilize.branch}; ${stabilize.since.prs} PRs and ${stabilize.since.shippedLines} shipped lines landed since, and every release-pipeline change since ${lastTag} has been built by a nightly or dry run`
  );
}
if (publishOnly.length) {
  reasons.push(`publish-path files changed since ${lastTag} (no dry run exercises them; watch the first publish): ${publishOnly.join(", ")}`);
}

const short = (r) => (r ? { sha: r.headSha.slice(0, 10), at: r.updatedAt, url: r.url } : null);
console.log(
  JSON.stringify(
    {
      recommend,
      oses: OSES.filter((os) => oses.has(os)),
      reasons,
      facts: {
        head: head.slice(0, 10),
        lastTag,
        stabilize,
        sinceRelease: { ...sinceRelease, releaseOnlyFiles: sinceRelease.releaseOnlyFiles.slice(0, 20), unproven, publishOnly },
        nightly: short(nightly),
        dryRuns: Object.fromEntries(OSES.map((os) => [os, short(dryRuns[os])])),
      },
    },
    null,
    2
  )
);
