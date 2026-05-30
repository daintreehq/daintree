#!/usr/bin/env node

/**
 * Migration script: add structured annotations before every test.skip() call
 * in E2E spec files. Classifies each skip and inserts the annotation.
 *
 * Usage: node scripts/migrate-test-skips.mjs [--dry-run]
 *
 * Dry-run mode shows what would change without writing files.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const e2eDir = join(root, "e2e");
const dryRun = process.argv.includes("--dry-run");

function findSpecFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...findSpecFiles(full));
    } else if (entry.endsWith(".spec.ts")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Determine classification and description for a skip based on the
 * surrounding code. `lines` is the full file split by newlines.
 * `skipLine` is the 0-indexed line of the `test.skip(...)` call.
 */
function classify(skipLine, lines) {
  // Read the current and 3 preceding lines for context.
  const context = lines.slice(Math.max(0, skipLine - 3), skipLine + 1);
  const skipText = lines[skipLine].trim();

  // Already has annotation? Skip.
  const before = lines[Math.max(0, skipLine - 1)].trim();
  if (before.startsWith("test.info().annotations.push(")) return null;

  // Pattern: test.skip(process.platform === "...", "...")
  if (skipText.includes("process.platform")) {
    const reasonMatch = skipText.match(/,\s*"([^"]+)"/);
    const reason = reasonMatch ? reasonMatch[1] : "Platform-specific test";
    // Check if it also includes CI check
    if (skipText.includes("process.env.CI")) {
      return {
        type: "platform-skip",
        description: `Windows CI: ${reason}`,
      };
    }
    return { type: "platform-skip", description: reason };
  }

  // Pattern: test.skip(true, "reason") — quarantine
  if (/test\.skip\(\s*true\s*,/.test(skipText)) {
    const reasonMatch = skipText.match(/,\s*"([^"]+)"/);
    const reason = reasonMatch ? reasonMatch[1] : "Quarantined test";
    return { type: "quarantine", description: `2026-05-27 ${reason}` };
  }

  // Pattern: test.skip(() => true, "reason") — quarantine with callback
  if (skipText.includes("() => true")) {
    const reasonMatch = skipText.match(/,\s*"([^"]+)"/);
    const reason = reasonMatch ? reasonMatch[1] : "Quarantined test";
    return { type: "quarantine", description: `2026-05-27 ${reason}` };
  }

  // Pattern: test.skip(!hasClaudeApiKey(), "...") — API-key gate
  if (skipText.includes("hasClaudeApiKey")) {
    const reasonMatch = skipText.match(/,\s*"([^"]+)"/);
    const reason = reasonMatch ? reasonMatch[1] : "Anthropic API key required";
    return { type: "conditional-skip", description: reason };
  }

  // Pattern: test.skip(!process.env.OPENCODE_E2E_ENABLED, "...") — env-var gate
  if (skipText.includes("OPENCODE_E2E_ENABLED")) {
    const reasonMatch = skipText.match(/,\s*"([^"]+)"/);
    const reason = reasonMatch ? reasonMatch[1] : "OpenCode not enabled";
    return { type: "conditional-skip", description: reason };
  }

  // Pattern: test.skip("test name", async () => { — quarantine (full test skip)
  if (skipText.match(/test\.skip\(\s*"/)) {
    const nameMatch = skipText.match(/test\.skip\(\s*"([^"]+)"/);
    const reason = nameMatch ? `Full test quarantined: ${nameMatch[1]}` : "Quarantined test";
    return { type: "quarantine", description: `2026-05-27 ${reason}` };
  }

  // Pattern: bare test.skip() inside an if-block — conditional-fallback
  if (skipText === "test.skip();") {
    return {
      type: "conditional-skip",
      description: "Required element or state not available in this launch",
    };
  }

  // Unrecognized — classify as conditional-skip with generic description
  return { type: "conditional-skip", description: "Condition not met" };
}

/**
 * Derive an appropriate description by looking at the if-condition above the skip.
 */
function deriveConditionalDesc(skipLine, lines) {
  // Look at the closest lines above for an if-statement
  for (let i = skipLine - 1; i >= Math.max(0, skipLine - 4); i--) {
    const line = lines[i].trim();
    if (line.includes("devPreviewOpened")) {
      return "Dev preview panel was not opened (earlier test skipped)";
    }
    if (line.includes(".isVisible") && line.includes("devBtn")) {
      return "Dev preview toolbar button not visible in this launch state";
    }
    if (line.includes(".isVisible") && line.includes("addressBar")) {
      return "Dev preview address bar not visible (panel not open)";
    }
    if (line.includes(".isVisible") && line.includes("consoleToggle")) {
      return "Console drawer toggle not visible (panel not open)";
    }
    if (line.includes(".isVisible") && line.includes("zoomIn")) {
      return "Zoom controls not visible (dev preview panel not open)";
    }
    if (line.includes("before === 0")) {
      return "No panels to close in this launch state";
    }
    if (line.includes(".isVisible") && line.includes("startBtn")) {
      return "Agent start button not visible in this launch state";
    }
    if (line.includes(".isVisible") && line.includes("openPickerBtn")) {
      return "Command picker button not visible in this launch state";
    }
    if (line.includes("before === 0") && line.includes("getGridPanelCount")) {
      return "No panels present to close";
    }
    if (line.includes(".isVisible") && line.includes("portalBtn")) {
      return "Portal button not visible in this launch state";
    }
    if (line.includes(".isVisible") && line.includes("overflowTrigger")) {
      // core-radix-deferred: count check
      return "Overflow trigger count check (not a visibility gate)";
    }
    if (line.includes(".count()") || line.includes("before === null")) {
      return "Required state not available in this launch";
    }
  }
  return "Required element or state not available in this launch";
}

function processFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const edits = []; // { index: number, annotation: string }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Check if this line contains test.skip(...)
    if (!trimmed.match(/^\s*test\.skip\(/)) continue;

    // Already has annotation on the line before? Skip.
    if (i > 0 && lines[i - 1].trim().startsWith("test.info().annotations.push(")) continue;

    // Check if this is actually part of a different pattern (e.g. inside a
    // comment). Skip comments.
    if (trimmed.startsWith("//")) continue;

    // Bare test.skip() — use context-sensitive description
    if (trimmed === "test.skip();") {
      const desc = deriveConditionalDesc(i, lines);
      edits.push({
        index: i,
        annotation: `        test.info().annotations.push({\n          type: "conditional-skip",\n          description: "${desc}",\n        });\n`,
      });
      continue;
    }

    const classification = classify(i, lines);
    if (!classification) continue;

    // Find the indentation of the skip line
    const indent = lines[i].match(/^(\s*)/)[1];

    const annotation = `${indent}test.info().annotations.push({\n${indent}  type: "${classification.type}",\n${indent}  description: "${classification.description}",\n${indent}});\n`;

    edits.push({ index: i, annotation });
  }

  if (edits.length === 0) return null;

  // Apply edits in reverse order to preserve line indices
  const result = [...lines];
  for (const edit of edits.reverse()) {
    result.splice(edit.index, 0, edit.annotation);
  }

  return result.join("\n");
}

const specFiles = findSpecFiles(e2eDir);
let totalEdits = 0;

for (const filePath of specFiles) {
  const result = processFile(filePath);
  if (result !== null) {
    const content = readFileSync(filePath, "utf8");
    const editCount = result.split("\n").length - content.split("\n").length;
    totalEdits += editCount;
    const relPath = filePath.replace(root + "/", "");
    if (dryRun) {
      console.log(`DRY-RUN ${relPath}: ${editCount} annotation lines added`);
    } else {
      writeFileSync(filePath, result, "utf8");
      console.log(`✓ ${relPath}: ${editCount} annotation lines added`);
    }
  }
}

console.log(`\n${totalEdits} total annotation lines added across all files`);
if (dryRun) console.log("(dry run — no files were modified)");
