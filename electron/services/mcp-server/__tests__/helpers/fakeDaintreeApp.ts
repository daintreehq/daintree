import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MCP_DISCOVERY_FILE_NAME } from "../../discoveryFile.js";

/**
 * A process `daintree` takes for the running app: this test's own Node under
 * the app's executable name, inside `root`. macOS `ps` reports the path a
 * process was started by, so a link is enough there; Linux reads
 * /proc/<pid>/exe, which resolves links, so it gets a copy.
 */
export async function startFakeDaintreeApp(root: string): Promise<ChildProcess> {
  let binary: string;
  if (process.platform === "darwin") {
    binary = path.join(root, "Daintree.app", "Contents", "MacOS", "Daintree");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.symlinkSync(process.execPath, binary);
  } else {
    binary = path.join(root, "app", "daintree");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.copyFileSync(process.execPath, binary);
    fs.chmodSync(binary, 0o755);
  }
  const child = spawn(binary, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

/** The installed app's userData under `home`, where the CLI looks for it. */
export function daintreeProfileDir(home: string): string {
  return process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Daintree")
    : path.join(home, ".config", "Daintree");
}

/** A runtime file as given, for records the app would never write. */
export function writeRuntimeFile(home: string, record: unknown): void {
  const dir = daintreeProfileDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const text = typeof record === "string" ? record : `${JSON.stringify(record)}\n`;
  fs.writeFileSync(path.join(dir, MCP_DISCOVERY_FILE_NAME), text, { mode: 0o600 });
}
