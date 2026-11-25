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
import {
  createSshCommandChannel,
  execAsLogin,
  loginShellArgs,
  streamToFileScript,
} from "../remoteShell.js";
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

  it("has scp run the same ssh as every other call", async () => {
    const { run, calls } = recording({ scp: result(0) });
    const channel = createSshCommandChannel({
      target: "bigbox",
      controlPath: "/cm",
      run,
      sshPath: "/opt/wrapped/ssh",
    });
    await channel.sendFile("/l/a.deb", "/tmp/s/a.deb");
    const args = calls[0]!.args;
    expect(args[args.indexOf("-S") + 1]).toBe("/opt/wrapped/ssh");
  });

  it("keeps the user's agent and X11 forwarding off its own sessions", async () => {
    const { run, calls } = recording({});
    const channel = createSshCommandChannel({ target: "bigbox", controlPath: "/cm", run });
    await channel.exec("true");
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining(["ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes"])
    );
  });

  it("starts a master from a copy with the same forwarding off as any ssh call", async () => {
    const { run, calls } = recording({ scp: result(0) });
    const channel = createSshCommandChannel({ target: "bigbox", controlPath: "/cm", run });
    await channel.sendFile("/l/a.deb", "/tmp/s/a.deb");
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining([
        "ForwardAgent=no",
        "ForwardX11=no",
        "ClearAllForwardings=yes",
        "ControlPersist=10m",
      ])
    );
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

describe("a command as another login on a cloud machine", () => {
  it("names the login on the route's alias and shares or leaves no master", () => {
    const args = loginShellArgs("root", "dtc-abc", "id -u");
    expect(args.slice(-3)).toEqual(["--", "root@dtc-abc", `sh -c ${shellQuote("id -u")}`]);
    expect(args).toContain("ControlMaster=no");
    expect(args).toContain("ControlPath=none");
    expect(args).toContain("BatchMode=yes");
    expect(args).not.toContain("ControlMaster=auto");
    expect(() => loginShellArgs("-oProxyCommand=x", "dtc-abc", "true")).toThrow();
    expect(() => loginShellArgs("root", "dtc-abc", "a\nb")).toThrow();
  });

  it("runs through the route's own ssh wrapper, or answers as ssh would when it can't be reached", async () => {
    const seen: Array<[string, readonly string[], CommandOptions | undefined]> = [];
    const run: CommandRunner = async (command, args, options) => {
      seen.push([command, args, options]);
      return result(0);
    };
    await execAsLogin(
      {
        resolve: async () => ({ target: "dtc-abc", sshPath: "/app/machines/abc/ssh" }),
        login: "root",
        run,
      },
      "true",
      { timeoutMs: 1_000 }
    );
    expect(seen[0]![0]).toBe("/app/machines/abc/ssh");
    expect(seen[0]![1]).toContain("root@dtc-abc");
    expect(seen[0]![2]).toMatchObject({ timeoutMs: 1_000, env: { SSH_ASKPASS_REQUIRE: "never" } });

    const refused = await execAsLogin(
      {
        resolve: async () => {
          throw Object.assign(new Error("stopped"), { detail: "The machine is stopped." });
        },
        login: "root",
        run,
      },
      "true"
    );
    expect(refused).toMatchObject({ code: 255, stderr: "The machine is stopped." });
    expect(seen).toHaveLength(1);
  });
});
