import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultCommandRunner,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "../commandRunner.js";
import { createSshCommandChannel, streamToFileScript } from "../remoteShell.js";
import { shellQuote } from "../sshTransport.js";

const result = (code: number, stderr = ""): CommandResult => ({
  code,
  stdout: "",
  stderr,
  spawnError: null,
  timedOut: false,
});

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dt-channel-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("defaultCommandRunner input", () => {
  it("feeds text or a file to the program's stdin", async () => {
    const text = await defaultCommandRunner("sh", ["-c", "cat"], { input: { text: "unit\n" } });
    expect(text).toMatchObject({ code: 0, stdout: "unit\n" });
    const file = path.join(dir, "bundle.bin");
    const bytes = Buffer.alloc(300_000, 7);
    await fs.writeFile(file, bytes);
    const counted = await defaultCommandRunner("sh", ["-c", "wc -c"], { input: { file } });
    expect(counted.stdout.trim()).toBe(String(bytes.length));
  });

  it("fails rather than send a partial file it couldn't read", async () => {
    const missing = await defaultCommandRunner("sh", ["-c", "cat >/dev/null"], {
      input: { file: path.join(dir, "missing") },
    });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("Couldn't read");
  });
});

describe("the ssh command channel", () => {
  function recording(answers: Record<string, CommandResult>) {
    const calls: Array<{ command: string; args: readonly string[]; options?: CommandOptions }> = [];
    const run: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      return answers[command] ?? result(0);
    };
    return { run, calls };
  }

  it("copies with scp when the host takes it", async () => {
    const { run, calls } = recording({ scp: result(0) });
    const channel = createSshCommandChannel({ target: "bigbox", controlPath: "/cm", run });
    await expect(channel.sendFile("/l/a.deb", "/tmp/s/a.deb")).resolves.toMatchObject({ code: 0 });
    expect(calls.map((c) => c.command)).toEqual(["scp"]);
    expect(calls[0]!.args.at(-1)).toBe("bigbox:/tmp/s/a.deb");
  });

  it("streams the file over the same ssh login when scp is refused (no sftp subsystem)", async () => {
    const { run, calls } = recording({ scp: result(255, "subsystem request failed on channel 0") });
    const channel = createSshCommandChannel({ target: "bigbox", controlPath: "/cm", run });
    await expect(channel.sendFile("/l/a b.deb", "/tmp/s/a b.deb")).resolves.toMatchObject({
      code: 0,
    });
    expect(calls.map((c) => c.command)).toEqual(["scp", "ssh"]);
    expect(calls[1]!.options?.input).toEqual({ file: "/l/a b.deb" });
    expect(calls[1]!.args.at(-1)).toBe(`sh -c ${shellQuote(streamToFileScript("/tmp/s/a b.deb"))}`);
    expect(streamToFileScript("/tmp/s/a b.deb")).toBe("umask 077; cat > '/tmp/s/a b.deb'");
  });

  it("doesn't retry a copy that timed out or was stopped", async () => {
    const { run, calls } = recording({ scp: { ...result(0), code: null, timedOut: true } });
    const channel = createSshCommandChannel({ target: "bigbox", controlPath: "/cm", run });
    await channel.sendFile("/l/a", "/r/a");
    expect(calls.map((c) => c.command)).toEqual(["scp"]);
  });
});
