#!/usr/bin/env node

/**
 * E2E Wait-Discipline Ratchet
 *
 * Counts two wait anti-patterns per file across the E2E suite and fails when
 * any file's count for a rule grows beyond its baseline:
 *
 *   - waitForTimeout: a `waitForTimeout(...)` call with no `// timer: <name>`
 *     comment on the method name's line or the line directly above. A fixed sleep is
 *     only legitimate when it spans a named product timer; everything else
 *     should poll.
 *   - isVisibleTimeout: `.isVisible({ timeout })`. Playwright ignores that
 *     timeout and returns immediately, so it reads like a wait but is not one.
 *
 * Files are parsed with the TypeScript compiler API so comments and strings
 * cannot produce false matches. Opt-in harnesses with their own Playwright
 * configs (and the screenshot/demo tooling) are excluded.
 *
 * Usage:
 *   node scripts/ci/check-e2e-waits.mjs                   # check mode (CI)
 *   node scripts/ci/check-e2e-waits.mjs --update          # write current counts as new baseline
 *   node scripts/ci/check-e2e-waits.mjs --update --force  # bypass the shrinkage guard
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, relative, sep } from "path";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");
const E2E_DIR = join(ROOT, "e2e");
const BASELINE_FILE = join(ROOT, "scripts", "baselines", "e2e-waits-baseline.json");
const UPDATE_SHRINKAGE_THRESHOLD = 0.1;

export const RULES = ["waitForTimeout", "isVisibleTimeout"];

// Top-level e2e/ directories outside the ratchet: opt-in harnesses with their
// own Playwright configs, plus screenshot and demo recording tooling.
export const EXCLUDED_DIRS = ["assistant", "demo", "mechanism", "plugins", "screenshots"];

const TIMER_COMMENT = /^\/\/\s*timer:\s*\S/;

function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Returns `{ text, node }` for the called method, or null for dynamic callees. */
function calleeName(expression) {
  const callee = unwrap(expression);
  if (ts.isPropertyAccessExpression(callee)) return { text: callee.name.text, node: callee.name };
  if (ts.isIdentifier(callee)) return { text: callee.text, node: callee };
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return { text: callee.argumentExpression.text, node: callee.argumentExpression };
  }
  return null;
}

function propertyNameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

// Options passed through a variable are not resolved; only inline object
// literals (including spread literals) are inspected.
function hasTimeoutProperty(arg) {
  const options = unwrap(arg);
  if (!ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((p) => {
    if (ts.isSpreadAssignment(p)) return hasTimeoutProperty(p.expression);
    return (
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      propertyNameText(p.name) === "timeout"
    );
  });
}

/**
 * Returns `Map<line, { ownLine: boolean }>` for every line holding a
 * `// timer: <name>` comment. `ownLine` is true when nothing but whitespace
 * precedes the comment, which is required for it to annotate the next line.
 */
function collectTimerComments(sourceFile) {
  const text = sourceFile.text;
  const seen = new Set();
  const timerLines = new Map();

  const record = (range) => {
    if (seen.has(range.pos)) return;
    seen.add(range.pos);
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) return;
    if (!TIMER_COMMENT.test(text.slice(range.pos, range.end))) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(range.pos);
    const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
    const ownLine = text.slice(lineStart, lineStart + character).trim() === "";
    const prior = timerLines.get(line);
    timerLines.set(line, { ownLine: ownLine || Boolean(prior?.ownLine) });
  };

  const visit = (node) => {
    ts.forEachLeadingCommentRange(text, node.pos, (pos, end, kind) => record({ pos, end, kind }));
    ts.forEachTrailingCommentRange(text, node.end, (pos, end, kind) => record({ pos, end, kind }));
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return timerLines;
}

/**
 * Analyse one source file. Returns `{ waitForTimeout: number[], isVisibleTimeout: number[] }`
 * where each array holds the 1-based line numbers of offending calls.
 */
export function analyzeSource(source, fileName = "file.ts") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const timerLines = collectTimerComments(sourceFile);
  const result = { waitForTimeout: [], isVisibleTimeout: [] };

  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line;
  const isExempt = (line) => timerLines.has(line) || timerLines.get(line - 1)?.ownLine === true;

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name?.text === "waitForTimeout") {
        // Anchored to the method name so a comment on an earlier line of a
        // long chain cannot exempt it.
        const nameLine = lineOf(name.node.getStart(sourceFile));
        if (!isExempt(nameLine)) result.waitForTimeout.push(nameLine + 1);
      } else if (name?.text === "isVisible" && node.arguments.some(hasTimeoutProperty)) {
        result.isVisibleTimeout.push(lineOf(name.node.getStart(sourceFile)) + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function listFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

export function isExcluded(relPath) {
  const parts = relPath.split("/");
  return parts[0] === "e2e" && EXCLUDED_DIRS.includes(parts[1]);
}

/**
 * Scan e2e/ and return `{ files: { [relPath]: { [rule]: number[] } } }` for
 * every file with at least one finding, keyed by POSIX path from the repo root.
 */
export function scanE2e(root = ROOT) {
  const files = {};
  const e2eDir = join(root, "e2e");
  for (const full of listFiles(e2eDir).sort()) {
    const rel = relative(root, full).split(sep).join("/");
    if (isExcluded(rel)) continue;
    const findings = analyzeSource(readFileSync(full, "utf8"), rel);
    if (RULES.some((rule) => findings[rule].length > 0)) files[rel] = findings;
  }
  return files;
}

export function buildBaseline(scan) {
  const totals = Object.fromEntries(RULES.map((rule) => [rule, 0]));
  const files = {};
  for (const rel of Object.keys(scan).sort()) {
    const counts = {};
    for (const rule of RULES) {
      const n = scan[rel][rule].length;
      totals[rule] += n;
      if (n > 0) counts[rule] = n;
    }
    if (Object.keys(counts).length > 0) files[rel] = counts;
  }
  return { totals, files };
}

/**
 * Compare a scan to a baseline. Returns `{ violations, decreases }`:
 *   violations: `{ file, rule, count, baseline, lines }` where count grew
 *   decreases:  `{ file, rule, count, baseline }` where count shrank
 * A file absent from the baseline has a baseline of 0 for every rule.
 */
export function compareToBaseline(scan, baseline) {
  const violations = [];
  const decreases = [];
  const baseFiles = baseline?.files ?? {};
  const allFiles = new Set([...Object.keys(scan), ...Object.keys(baseFiles)]);
  for (const file of [...allFiles].sort()) {
    for (const rule of RULES) {
      const lines = scan[file]?.[rule] ?? [];
      const count = lines.length;
      const base = baseFiles[file]?.[rule] ?? 0;
      if (count > base) violations.push({ file, rule, count, baseline: base, lines });
      else if (count < base) decreases.push({ file, rule, count, baseline: base });
    }
  }
  return { violations, decreases };
}

/**
 * Guards `--update` against a sudden large drop in any rule's total, which
 * usually signals a parser or file-walk bug — locking that undercount in
 * would silently re-allow regressions.
 */
export function checkShrinkageGuard(
  priorTotals,
  newTotals,
  force,
  threshold = UPDATE_SHRINKAGE_THRESHOLD
) {
  if (force) return { blocked: false };
  for (const rule of RULES) {
    const prior = priorTotals?.[rule];
    if (!Number.isFinite(prior) || prior <= 0) continue;
    const drop = (prior - (newTotals[rule] ?? 0)) / prior;
    if (drop > threshold) {
      return {
        blocked: true,
        message: `::error::refusing to update baseline — ${rule} total would drop from ${prior} to ${newTotals[rule]} (${(drop * 100).toFixed(1)}% shrinkage > ${(threshold * 100).toFixed(0)}% threshold).`,
      };
    }
  }
  return { blocked: false };
}

const RULE_HELP = {
  waitForTimeout:
    "Poll instead (expect.poll, web-first assertions). A fixed sleep is only allowed to span a documented product timer, with `// timer: <name>` on the same or previous line.",
  isVisibleTimeout:
    "isVisible() ignores its timeout and returns immediately. Use `await expect(locator).toBeVisible({ timeout })` to wait, or plain `isVisible()` for an instant probe.",
};

function main() {
  const isUpdate = process.argv.includes("--update");
  const force = process.argv.includes("--force");

  if (!existsSync(E2E_DIR)) {
    console.error(`❌ E2E directory not found: ${E2E_DIR}`);
    process.exit(1);
  }

  const scan = scanE2e();
  const current = buildBaseline(scan);
  console.log(`📊 E2E waits: ${RULES.map((rule) => `${rule} ${current.totals[rule]}`).join(", ")}`);

  if (isUpdate) {
    if (existsSync(BASELINE_FILE)) {
      let priorTotals = null;
      try {
        priorTotals = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))?.totals ?? null;
      } catch {
        // Unparseable prior baseline — nothing trustworthy to guard against.
      }
      const guard = checkShrinkageGuard(priorTotals, current.totals, force);
      if (guard.blocked) {
        console.error(guard.message);
        console.error("   This usually means the scan broke (parser or directory walk).");
        console.error("   If the shrinkage is intentional, re-run with --force.");
        process.exit(1);
      }
    }
    const baseline = { ...current, updatedAt: new Date().toISOString() };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`✅ Baseline updated: ${relative(ROOT, BASELINE_FILE)}`);
    return;
  }

  if (!existsSync(BASELINE_FILE)) {
    console.error(`❌ Baseline file not found: ${BASELINE_FILE}`);
    console.error("   Run: node scripts/ci/check-e2e-waits.mjs --update");
    process.exit(1);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch (err) {
    console.error(`❌ Failed to parse baseline file: ${BASELINE_FILE}`);
    console.error(`   Error: ${err.message}`);
    process.exit(1);
  }
  if (!baseline || typeof baseline.files !== "object" || baseline.files === null) {
    console.error("❌ Invalid baseline: missing `files` map");
    process.exit(1);
  }

  const { violations, decreases } = compareToBaseline(scan, baseline);

  if (violations.length > 0) {
    console.error(`❌ E2E wait discipline regressed in ${violations.length} file/rule pair(s):`);
    for (const v of violations) {
      console.error(`\n   ${v.rule} in ${v.file}: ${v.count} (baseline: ${v.baseline})`);
      for (const line of v.lines) console.error(`     ${v.file}:${line}`);
    }
    for (const rule of new Set(violations.map((v) => v.rule))) {
      console.error(`\n   ${rule}: ${RULE_HELP[rule]}`);
    }
    process.exit(1);
  }

  if (decreases.length > 0) {
    const saved = decreases.reduce((sum, d) => sum + (d.baseline - d.count), 0);
    console.log(`🎉 ${saved} wait(s) removed across ${decreases.length} file/rule pair(s).`);
    console.log("   Lower the baseline: node scripts/ci/check-e2e-waits.mjs --update");
  } else {
    console.log("✅ No new fixed sleeps or isVisible timeouts.");
  }
}

const invokedDirectly = process.argv[1] && process.argv[1] === __filename;
if (invokedDirectly) {
  main();
}
