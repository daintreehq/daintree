#!/usr/bin/env node

/**
 * ESLint Warning Ratchet
 *
 * Fails the build if ESLint warnings increase beyond the baseline.
 * This allows gradual reduction of warnings without introducing new ones.
 *
 * Two tiers of enforcement:
 *   - Total count: `baseline.count` — the canonical aggregate gate.
 *   - Per-rule: `baseline.byRule` — a `{ ruleId: count }` map that catches
 *     "warning-shifting" (fixing one rule while introducing another keeps the
 *     total flat). Any single rule's count increasing fails the build with the
 *     named rule and delta. A rule disappearing from live output while still in
 *     the baseline is a hard failure too — silencing a rule in config would
 *     otherwise drop the total and sneak past the count gate.
 *
 * Usage:
 *   node scripts/lint-ratchet.mjs                   # check mode (CI)
 *   node scripts/lint-ratchet.mjs --update          # write current counts as new baseline
 *   node scripts/lint-ratchet.mjs --update --force  # bypass the shrinkage / disappeared guards
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const BASELINE_FILE = join(ROOT, "scripts", "baselines", "eslint-warnings-baseline.json");
const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

// Test files still get linted (editor + raw `npm run lint`), but their warnings
// don't count toward the ratchet — test patterns like `as Foo` partial mocks
// aren't product debt. Errors are still counted for all files below.
const TEST_FILE_PATTERN = /[/\\](__tests__|e2e)[/\\]|\.(?:test|spec)\.[^.]+$/;

/**
 * Core shrinkage guard. Returns `{ blocked: true, message }` when the count
 * would drop by more than `threshold` (proportionally), else `{ blocked: false }`.
 * `force` bypasses the guard entirely. Used for both the total count and, in
 * --update mode, each individual rule's count.
 */
export function checkShrinkageGuard(
  priorCount,
  newCount,
  force,
  threshold = UPDATE_SHRINKAGE_THRESHOLD
) {
  if (force) return { blocked: false };

  if (priorCount > 0 && Number.isFinite(priorCount)) {
    const drop = (priorCount - newCount) / priorCount;
    if (drop > threshold) {
      return {
        blocked: true,
        message: `::error::refusing to update baseline — warning count would drop from ${priorCount} to ${newCount} (${(drop * 100).toFixed(1)}% shrinkage > ${(threshold * 100).toFixed(0)}% threshold).`,
      };
    }
  }

  return { blocked: false };
}

/**
 * Tally severity-1 (warning) messages per rule across the already-filtered
 * production results. Messages with a null `ruleId` (parse/syntax errors) are
 * always severity 2, so the `msg.ruleId` guard naturally excludes them.
 * Returns a `{ ruleId: count }` object with keys sorted for deterministic diffs.
 */
export function aggregateByRule(productionResults) {
  // Null-prototype object so a rule named "constructor"/"toString" can't collide
  // with an inherited member (the `?? 0` guard wouldn't fire on a real function).
  const tally = Object.create(null);
  for (const file of productionResults) {
    for (const msg of file.messages) {
      if (msg.severity === 1 && msg.ruleId) {
        tally[msg.ruleId] = (tally[msg.ruleId] ?? 0) + 1;
      }
    }
  }
  return Object.fromEntries(Object.entries(tally).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Compare a baseline `byRule` map against the live one. Pure — returns
 * structured findings; the caller formats and decides exit status.
 *   - disappeared: rules in the baseline absent from live output (hard failure;
 *     someone silenced the rule, masking the loss behind the flat total).
 *   - regressed: rules whose live count exceeds the baseline (the warning-shift).
 *   - newRules: rules present in live output but not the baseline (a new class
 *     of violation that wasn't previously tracked).
 */
export function checkByRule(baselineByRule, liveByRule) {
  const disappeared = [];
  const regressed = [];
  const newRules = [];

  for (const [rule, from] of Object.entries(baselineByRule)) {
    // Object.hasOwn (not `in` / direct lookup) so prototype members like
    // "toString" don't masquerade as present rules.
    if (!Object.hasOwn(liveByRule, rule)) {
      disappeared.push(rule);
      continue;
    }
    const to = liveByRule[rule];
    if (to > from) {
      regressed.push({ rule, from, to, delta: to - from });
    }
  }

  for (const [rule, to] of Object.entries(liveByRule)) {
    if (!Object.hasOwn(baselineByRule, rule)) {
      newRules.push({ rule, to });
    }
  }

  return { disappeared, regressed, newRules };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function main() {
  const isUpdate = process.argv.includes("--update");
  const force = process.argv.includes("--force");

  // Run ESLint and capture output
  let lintOutput;
  try {
    lintOutput = execSync("npx eslint . --format json", {
      cwd: ROOT,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large output
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // ESLint loading the whole tree + the typescript-eslint parser routinely
        // approaches Node's default ~2 GB old-space ceiling and OOMs on the macOS
        // nightly runner. Bump headroom so JSON formatter has room for the full
        // result graph. Appended so any caller-provided NODE_OPTIONS wins on tie.
        NODE_OPTIONS: `--max-old-space-size=4096 ${process.env.NODE_OPTIONS ?? ""}`.trim(),
      },
    });
  } catch (error) {
    // ESLint exits with code 1 when there are warnings/errors
    // The output is still valid JSON in stdout
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      console.error("❌ ESLint output exceeded buffer size (50MB)");
      console.error("   Try reducing the number of files or increasing maxBuffer");
      process.exit(1);
    }

    lintOutput = error.stdout || "";

    // If stdout is empty, ESLint likely failed before producing JSON
    if (!lintOutput || lintOutput.trim() === "") {
      console.error("❌ ESLint failed to produce output");
      console.error("   Error:", error.message);
      if (error.stderr) {
        console.error("   stderr:", error.stderr);
      }
      process.exit(1);
    }
  }

  let results;
  try {
    results = JSON.parse(lintOutput);
  } catch (error) {
    console.error("❌ Failed to parse ESLint JSON output");
    console.error("First 500 chars of output:", lintOutput.substring(0, 500));
    console.error("Parse error:", error.message);
    process.exit(1);
  }

  // Warnings: exclude test files. Errors: count every file — the ratchet is
  // the only ESLint gate in CI (`npm run check` calls `lint:ratchet`), so
  // test-file errors must still block the build.
  const productionResults = results.filter((file) => !TEST_FILE_PATTERN.test(file.filePath));

  // `warningCount` counts every severity-1 message; `byRule` (below) only counts
  // those with a non-null ruleId. They stay in sync because ESLint emits
  // null-ruleId messages as severity 2 (parse errors) under the current
  // invocation — this divergence assumption only breaks if a flag like
  // --report-unused-disable-directives is added, which would emit severity-1
  // null-ruleId messages. `count` remains the canonical total either way.
  const warningCount = productionResults.reduce((sum, file) => {
    return sum + file.messages.filter((msg) => msg.severity === 1).length;
  }, 0);

  const errorCount = results.reduce((sum, file) => {
    return sum + file.messages.filter((msg) => msg.severity === 2).length;
  }, 0);

  const byRule = aggregateByRule(productionResults);

  console.log(`📊 Current ESLint warnings: ${warningCount}`);

  // Always fail if there are errors
  if (errorCount > 0) {
    console.error(`❌ ESLint errors detected: ${errorCount}`);
    console.error("   Fix all errors before proceeding");
    process.exit(1);
  }

  // Update mode: save current counts as new baseline
  if (isUpdate) {
    // Total shrinkage guard: if the warning count drops by more than the
    // threshold compared to the prior baseline, refuse to update. This prevents
    // a config bug (e.g. .eslintignore expansion, file-pattern narrowing) from
    // silently locking in undercounting as the new baseline.
    if (existsSync(BASELINE_FILE) && !force) {
      let prior = null;
      try {
        prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
      } catch {
        // Unparseable prior baseline — let the update proceed; the previous
        // baseline is unusable anyway.
      }

      const priorCount =
        prior && typeof prior.count === "number" && Number.isFinite(prior.count) ? prior.count : 0;

      const totalGuard = checkShrinkageGuard(priorCount, warningCount, force);
      if (totalGuard.blocked) {
        console.error(totalGuard.message);
        console.error(
          "   This usually means ESLint coverage shrank (config change, .eslintignore expansion, or file-pattern narrowing)."
        );
        console.error("   If the shrinkage is intentional, re-run with --force.");
        process.exit(1);
      }

      // Per-rule guards: a rule disappearing entirely, or shrinking by more than
      // the threshold, is treated the same as the total — refuse the update so
      // an accidental config change can't bake in a coverage loss. --force is
      // the deliberate escape hatch (it skips this whole block).
      if (prior && isPlainObject(prior.byRule)) {
        const disappeared = [];
        const shrunk = [];
        for (const [rule, priorRuleCount] of Object.entries(prior.byRule)) {
          if (!Object.hasOwn(byRule, rule)) {
            disappeared.push({ rule, from: priorRuleCount });
            continue;
          }
          const liveRuleCount = byRule[rule];
          const guard = checkShrinkageGuard(priorRuleCount, liveRuleCount, force);
          if (guard.blocked) {
            shrunk.push({ rule, from: priorRuleCount, to: liveRuleCount });
          }
        }

        if (disappeared.length > 0 || shrunk.length > 0) {
          for (const { rule, from } of disappeared) {
            console.error(
              `::error::refusing to update baseline — rule "${rule}" disappeared from live output (baseline: ${from}). A silenced or removed rule must not be dropped silently.`
            );
          }
          for (const { rule, from, to } of shrunk) {
            const drop = (((from - to) / from) * 100).toFixed(1);
            console.error(
              `::error::refusing to update baseline — rule "${rule}" would drop from ${from} to ${to} (${drop}% shrinkage > ${(UPDATE_SHRINKAGE_THRESHOLD * 100).toFixed(0)}% threshold).`
            );
          }
          console.error(
            "   This usually means ESLint coverage shrank (a rule was disabled, or file patterns narrowed)."
          );
          console.error("   If the shrinkage is intentional, re-run with --force.");
          process.exit(1);
        }
      }
    }

    const baseline = { count: warningCount, byRule, updatedAt: new Date().toISOString() };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `✅ Baseline updated: ${warningCount} warnings across ${Object.keys(byRule).length} rules`
    );
    return;
  }

  // Check mode: compare against baseline
  if (!existsSync(BASELINE_FILE)) {
    console.error(`❌ Baseline file not found: ${BASELINE_FILE}`);
    console.error(`   Run: npm run lint:ratchet -- --update`);
    process.exit(1);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  } catch (error) {
    console.error(`❌ Failed to parse baseline file: ${BASELINE_FILE}`);
    console.error(`   Error: ${error.message}`);
    process.exit(1);
  }

  // Validate baseline structure
  if (typeof baseline.count !== "number" || baseline.count < 0) {
    console.error(`❌ Invalid baseline: count must be a non-negative number`);
    console.error(`   Found: ${JSON.stringify(baseline.count)}`);
    process.exit(1);
  }

  const baselineCount = baseline.count;
  const diff = warningCount - baselineCount;

  let failed = false;

  if (diff > 0) {
    console.error(`❌ ESLint warnings increased by ${diff} (baseline: ${baselineCount})`);
    console.error(`   Fix the new warnings or run: npm run lint:ratchet -- --update`);
    failed = true;
  } else if (diff < 0) {
    console.log(`🎉 ESLint warnings decreased by ${Math.abs(diff)}! (baseline: ${baselineCount})`);
    console.log(`   Update baseline: npm run lint:ratchet -- --update`);
  } else {
    console.log(`✅ No new warnings introduced (baseline: ${baselineCount})`);
  }

  // Per-rule check: catches warning-shifting that the flat total can't see.
  if (isPlainObject(baseline.byRule)) {
    const { disappeared, regressed, newRules } = checkByRule(baseline.byRule, byRule);

    if (disappeared.length > 0 || regressed.length > 0 || newRules.length > 0) {
      for (const { rule, from, to, delta } of regressed) {
        console.error(
          `::error::rule "${rule}" increased by ${delta} (baseline: ${from}, live: ${to})`
        );
      }
      for (const { rule, to } of newRules) {
        console.error(
          `::error::new rule "${rule}" introduced ${to} warning(s) not present in the baseline`
        );
      }
      for (const rule of disappeared) {
        console.error(
          `::error::rule "${rule}" disappeared from live output (baseline: ${baseline.byRule[rule]}). A silenced or removed rule must not drop silently — restore it or run: npm run lint:ratchet -- --update`
        );
      }
      console.error(
        `   Per-rule ratchet failed. Fix the regressing rule(s) or run: npm run lint:ratchet -- --update`
      );
      failed = true;
    }
  } else {
    console.warn(
      `⚠️  Baseline has no per-rule data. Run: npm run lint:ratchet -- --update to enable per-rule tracking.`
    );
  }

  if (failed) {
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && process.argv[1] === __filename;
if (invokedDirectly) {
  main();
}
