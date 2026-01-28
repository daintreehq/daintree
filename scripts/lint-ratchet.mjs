#!/usr/bin/env node

/**
 * ESLint Warning Ratchet
 *
 * Fails the build if ESLint warnings increase beyond the baseline.
 * This allows gradual reduction of warnings without introducing new ones.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const BASELINE_FILE = join(ROOT, "eslint-warnings-baseline.json");

function main() {
  const isUpdate = process.argv.includes("--update");

  // Run ESLint and capture output
  let lintOutput;
  try {
    lintOutput = execSync("npx eslint . --format json", {
      cwd: ROOT,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large output
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    // ESLint exits with code 1 when there are warnings/errors
    // The output is still valid JSON in stdout
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      console.error("❌ ESLint output exceeded buffer size (10MB)");
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

  // Count warnings and errors
  const warningCount = results.reduce((sum, file) => {
    return sum + file.messages.filter((msg) => msg.severity === 1).length;
  }, 0);

  const errorCount = results.reduce((sum, file) => {
    return sum + file.messages.filter((msg) => msg.severity === 2).length;
  }, 0);

  console.log(`📊 Current ESLint warnings: ${warningCount}`);

  // Always fail if there are errors
  if (errorCount > 0) {
    console.error(`❌ ESLint errors detected: ${errorCount}`);
    console.error("   Fix all errors before proceeding");
    process.exit(1);
  }

  // Update mode: save current count as new baseline
  if (isUpdate) {
    const baseline = { count: warningCount, updatedAt: new Date().toISOString() };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`✅ Baseline updated: ${warningCount} warnings`);
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

  if (diff > 0) {
    console.error(`❌ ESLint warnings increased by ${diff} (baseline: ${baselineCount})`);
    console.error(`   Fix the new warnings or run: npm run lint:ratchet -- --update`);
    process.exit(1);
  } else if (diff < 0) {
    console.log(`🎉 ESLint warnings decreased by ${Math.abs(diff)}! (baseline: ${baselineCount})`);
    console.log(`   Update baseline: npm run lint:ratchet -- --update`);
  } else {
    console.log(`✅ No new warnings introduced (baseline: ${baselineCount})`);
  }
}

main();
