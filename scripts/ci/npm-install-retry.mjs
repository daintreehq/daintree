#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { classifyFailure } from "./npm-ci-retry.mjs";

const attempts = Number.parseInt(process.env.NPM_INSTALL_RETRY_ATTEMPTS ?? "3", 10) || 3;
const baseDelayMs = Number.parseInt(process.env.NPM_INSTALL_RETRY_DELAY_MS ?? "15000", 10);
const timeoutMs = Number.parseInt(process.env.NPM_INSTALL_RETRY_TIMEOUT_MS ?? "300000", 10);
const killGraceMs = Number.parseInt(process.env.NPM_INSTALL_RETRY_KILL_GRACE_MS ?? "5000", 10);
const npmBin = "npm";
const npmArgs = ["install", ...process.argv.slice(2)];
const useShell = process.platform === "win32";
const useDetachedProcessGroup = process.platform !== "win32";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminateProcessTree(child) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {});
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore races with natural process exit.
    }
  }
}

function forceKillProcessTree(child) {
  if (!child.pid || process.platform === "win32") return;

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore races with natural process exit.
    }
  }
}

function runNpmInstall(attempt) {
  return new Promise((resolve) => {
    console.log(
      `[npm-install-retry] attempt ${attempt}/${attempts}: ${npmBin} ${npmArgs.join(" ")}`
    );
    let settled = false;
    const stderrChunks = [];
    let timedOut = false;
    let child;

    try {
      child = spawn(npmBin, npmArgs, {
        stdio: ["inherit", "inherit", "pipe"],
        shell: useShell,
        detached: useDetachedProcessGroup,
        env: process.env,
      });
    } catch (error) {
      console.error(`[npm-install-retry] failed to start npm: ${error.message}`);
      resolve({ code: 1, signal: null, classification: "unknown", timedOut: false });
      return;
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`[npm-install-retry] attempt timed out after ${Math.round(timeoutMs / 1000)}s`);
      terminateProcessTree(child);
    }, timeoutMs);
    const killTimeout = setTimeout(() => {
      if (!timedOut || settled) return;
      console.error(
        `[npm-install-retry] npm did not exit after ${Math.round(killGraceMs / 1000)}s; sending SIGKILL`
      );
      forceKillProcessTree(child);
    }, timeoutMs + killGraceMs);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      console.error(`[npm-install-retry] failed to start npm: ${error.message}`);
      resolve({ code: 1, signal: null, classification: "unknown", timedOut });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      const normalizedCode = code ?? 1;
      const stderrText = stderrChunks.join("");
      const classification =
        normalizedCode === 0 ? "success" : timedOut ? "transient" : classifyFailure(stderrText);
      resolve({ code: normalizedCode, signal, classification, timedOut });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let lastCode = 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runNpmInstall(attempt);
    lastCode = result.code;

    if (result.code === 0) {
      process.exit(0);
    }

    if (result.signal) {
      console.error(`[npm-install-retry] npm exited via signal ${result.signal}`);
    } else {
      console.error(`[npm-install-retry] npm exited with code ${result.code}`);
    }

    if (result.classification === "deterministic") {
      console.error("[npm-install-retry] deterministic npm failure detected; not retrying");
      process.exit(result.code || 1);
    }

    if (attempt < attempts) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), 60000);
      console.error(`[npm-install-retry] retrying in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }

  process.exit(lastCode || 1);
}
