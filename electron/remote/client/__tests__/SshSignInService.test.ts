import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SshSignInEvent } from "../../../../shared/types/ipc/remoteHosts.js";
import type { CommandOptions, CommandResult, CommandRunner } from "../commandRunner.js";
import { runAskpassClient } from "../sshAskpass.js";
import {
  SshSignInService,
  askpassLauncherScript,
  classifyAskpassPrompt,
  displayPrompt,
  type SignInChild,
  type SignInOwner,
} from "../SshSignInService.js";

vi.mock("../../../ipc/utils.js", () => ({ sendToWebContents: vi.fn() }));

const SSH = { kind: "ssh" as const, target: "greg@studio" };
const REFUSED = "greg@studio: Permission denied (publickey,keyboard-interactive).";

let clientDir: string;
let services: SshSignInService[] = [];

beforeEach(() => {
  clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "si-"));
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.dispose()));
  services = [];
  fs.rmSync(clientDir, { recursive: true, force: true });
});

function result(partial: Partial<CommandResult>): CommandResult {
  return { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false, ...partial };
}

class FakeChild extends EventEmitter implements SignInChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  constructor(
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv
  ) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    setImmediate(() => this.emit("exit", null, signal));
    return true;
  }
  exit(code: number, stderr = ""): void {
    if (stderr) this.stderr.write(stderr);
    this.emit("exit", code, null);
  }
}

function setup(
  batch: CommandResult | ((args: readonly string[]) => CommandResult),
  extra: Partial<ConstructorParameters<typeof SshSignInService>[0]> = {}
) {
  const calls: Array<{ args: readonly string[]; options?: CommandOptions }> = [];
  const run: CommandRunner = async (_command, args, options) => {
    calls.push({ args, options });
    if (args.includes("-O")) return result({});
    return typeof batch === "function" ? batch(args) : batch;
  };
  const spawned: FakeChild[] = [];
  const service = new SshSignInService({
    clientDir,
    run,
    helperCommand: () => ["/Applications/Daintree.app/Contents/MacOS/Daintree"],
    sshPath: () => "/usr/bin/ssh",
    platform: "darwin",
    spawn: (_command, args, env) => {
      const child = new FakeChild(args, env);
      spawned.push(child);
      return child;
    },
    ...extra,
  });
  services.push(service);
  return { service, calls, spawned };
}

function fakeOwner(id = 7) {
  const events: SshSignInEvent[] = [];
  let gone: (() => void) | null = null;
  const owner: SignInOwner = {
    id,
    send: (event) => events.push(event),
    onGone: (listener) => {
      gone = listener;
      return () => {
        gone = null;
      };
    },
  };
  return { owner, events, goAway: () => gone?.() };
}

/** What ssh's askpass would do: ask the sign-in this child was started for. */
function askAs(child: FakeChild, prompt: string, hint = "") {
  const writeAnswer = vi.fn((_answer: string) => Promise.resolve());
  const client = runAskpassClient({
    socketPath: child.env.DAINTREE_ASKPASS_SOCKET!,
    token: child.env.DAINTREE_ASKPASS_TOKEN!,
    prompt,
    hint,
    writeAnswer,
  });
  return { ...client, writeAnswer };
}

function promptEvent(events: SshSignInEvent[], index = 0) {
  const event = events[index];
  if (event?.type !== "prompt") throw new Error(`no prompt at ${index}`);
  return event;
}

describe("classifyAskpassPrompt", () => {
  it.each([
    "The authenticity of host 'studio (10.0.0.2)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
    "Please type 'yes', 'no' or the fingerprint: ",
    "Accept updated hostkeys? (yes/no): ",
    "Warning: the ECDSA host key for 'studio' differs from the key for the IP address '10.0.0.2'\nAre you sure you want to continue connecting (yes/no)? ",
  ])("refuses a host-key question unseen: %j", (prompt) => {
    expect(classifyAskpassPrompt(prompt, "")).toBe("refuse");
  });

  it.each([
    "Enter passphrase for key '/Users/g/.ssh/work host key': ",
    "Enter the verification code to continue connecting: ",
  ])("never mistakes a secret that mentions the words for a host-key question: %j", (prompt) => {
    expect(classifyAskpassPrompt(prompt, "")).toBe("secret");
  });

  it("refuses a permission question, and shows a presence notice without a field", () => {
    expect(classifyAskpassPrompt("Allow shared connection to studio? ", "confirm")).toBe("refuse");
    expect(classifyAskpassPrompt("Confirm user presence for key ECDSA-SK SHA256:abc", "none")).toBe(
      "notice"
    );
  });

  it.each([
    "Enter passphrase for key '/Users/g/.ssh/id_ed25519': ",
    "(greg@studio) Verification code: ",
    "(greg@hostkeys.example.com) Password: ",
    "Enter PIN for ECDSA-SK key /Users/g/.ssh/id_ecdsa_sk: ",
  ])("asks the person for a secret: %j", (prompt) => {
    expect(classifyAskpassPrompt(prompt, "")).toBe("secret");
  });
});

describe("displayPrompt", () => {
  it("keeps the question when a long preamble has to give way", () => {
    const shown = displayPrompt(`${"Enrolled device\n".repeat(400)}Passcode or option (1-3):`);
    expect(shown.length).toBeLessThanOrEqual(4_000);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("Passcode or option (1-3):")).toBe(true);
  });

  it("keeps ssh's line breaks and drops what could disguise the text", () => {
    expect(displayPrompt("Duo two-factor login\r\n\r\n 1. Duo Push‮\nPasscode:\u001b[2J ")).toBe(
      "Duo two-factor login\n\n 1. Duo Push\nPasscode: [2J"
    );
  });
});

describe.skipIf(process.platform === "win32")("askpassLauncherScript", () => {
  it("hands the prompt on in the environment, never as an argument to this build", () => {
    const bin = path.join(clientDir, "Dain tree's bin");
    fs.mkdirSync(bin);
    const out = path.join(clientDir, "out");
    const helper = path.join(bin, "helper");
    fs.writeFileSync(
      helper,
      `#!/bin/sh\nprintf '%s\\n' "$DAINTREE_ASKPASS_PROMPT" "\${ELECTRON_RUN_AS_NODE-unset}" "$@" > '${out}'\n`,
      { mode: 0o700 }
    );
    const launcher = path.join(bin, "askpass");
    fs.writeFileSync(launcher, askpassLauncherScript([helper], "darwin"), { mode: 0o700 });
    const ran = spawnSync(launcher, ["--gpu-launcher=touch /tmp/pwned 'x' $(id)"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(ran.status).toBe(0);
    expect(fs.readFileSync(out, "utf8").split("\n")).toEqual([
      "--gpu-launcher=touch /tmp/pwned 'x' $(id)",
      "unset",
      "--ssh-askpass",
      "",
    ]);
  });

  it("runs the helper headless on Linux", () => {
    const script = askpassLauncherScript(["/opt/Daintree/daintree"], "linux");
    expect(script).toContain(
      "exec '/opt/Daintree/daintree' '--ozone-platform=headless' '--disable-gpu' '--ssh-askpass'\n"
    );
  });
});

describe.skipIf(process.platform === "win32")("SshSignInService", () => {
  it("never starts a prompting ssh when the batch login gets in", async () => {
    const { service, calls, spawned } = setup(result({ code: 0 }));
    const { owner, events } = fakeOwner();
    await expect(
      service.start(owner, { attemptId: "attempt-0001", connection: SSH })
    ).resolves.toEqual({ status: "signed-in" });
    expect(spawned).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(calls[0]!.args).toContain("BatchMode=yes");
    expect(calls[0]!.args).not.toContain("BatchMode=no");
    expect(calls[0]!.options?.env).toEqual({ SSH_ASKPASS_REQUIRE: "never" });
  });

  it("takes a refusal only from ssh itself: a command there printing the words doesn't count", async () => {
    const { service, spawned } = setup(
      result({ code: 1, stderr: "Permission denied (restricted command)\n" })
    );
    await expect(
      service.start(fakeOwner().owner, { attemptId: "attempt-0001", connection: SSH })
    ).resolves.toMatchObject({ status: "failed" });
    expect(spawned).toHaveLength(0);
  });

  it("signs in past a jump host whose refusal ssh hid, once it is heard without a master", async () => {
    const closed = "Connection closed by UNKNOWN port 65535\n";
    const { service, spawned, calls } = setup((args) =>
      args.includes("ControlPath=none")
        ? result({
            code: 255,
            stderr: `greg@bastion: Permission denied (publickey,keyboard-interactive).\n${closed}`,
          })
        : result({ code: 255, stderr: closed })
    );
    const { owner } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    expect(calls[1]!.options?.env).toEqual({ SSH_ASKPASS_REQUIRE: "never" });
    spawned[0]!.exit(0);
    await expect(done).resolves.toEqual({ status: "signed-in" });
  });

  it("never takes a command's words on the diagnosis run for a jump host's refusal", async () => {
    const { service, spawned } = setup((args) =>
      args.includes("ControlPath=none")
        ? // Worded as ssh would, but the status is a command's, not ssh's.
          result({ code: 1, stderr: "greg@bastion: Permission denied (publickey).\n" })
        : result({ code: 255, stderr: "Connection closed by UNKNOWN port 65535\n" })
    );
    await expect(
      service.start(fakeOwner().owner, { attemptId: "attempt-0001", connection: SSH })
    ).resolves.toMatchObject({ status: "failed" });
    expect(spawned).toHaveLength(0);
  });

  it("stops at a jump host that closed without refusing the login, in its own words", async () => {
    const { service, spawned } = setup((args) =>
      args.includes("ControlPath=none")
        ? result({
            code: 255,
            stderr: "channel 0: open failed: connect failed: No route to host\n",
          })
        : result({ code: 255, stderr: "Connection closed by UNKNOWN port 65535\n" })
    );
    await expect(
      service.start(fakeOwner().owner, { attemptId: "attempt-0001", connection: SSH })
    ).resolves.toEqual({ status: "failed", detail: "Connection closed by UNKNOWN port 65535" });
    expect(spawned).toHaveLength(0);
  });

  it("never prompts past a refusal that isn't a login: a host key stays ssh's to refuse", async () => {
    const { service, spawned } = setup(
      result({ code: 255, stderr: "Host key verification failed.\n" })
    );
    const { owner } = fakeOwner();
    await expect(
      service.start(owner, { attemptId: "attempt-0001", connection: SSH })
    ).resolves.toEqual({ status: "failed", detail: "Host key verification failed" });
    expect(spawned).toHaveLength(0);
  });

  it("relays each prompt to the view that asked and hands its answer to ssh once", async () => {
    process.env.SSH_ASKPASS_PROMPT = "none";
    onTestFinished(() => {
      delete process.env.SSH_ASKPASS_PROMPT;
    });
    const { service, spawned, calls } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner, events } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    expect(child.args.filter((arg) => arg.startsWith("BatchMode="))).toEqual(["BatchMode=no"]);
    expect(child.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(child.env.SSH_ASKPASS_PROMPT).toBeUndefined();
    expect(fs.readFileSync(child.env.SSH_ASKPASS!, "utf8")).toContain("'--ssh-askpass'");
    expect(fs.statSync(child.env.SSH_ASKPASS!).mode & 0o777).toBe(0o700);
    // The master it starts is the one the batch call looked for, so later calls ride it.
    const controlPathOf = (args: readonly string[]) =>
      args.find((a) => a.startsWith("ControlPath="));
    expect(controlPathOf(child.args)).toBe(controlPathOf(calls[0]!.args));

    const passphrase = askAs(child, "Enter passphrase for key '/Users/g/.ssh/id_ed25519': ");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const first = promptEvent(events);
    expect(first).toMatchObject({
      attemptId: "attempt-0001",
      kind: "secret",
      text: "Enter passphrase for key '/Users/g/.ssh/id_ed25519':",
    });
    // Only the view that started it answers, and only once.
    expect(
      service.answer(8, { attemptId: "attempt-0001", promptId: first.promptId, answer: "x" })
    ).toBe(false);
    expect(
      service.answer(owner.id, {
        attemptId: "attempt-0001",
        promptId: first.promptId,
        answer: "correct horse",
      })
    ).toBe(true);
    expect(
      service.answer(owner.id, {
        attemptId: "attempt-0001",
        promptId: first.promptId,
        answer: "again",
      })
    ).toBe(false);
    expect(await passphrase.done).toBe(0);
    expect(passphrase.writeAnswer).toHaveBeenCalledWith("correct horse");

    const code = askAs(child, "(greg@studio) Verification code: ");
    await vi.waitFor(() => expect(events).toHaveLength(2));
    const second = promptEvent(events, 1);
    expect(second.promptId).not.toBe(first.promptId);
    service.answer(owner.id, {
      attemptId: "attempt-0001",
      promptId: second.promptId,
      answer: "123456",
    });
    expect(await code.done).toBe(0);

    child.exit(0);
    await expect(done).resolves.toEqual({ status: "signed-in" });
    expect(fs.existsSync(path.dirname(child.env.SSH_ASKPASS!))).toBe(false);
  });

  it("refuses host-key and permission questions without showing them, and ignores a stranger", async () => {
    const { service, spawned } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner, events } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const child = spawned[0]!;
    const hostKey = askAs(
      child,
      "The authenticity of host 'studio' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
    );
    const permission = askAs(child, "Allow shared connection to studio? ", "confirm");
    expect(await hostKey.done).toBe(1);
    expect(await permission.done).toBe(1);
    const stranger = runAskpassClient({
      socketPath: child.env.DAINTREE_ASKPASS_SOCKET!,
      token: "0".repeat(64),
      prompt: "Password:",
      hint: "",
      writeAnswer: () => Promise.resolve(),
    });
    expect(await stranger.done).toBe(1);
    expect(events).toEqual([]);
    child.exit(255, REFUSED);
    await expect(done).resolves.toEqual({
      status: "failed",
      detail: "greg@studio: Permission denied (publickey,keyboard-interactive)",
    });
  });

  it("shows a security key's notice and takes it down when ssh stops the helper", async () => {
    const { service, spawned } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner, events } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const notice = askAs(spawned[0]!, "Confirm user presence for key ECDSA-SK SHA256:abc", "none");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const shown = promptEvent(events);
    expect(shown.kind).toBe("notice");
    // A notice has nothing to answer.
    expect(
      service.answer(owner.id, { attemptId: "attempt-0001", promptId: shown.promptId, answer: "" })
    ).toBe(false);
    notice.stop();
    await vi.waitFor(() =>
      expect(events[1]).toEqual({
        type: "prompt-closed",
        attemptId: "attempt-0001",
        promptId: shown.promptId,
      })
    );
    spawned[0]!.exit(0);
    await expect(done).resolves.toEqual({ status: "signed-in" });
  });

  it("stops ssh when the person cancels, and leaves the host's master alone", async () => {
    const { service, spawned, calls } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const waiting = askAs(spawned[0]!, "Password: ");
    expect(service.cancel(8, { attemptId: "attempt-0001" })).toBe(false);
    expect(service.cancel(owner.id, { attemptId: "attempt-0001" })).toBe(true);
    await expect(done).resolves.toEqual({ status: "cancelled" });
    expect(spawned[0]!.signals).toContain("SIGTERM");
    expect(await waiting.done).toBe(1);
    // A master up by now may be another caller's: Cancel never closes one.
    expect(calls.some(({ args }) => args.includes("-O"))).toBe(false);
  });

  it("takes down what ssh started too, even what outlives ssh's own SIGTERM", async () => {
    const pidFile = path.join(clientDir, "proxy.pid");
    const fakeSsh = path.join(clientDir, "ssh");
    // A ProxyJump's ssh stands in: it ignores SIGTERM and would outlive the ssh that started it.
    // It writes its pid only once its trap is set, then becomes the sleep.
    fs.writeFileSync(
      fakeSsh,
      `#!/bin/sh\nsh -c 'trap "" TERM; echo $$ > "$1"; exec sleep 30' sh '${pidFile}' &\nwait\n`,
      { mode: 0o700 }
    );
    const { service } = setup(result({ code: 255, stderr: REFUSED }), {
      spawn: undefined,
      sshPath: () => fakeSsh,
    });
    const { owner } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() =>
      expect(fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8")).toBeTruthy()
    );
    const proxyPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    // Gone, not just a zombie waiting to be reaped. ps prints no line once it's gone.
    const alive = () => {
      const ps = spawnSync("ps", ["-o", "stat=", "-p", String(proxyPid)]);
      if (ps.error) throw ps.error;
      const stat = ps.stdout.toString().trim();
      return stat.length > 0 && !stat.startsWith("Z");
    };
    expect(alive()).toBe(true);
    service.cancel(owner.id, { attemptId: "attempt-0001" });
    await expect(done).resolves.toEqual({ status: "cancelled" });
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5_000 });
  });

  it("still sends SIGKILL to the group when Cancel lands as ssh exits", async () => {
    const { service, spawned } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    spawned[0]!.emit("exit", 0, null);
    service.cancel(owner.id, { attemptId: "attempt-0001" });
    await expect(done).resolves.toEqual({ status: "cancelled" });
    expect(spawned[0]!.signals).toContain("SIGKILL");
  });

  it("stops when the view that asked goes away", async () => {
    const { service, spawned } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner, goAway } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    goAway();
    await expect(done).resolves.toEqual({ status: "cancelled" });
  });

  it("takes no more than ssh reads of an answer", async () => {
    const { service, spawned } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner, events } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    const asked = askAs(spawned[0]!, "Password: ");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const { promptId } = promptEvent(events);
    // 512 two-byte characters: 1,024 bytes, past the 1,022 ssh keeps.
    expect(() =>
      service.answer(owner.id, { attemptId: "attempt-0001", promptId, answer: "é".repeat(512) })
    ).toThrow(expect.objectContaining({ code: "VALIDATION" }));
    expect(
      service.answer(owner.id, { attemptId: "attempt-0001", promptId, answer: "é".repeat(511) })
    ).toBe(true);
    expect(await asked.done).toBe(0);
    service.cancel(owner.id, { attemptId: "attempt-0001" });
    await done;
  });

  it("starts no sign-in to a host that is being removed or re-pointed", async () => {
    const { service, spawned } = setup(result({ code: 255, stderr: REFUSED }), {
      isRetiring: (connection) => connection.kind === "ssh" && connection.target === "greg@studio",
    });
    await expect(
      service.start(fakeOwner().owner, { attemptId: "attempt-0001", connection: SSH })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(spawned).toHaveLength(0);
  });

  it("takes one line of text as an answer, without echoing what was typed", async () => {
    const { service, spawned } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner, events } = fakeOwner();
    const done = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    askAs(spawned[0]!, "Password: ");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    const { promptId } = promptEvent(events);
    let thrown: unknown;
    try {
      service.answer(owner.id, { attemptId: "attempt-0001", promptId, answer: "hunter2\nrm -rf" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("VALIDATION");
    expect(String((thrown as Error).message)).not.toContain("hunter2");
    service.cancel(owner.id, { attemptId: "attempt-0001" });
    await done;
  });

  it("signs in only to an ssh host, one sign-in per host at a time", async () => {
    const { service, spawned } = setup(result({ code: 255, stderr: REFUSED }));
    const { owner } = fakeOwner();
    await expect(
      service.start(owner, {
        attemptId: "attempt-0001",
        connection: { kind: "wsl", distro: "Ubuntu" },
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      service.start(owner, {
        attemptId: "attempt-0001",
        connection: { kind: "cloud", bindingId: "cb_0123456789ab" },
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      service.start(owner, { attemptId: "../../etc", connection: SSH })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const first = service.start(owner, { attemptId: "attempt-0001", connection: SSH });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    await expect(
      service.start(fakeOwner(9).owner, { attemptId: "attempt-0002", connection: SSH })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    // Another host signs in alongside.
    const other = service.start(fakeOwner(9).owner, {
      attemptId: "attempt-0003",
      connection: { kind: "ssh", target: "greg@lab" },
    });
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    service.cancelTarget("greg@studio");
    await expect(first).resolves.toEqual({ status: "cancelled" });
    spawned[1]!.exit(0);
    await expect(other).resolves.toEqual({ status: "signed-in" });
  });
});
