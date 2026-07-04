#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const timeout = 300_000;
const useShell = process.platform === "win32";
const npmBin = "npm";
const claudeBin = "claude";

function run(command, args, options = {}) {
  console.log(`[repair-claude-code-install] ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    stdio: "inherit",
    shell: useShell,
    timeout,
    ...options,
  });
}

function output(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: useShell,
    timeout,
  }).trim();
}

const npmRoot = output(npmBin, ["root", "-g"]);
const packageDir = path.join(npmRoot, "@anthropic-ai", "claude-code");
const installScriptNames = ["install.cjs", "install.js", "install.mjs"];
const installScript = installScriptNames
  .map((scriptName) => path.join(packageDir, scriptName))
  .find((scriptPath) => existsSync(scriptPath));

if (installScript) {
  run(process.execPath, [installScript], { cwd: packageDir });
} else {
  console.warn(
    `[repair-claude-code-install] no install script found in ${packageDir}; verifying existing claude install`
  );
}

run(claudeBin, ["--version"]);
