#!/usr/bin/env node
import { spawn } from "node:child_process";

const attempts = Number.parseInt(process.env.NPM_CI_RETRY_ATTEMPTS ?? "3", 10);
const baseDelayMs = Number.parseInt(process.env.NPM_CI_RETRY_DELAY_MS ?? "15000", 10);
const npmBin = "npm";
const npmArgs = ["ci", ...process.argv.slice(2)];
const useShell = process.platform === "win32";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNpmCi(attempt) {
  return new Promise((resolve) => {
    console.log(`[npm-ci-retry] attempt ${attempt}/${attempts}: ${npmBin} ${npmArgs.join(" ")}`);
    let child;
    try {
      child = spawn(npmBin, npmArgs, {
        stdio: "inherit",
        shell: useShell,
        env: process.env,
      });
    } catch (error) {
      console.error(`[npm-ci-retry] failed to start npm: ${error.message}`);
      resolve({ code: 1, signal: null });
      return;
    }

    child.on("error", (error) => {
      console.error(`[npm-ci-retry] failed to start npm: ${error.message}`);
      resolve({ code: 1, signal: null });
    });

    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
}

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

  if (attempt < attempts) {
    const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), 60000);
    console.error(`[npm-ci-retry] retrying in ${Math.round(delayMs / 1000)}s`);
    await sleep(delayMs);
  }
}

process.exit(lastCode || 1);
