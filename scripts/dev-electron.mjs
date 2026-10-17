import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

/**
 * Whether Chromium can likely sandbox the dev Electron on this Linux box (a
 * heuristic: a nosuid mount or a broken helper still fails). The npm
 * Electron has no AppArmor profile (the deb ships one) and its chrome-sandbox
 * isn't setuid root, so where unprivileged user namespaces are restricted
 * (Ubuntu 23.10+, or the userns sysctl off) Chromium aborts at launch with
 * "The SUID sandbox helper binary was found, but is not configured correctly".
 */
export function devSandboxUsable({
  sandboxHelper = path.join(path.dirname(electronPath), "chrome-sandbox"),
  readFile = (file) => fs.readFileSync(file, "utf8"),
  stat = (file) => fs.statSync(file),
} = {}) {
  try {
    // Chromium also needs the helper executable by everyone; 4750 still aborts.
    const helper = stat(sandboxHelper);
    if (helper.uid === 0 && (helper.mode & 0o4001) === 0o4001) return true;
  } catch {
    // No helper: Chromium falls back to user namespaces, checked below.
  }
  const sysctl = (name) => {
    try {
      return readFile(`/proc/sys/kernel/${name}`).trim();
    } catch {
      return null;
    }
  };
  if (sysctl("apparmor_restrict_unprivileged_userns") === "1") return false;
  if (sysctl("unprivileged_userns_clone") === "0") return false;
  return true;
}

function main() {
  const args = [".", ...process.argv.slice(2)];
  if (process.platform === "linux" && !devSandboxUsable()) {
    args.unshift("--no-sandbox");
    console.warn(
      "[dev] Chromium can't sandbox the npm Electron here (user namespaces are restricted and " +
        "chrome-sandbox isn't setuid root), so this dev run uses --no-sandbox. To keep the sandbox: " +
        `sudo chown root:root ${path.join(path.dirname(electronPath), "chrome-sandbox")} && ` +
        `sudo chmod 4755 ${path.join(path.dirname(electronPath), "chrome-sandbox")}`
    );
  }
  const child = spawn(electronPath, args, { stdio: "inherit" });
  // The signals the electron npm CLI forwards; SIGUSR2 is Daintree's graceful shutdown.
  for (const signal of ["SIGINT", "SIGTERM", "SIGUSR2"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
