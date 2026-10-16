import { describe, expect, it, vi } from "vitest";
import type { CommandOptions, CommandResult, CommandRunner } from "../commandRunner.js";
import { isWslServiceFailure, withWslDiagnostics, wslExecArgs } from "../wslCommand.js";
import { createWslCommandChannel } from "../wslShell.js";
import { failureDetail } from "../remoteShell.js";

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
  timedOut: false,
});

const WSL = "C:\\Windows\\System32\\wsl.exe";

describe("wslExecArgs", () => {
  it("runs an absolute program with --exec, from the distro user's home", () => {
    expect(wslExecArgs("Ubuntu-24.04", ["/bin/sh", "-c", "echo $HOME; a 'b'"])).toEqual([
      "-d",
      "Ubuntu-24.04",
      "--cd",
      "~",
      "--exec",
      "/bin/sh",
      "-c",
      "echo $HOME; a 'b'",
    ]);
  });

  it("refuses distro names wsl.exe could read as options and programs that aren't absolute", () => {
    expect(() => wslExecArgs("--exec", ["/bin/true"])).toThrow(/Not a usable WSL distribution/);
    expect(() => wslExecArgs("-u root", ["/bin/true"])).toThrow(/Not a usable WSL distribution/);
    expect(() => wslExecArgs("Ubuntu", ["sh"])).toThrow(/absolute Linux path/);
    expect(() => wslExecArgs("Ubuntu", [])).toThrow(/absolute Linux path/);
  });
});

describe("withWslDiagnostics", () => {
  it("moves wsl.exe's own stdout message to stderr when wsl.exe itself failed", () => {
    const failed: CommandResult = {
      code: 4294967295,
      stdout:
        "There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n",
      stderr: "",
      spawnError: null,
      timedOut: false,
    };
    const result = withWslDiagnostics(failed);
    expect(result.stdout).toBe("");
    expect(failureDetail(result, "wsl.exe failed")).toContain("WSL_E_DISTRO_NOT_FOUND");
    expect(isWslServiceFailure(-1)).toBe(true);
    expect(isWslServiceFailure(1)).toBe(false);
  });

  it("leaves a program's own failure alone: its stdout is its own", () => {
    const failed: CommandResult = { ...ok("partial"), code: 1, stderr: "boom" };
    expect(withWslDiagnostics(failed)).toBe(failed);
  });
});

describe("createWslCommandChannel", () => {
  const recorder = () => {
    const calls: Array<{ command: string; args: readonly string[]; options?: CommandOptions }> = [];
    const run: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, options });
      return ok("done\n");
    };
    return { calls, run };
  };

  it("runs each script as one sh -c argument, with UTF-8 wsl.exe messages", async () => {
    const { calls, run } = recorder();
    const channel = createWslCommandChannel({ distro: "Ubuntu-24.04", run, wslPath: WSL });
    // Multi-line and quote-heavy: nothing re-quotes it on the way.
    const script = `echo "it's" \\\n  && printf '%s\\n' "$HOME"`;
    await channel.exec(script, { timeoutMs: 5_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(WSL);
    expect(calls[0]!.args).toEqual(wslExecArgs("Ubuntu-24.04", ["/bin/sh", "-c", script]));
    expect(calls[0]!.options).toMatchObject({ timeoutMs: 5_000, env: { WSL_UTF8: "1" } });
  });

  it("feeds input on stdin and sends files the same way", async () => {
    const { calls, run } = recorder();
    const channel = createWslCommandChannel({ distro: "Debian", run, wslPath: WSL });
    await channel.execWithInput("cat > /tmp/x", { text: "hello" });
    await channel.sendFile("C:\\Users\\me\\Daintree.AppImage", "/home/me/.cache/d.AppImage");
    expect(calls[0]!.options?.input).toEqual({ text: "hello" });
    expect(calls[1]!.args.at(-1)).toBe("umask 077; cat > '/home/me/.cache/d.AppImage'");
    expect(calls[1]!.options?.input).toEqual({ file: "C:\\Users\\me\\Daintree.AppImage" });
  });

  it("asks for the distro to be kept up around every command", async () => {
    const { run } = recorder();
    const keepalive = vi.fn();
    const channel = createWslCommandChannel({ distro: "Ubuntu", run, wslPath: WSL, keepalive });
    await channel.exec("true");
    await channel.sendFile("C:\\a", "/tmp/a");
    // Before and after each, so a long command doesn't outlast its hold.
    expect(keepalive).toHaveBeenCalledTimes(4);
    expect(keepalive).toHaveBeenCalledWith("Ubuntu");
  });

  it("reports wsl.exe's own failure as the command's failure", async () => {
    const run: CommandRunner = async () => ({
      code: 4294967295,
      stdout: "There is no distribution with the supplied name.\n",
      stderr: "",
      spawnError: null,
      timedOut: false,
    });
    const channel = createWslCommandChannel({ distro: "Gone", run, wslPath: WSL });
    const result = await channel.exec("true");
    expect(failureDetail(result, "wsl.exe failed")).toBe(
      "There is no distribution with the supplied name."
    );
  });
});
