#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const attempts = Number.parseInt(process.env.NPM_CI_RETRY_ATTEMPTS ?? "5", 10) || 5;
const baseDelayMs = Number.parseInt(process.env.NPM_CI_RETRY_DELAY_MS ?? "15000", 10);
const npmBin = "npm";
const npmArgs = ["ci", ...process.argv.slice(2)];
const useShell = process.platform === "win32";

// Deterministic failures: retrying won't help. Exit immediately.
export const DETERMINISTIC_PATTERNS = [
  /gyp (err!|error)/i,
  /node-gyp/i,
  /xcrun.*error|xcode-select.*error|error.*xcrun/i,
  /msbuild|\.vcxproj\b/i,
  /\bnpm (error|err!).*code\s+eacces/i,
  /permission denied/i,
  /\bnpm (error|err!).*code\s+e404/i,
  /404\s+not\s+found/i,
  /\bnpm (error|err!).*(code\s+eresolve|eresolve\s+could\s+not\s+resolve)/i,
  /\bnpm (error|err!).*code\s+epeerinvalid/i,
];

// Transient failures: network disruptions that may resolve on retry.
export const TRANSIENT_PATTERNS = [
  /econnreset/i,
  /etimedout/i,
  /eai_again/i,
  /enotfound/i,
  /ehostunreach/i,
  /enetunreach/i,
  /socket\s+hang\s+up/i,
  /\b429\b/i,
  /\b502\b/i,
  /\b503\b/i,
  /\b504\b/i,
  /fetch\s+failed/i,
  /\bnpm (error|err!).*network/i,
];

// Transient infrastructure crashes that can be logged underneath node-gyp.
// These must be checked before the broad node-gyp deterministic pattern.
export const TRANSIENT_OVERRIDE_PATTERNS = [
  /AssertionError \[ERR_ASSERTION\][\s\S]*assert\(!this\.paused\)[\s\S]*node-gyp[\s\S]*undici/i,
  /(?:ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT)[\s\S]*node-gyp|node-gyp[\s\S]*(?:ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT)/i,
  /(?:ETIMEDOUT|ENETUNREACH)[\s\S]*node-gyp|node-gyp[\s\S]*(?:ETIMEDOUT|ENETUNREACH)/i,
];

/**
 * Classify accumulated stderr text to decide whether to retry.
 * Deterministic patterns win over transient ones — a compile error
 * that also logged a network warning is still a compile error. Explicit
 * transient overrides handle known toolchain/network crashes that happen
 * below node-gyp but are not native compile failures.
 */
export function classifyFailure(stderrText) {
  if (!stderrText) return "unknown";

  for (const pattern of TRANSIENT_OVERRIDE_PATTERNS) {
    if (pattern.test(stderrText)) return "transient";
  }

  for (const pattern of DETERMINISTIC_PATTERNS) {
    if (pattern.test(stderrText)) return "deterministic";
  }

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(stderrText)) return "transient";
  }

  return "unknown";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNpmCi(attempt) {
  return new Promise((resolve) => {
    console.log(`[npm-ci-retry] attempt ${attempt}/${attempts}: ${npmBin} ${npmArgs.join(" ")}`);
    let settled = false;
    const stderrChunks = [];
    let child;
    try {
      child = spawn(npmBin, npmArgs, {
        stdio: ["inherit", "inherit", "pipe"],
        shell: useShell,
        env: process.env,
      });
    } catch (error) {
      console.error(`[npm-ci-retry] failed to start npm: ${error.message}`);
      resolve({ code: 1, signal: null, classification: "unknown" });
      return;
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      console.error(`[npm-ci-retry] failed to start npm: ${error.message}`);
      resolve({ code: 1, signal: null, classification: "unknown" });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      const normalizedCode = code ?? 1;
      const stderrText = stderrChunks.join("");
      const classification = normalizedCode === 0 ? "success" : classifyFailure(stderrText);
      resolve({ code: normalizedCode, signal, classification });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let lastCode = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runNpmCi(attempt);
    lastCode = result.code;

    if (result.code === 0) {
      process.exit(0);
    }

    if (result.signal) {
      console.error(`[npm-ci-retry] npm exited via signal ${result.signal}`);
    } else {
      console.error(`[npm-ci-retry] npm exited with code ${result.code}`);
    }

    if (result.classification === "deterministic") {
      console.error("[npm-ci-retry] deterministic npm failure detected; not retrying");
      process.exit(result.code || 1);
    }

    if (attempt < attempts) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), 60000);
      console.error(`[npm-ci-retry] retrying in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }

  process.exit(lastCode || 1);
}
