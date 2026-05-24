#!/usr/bin/env node

// PR-trigger arm of the fix-with-test ratio gate. Classifies the single current
// PR and emits a non-blocking ::notice:: when it looks like a fix but didn't
// touch any test files. Informational only — never exits non-zero.
//
// Usage (in CI):
//   git diff --name-only "origin/$BASE...HEAD" | PR_TITLE="$TITLE" node scripts/check-pr-test-ratio.mjs
//
// Input contract:
//   - Changed file paths arrive on stdin, one per line.
//   - The PR title arrives via the PR_TITLE env var (kept out of the shell line
//     so an untrusted title can't be interpreted as a command).

import { classifyPR, shouldRemindAboutTests } from "./test-ratio-lib.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  const files = raw
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter(Boolean)
    .map((path) => ({ path }));

  const classified = classifyPR({
    number: 0,
    title: process.env.PR_TITLE ?? "",
    files: { nodes: files },
  });

  if (shouldRemindAboutTests(classified)) {
    console.log(
      "::notice title=Test coverage reminder::This PR looks like a fix but didn't touch any test files. Consider adding a regression test."
    );
  }
}

// Informational only — never fail the PR. Swallow any unexpected runtime error.
main().catch((err) => {
  console.error(`check-pr-test-ratio: skipped due to unexpected error: ${err?.message ?? err}`);
});
