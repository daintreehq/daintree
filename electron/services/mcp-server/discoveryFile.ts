import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resilientAtomicWriteFileSync } from "../../utils/fs.js";

/**
 * `mcp-runtime.json` in userData: the port the MCP control surface bound, and
 * which process bound it, while it serves (#17904). `daintree call` reads it
 * outside an agent pane, and `daintree --status --json` reports it; both live
 * in scripts/daintree-cli.sh, which reads the same fields back in bash. It is
 * discovery only: the credential never goes in it.
 *
 * A crash leaves the file behind, so the reader trusts it only while its pid is
 * a live Daintree that started when the file says. A pid alone could name a
 * later process, and the port a listener that isn't Daintree's.
 */

export const MCP_DISCOVERY_FILE_NAME = "mcp-runtime.json";

/**
 * When `pid` started, in the form the CLI reads it back: Linux's start ticks
 * from /proc with the boot they count from, or `ps`'s start time on macOS in
 * UTC, since the shell reading it may be in another time zone. Null elsewhere,
 * or when it can't be read.
 */
export function discoveryProcessStamp(
  pid: number,
  platform: NodeJS.Platform = process.platform
): string | null {
  try {
    if (platform === "darwin") {
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .replace(/\s+/g, " ");
      return started.length > 0 ? started : null;
    }
    if (platform !== "linux") return null;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22, counted from after the command name, which may itself hold
    // spaces or parentheses.
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return ticks && /^\d+$/.test(ticks) && /^[0-9a-f-]+$/.test(boot) ? `${ticks}@${boot}` : null;
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : String(err);
}

export interface McpDiscoveryFileOptions {
  /** The userData directory; read at each write, so a failure to resolve it is only that write's. */
  dir: () => string;
  pid?: number;
  stamp?: (pid: number) => string | null;
}

/**
 * Publishes the control surface's port, and takes it back. Synchronous, so a
 * withdrawal and the next start's publication land in the order they happen.
 * Nothing here can fail the server: a write that fails leaves no record.
 */
export class McpDiscoveryFile {
  private readonly pid: number;
  private readonly readStamp: (pid: number) => string | null;
  /** Kept once read; a failed read is tried again at the next publication. */
  private stamp: string | null = null;
  /** What this process last wrote, and the file it landed in, still on disk as far as it knows. */
  private written: { file: string; text: string; port: number; ino: number; dev: number } | null =
    null;

  constructor(private readonly options: McpDiscoveryFileOptions) {
    this.pid = options.pid ?? process.pid;
    this.readStamp = options.stamp ?? discoveryProcessStamp;
  }

  /** The port being served, or null once it isn't. */
  publish(port: number | null): void {
    if (port === null) {
      this.withdraw();
      return;
    }
    if (this.written?.port === port) return;
    this.withdraw();
    if (this.stamp === null) {
      try {
        this.stamp = this.readStamp(this.pid);
      } catch {
        this.stamp = null;
      }
    }
    // Without a start time a reader can't tell this file from a crash's.
    if (this.stamp === null) return;
    let file: string;
    try {
      file = path.join(this.options.dir(), MCP_DISCOVERY_FILE_NAME);
    } catch (err) {
      console.warn("[MCP] No userData directory for the discovery file:", errorCode(err));
      return;
    }
    const text = `${JSON.stringify({ pid: this.pid, port, startedAt: this.stamp })}\n`;
    try {
      // Not durable: after a reboot the record is stale whatever it says.
      resilientAtomicWriteFileSync(file, text, "utf-8", { mode: 0o600, durable: false });
      const { ino, dev } = fs.statSync(file);
      this.written = { file, text, port, ino, dev };
    } catch (err) {
      console.warn("[MCP] Couldn't write the discovery file:", errorCode(err));
    }
  }

  /** Removes the record this process wrote, and never one another process put there since. */
  private withdraw(): void {
    const written = this.written;
    if (written === null) return;
    let current: string;
    try {
      current = fs.readFileSync(written.file, "utf8");
    } catch (err) {
      if (errorCode(err) === "ENOENT") this.written = null;
      // Unreadable: not provably ours, so it is left alone; the next withdrawal tries again.
      else console.warn("[MCP] Couldn't read the discovery file back:", errorCode(err));
      return;
    }
    if (current !== written.text) {
      this.written = null;
      return;
    }
    try {
      fs.unlinkSync(written.file);
      this.written = null;
      return;
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        this.written = null;
        return;
      }
      console.warn("[MCP] Couldn't remove the discovery file:", errorCode(err));
    }
    // Ours and still standing, it names this live process for a port it is
    // letting go. Emptying it needs only the file's own permission, which a
    // directory that refused the unlink can't take away. The path is opened
    // again, so the file is checked through that descriptor before it is
    // emptied: the one written, holding the same bytes.
    try {
      const fd = fs.openSync(written.file, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fs.fstatSync(fd);
        const same =
          opened.ino === written.ino &&
          opened.dev === written.dev &&
          fs.readFileSync(fd, "utf8") === written.text;
        if (same) fs.ftruncateSync(fd, 0);
      } finally {
        fs.closeSync(fd);
      }
      this.written = null;
    } catch (err) {
      // Left as it is; the CLI checks the port is still this process's before using it.
      console.warn("[MCP] Couldn't empty the discovery file:", errorCode(err));
    }
  }
}
