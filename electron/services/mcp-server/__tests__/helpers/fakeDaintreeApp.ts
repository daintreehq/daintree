import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MCP_DISCOVERY_FILE_NAME } from "../../discoveryFile.js";

export interface FakeDaintreeApp {
  process: ChildProcess;
  /** The loopback port it listens on, as the real app's MCP listener would. */
  port: number;
}

// Listens on a loopback port of its own, since the CLI only trusts a record
// whose process holds the port; with a target, each connection is piped there.
const APP_SCRIPT = `
const net = require("node:net");
const target = Number(process.env.FAKE_DAINTREE_PROXY_TO || 0);
const server = net.createServer((socket) => {
  if (!target) return socket.destroy();
  const upstream = net.connect(target, "127.0.0.1");
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
`;

/**
 * A process `daintree` takes for the running app: this test's own Node under
 * the app's executable name, inside `root` (in `bundle` on macOS, which a user
 * may have renamed). macOS `ps` reports the path a process was started by, so
 * a link is enough there; Linux reads /proc/<pid>/exe, which resolves links,
 * so it gets a copy. With `proxyTo`, its port forwards to that one, so a call
 * the CLI sends it reaches a test's MCP fixture.
 */
export async function startFakeDaintreeApp(
  root: string,
  { bundle = "Daintree.app", proxyTo }: { bundle?: string; proxyTo?: number } = {}
): Promise<FakeDaintreeApp> {
  const binary =
    process.platform === "darwin"
      ? path.join(root, bundle, "Contents", "MacOS", "Daintree")
      : path.join(root, "app", "daintree");
  // A second app under the same root runs the same binary.
  if (!fs.existsSync(binary)) {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    if (process.platform === "darwin") {
      fs.symlinkSync(process.execPath, binary);
    } else {
      fs.copyFileSync(process.execPath, binary);
      fs.chmodSync(binary, 0o755);
    }
  }
  const child = spawn(binary, ["-e", APP_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, FAKE_DAINTREE_PROXY_TO: proxyTo ? String(proxyTo) : "" },
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`fake Daintree exited (${code})`)));
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      const line = out.split("\n")[0];
      if (out.includes("\n")) resolve(Number(line));
    });
  });
  return { process: child, port };
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
