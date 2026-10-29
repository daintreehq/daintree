#!/usr/bin/env node
// Collects everything that landed on develop since the last release tag and
// splits it into scope-clustered chunks for the changelog analysts.
//
// Usage: node collect-changes.mjs --out <dir> [--base v0.46.0] [--head <sha|ref>] [--chunk 40]
//
// PR numbers come from develop's first-parent merge commits in base..head, not
// from a merged-date search, so a PR merged on release day before the tag is
// never double-counted and one merged after it is never missed. Direct commits
// on develop (no PR) are listed too.
//
// Writes:
//   <out>/summary.json   counts by type, chunk index, internal list, direct commits
//   <out>/chunk-NN.json  PRs for one analyst, related scopes kept together
//   <out>/internal.json  test/ci/docs/chore/build/style PRs (titles only)
//   <out>/direct.json    non-merge first-parent commits on develop, plus any
//                        first-parent merge that isn't a PR merge (its side
//                        history isn't analysed; the editor reads it by hand)
//
// Each run replaces the directory's generated files, so a rerun with a
// different --chunk never leaves stale chunks behind.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const usage = (why) => {
  console.error(`${why}\nusage: collect-changes.mjs --out <dir> [--base <tag>] [--head <sha|ref>] [--chunk <n>]`);
  process.exit(2);
};
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i]?.replace(/^--/, "");
  const value = argv[i + 1];
  if (!argv[i]?.startsWith("--") || !["out", "base", "head", "chunk"].includes(key) || value === undefined || value.startsWith("--"))
    usage(`bad argument near ${argv[i] ?? "(end)"}`);
  args[key] = value;
}
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 }).trim();
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};

const out = args.out ?? usage("--out <dir> is required");
const chunkSize = Number(args.chunk ?? 40);
if (!Number.isInteger(chunkSize) || chunkSize < 1) usage("--chunk must be a positive integer");
const base = args.base ?? git("tag", "-l", "v*", "--sort=-version:refname").split("\n")[0];
const head = tryGit("rev-parse", args.head ?? "origin/develop") ?? usage(`unknown --head ${args.head}`);
// The tag needn't be an ancestor of develop (past re-tags left the tag's merge
// commit on main only); sharing history is enough for base..head.
if (!base || tryGit("merge-base", base, head) === null) usage(`no baseline tag sharing history with ${head}; git fetch origin --tags`);
if (git("rev-parse", "--is-shallow-repository") === "true") {
  const grafts = new Set(
    readFileSync(git("rev-parse", "--path-format=absolute", "--git-path", "shallow"), "utf8").split("\n").filter(Boolean)
  );
  if (git("rev-list", `${base}..${head}`).split("\n").some((sha) => grafts.has(sha)))
    usage(`shallow clone cuts the ${base}..${head} range; git fetch --unshallow`);
}
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (/^(chunk-\d+|summary|internal|direct)\.json$/.test(f)) rmSync(path.join(out, f));

const merges = git("log", "--merges", "--first-parent", "--format=%h%x09%s", `${base}..${head}`)
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [sha, subject] = l.split("\t");
    return { sha, subject, pr: Number(subject.match(/^Merge pull request #(\d+)/)?.[1]) || null };
  });
const prNumbers = [...new Set(merges.filter((m) => m.pr).map((m) => m.pr))];
const direct = [
  ...git("log", "--no-merges", "--first-parent", "--format=%h%x09%s", `${base}..${head}`)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split("\t");
      return { sha, subject };
    }),
  ...merges.filter((m) => !m.pr).map(({ sha, subject }) => ({ sha, subject, nonPrMerge: true })),
];

const FIELDS = `number title body mergedAt additions deletions changedFiles
  labels(first: 10) { nodes { name } }
  closingIssuesReferences(first: 10) { nodes { number title } }
  files(first: 100) { nodes { path } }`;

function fetchBatch(numbers) {
  const aliases = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${FIELDS} }`).join("\n");
  const query = `query { repository(owner: "daintreehq", name: "daintree") { ${aliases} } }`;
  for (let attempt = 1; ; attempt++) {
    try {
      const raw = execFileSync("gh", ["api", "graphql", "-f", `query=${query}`], {
        encoding: "utf8",
        maxBuffer: 64 << 20,
      });
      return Object.values(JSON.parse(raw).data.repository).filter(Boolean);
    } catch (err) {
      if (attempt >= 3) throw err;
      execFileSync("sleep", [String(attempt * 5)]);
    }
  }
}

const prs = [];
for (let i = 0; i < prNumbers.length; i += 25) prs.push(...fetchBatch(prNumbers.slice(i, i + 25)));

const TITLE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:/i;
const INTERNAL = new Set(["test", "ci", "docs", "chore", "build", "style"]);

const records = prs.map((p) => {
  const m = p.title.match(TITLE)?.groups ?? {};
  const type = (m.type ?? "other").toLowerCase();
  const scope = (m.scope ?? "").toLowerCase().split(/[/,]/)[0].trim() || "(none)";
  const breaking = Boolean(m.bang) || /BREAKING CHANGE/.test(p.body ?? "");
  return {
    number: p.number,
    filesTruncated: p.files.nodes.length < p.changedFiles,
    title: p.title,
    type,
    scope,
    breaking,
    mergedAt: p.mergedAt,
    size: `+${p.additions}/-${p.deletions} in ${p.changedFiles} files`,
    labels: p.labels.nodes.map((l) => l.name),
    closes: p.closingIssuesReferences.nodes.map((i) => `#${i.number} ${i.title}`),
    files: p.files.nodes.map((f) => f.path),
    body: (p.body ?? "").slice(0, 4000),
  };
});

// A docs/chore PR that touches shipped code is not internal; only drop it when
// every file it touches (all of them: a truncated list keeps the PR) is
// outside what the app is built from. Kept in step with SHIPPED in
// readiness.mjs, plus build/ for packaging inputs.
const SHIPPED = /^(src|electron|shared|plugins\/builtin|packages\/tour\/src|assistant|build)\//;
const isInternal = (r) =>
  !r.breaking &&
  !r.filesTruncated &&
  (INTERNAL.has(r.type) || r.type === "refactor") &&
  !r.files.some((f) => SHIPPED.test(f));
const internal = records.filter(isInternal);
const userFacing = records.filter((r) => !isInternal(r));

// Keep each scope in one chunk where it fits, so an add-then-revert pair or a
// run of follow-up fixes lands in front of the same analyst.
const byScope = new Map();
for (const r of userFacing.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt))) {
  if (!byScope.has(r.scope)) byScope.set(r.scope, []);
  byScope.get(r.scope).push(r);
}
const groups = [...byScope.entries()].sort((a, b) => b[1].length - a[1].length);
const chunks = [];
for (const [, list] of groups) {
  for (let i = 0; i < list.length; i += chunkSize) {
    const slice = list.slice(i, i + chunkSize);
    const target = chunks.find((c) => c.length + slice.length <= chunkSize);
    if (target) target.push(...slice);
    else chunks.push([...slice]);
  }
}

chunks.forEach((c, i) => {
  const name = `chunk-${String(i + 1).padStart(2, "0")}.json`;
  writeFileSync(path.join(out, name), JSON.stringify(c, null, 2));
});
writeFileSync(
  path.join(out, "internal.json"),
  JSON.stringify(
    internal.map(({ number, title }) => ({ number, title })),
    null,
    2
  )
);
writeFileSync(path.join(out, "direct.json"), JSON.stringify(direct, null, 2));

const countBy = (list, key) =>
  Object.fromEntries(
    Object.entries(list.reduce((acc, r) => ((acc[r[key]] = (acc[r[key]] ?? 0) + 1), acc), {})).sort(
      (a, b) => b[1] - a[1]
    )
  );
const summary = {
  base,
  head: head.slice(0, 10),
  prs: records.length,
  userFacing: userFacing.length,
  internal: internal.length,
  directCommits: direct.filter((d) => !d.nonPrMerge).length,
  nonPrMerges: direct.filter((d) => d.nonPrMerge).map((d) => `${d.sha} ${d.subject}`),
  breaking: records.filter((r) => r.breaking).map((r) => `#${r.number} ${r.title}`),
  byType: countBy(records, "type"),
  chunks: chunks.map((c, i) => ({
    file: `chunk-${String(i + 1).padStart(2, "0")}.json`,
    prs: c.length,
    scopes: [...new Set(c.map((r) => r.scope))],
  })),
};
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
