import { describe, expect, it } from "vitest";
import { systemdUnitFor } from "../../host/startAtLogin.js";
import type { CommandInput, CommandResult } from "../commandRunner.js";
import {
  bootstrapHostMode,
  ENABLE_LINGER_SCRIPT,
  hostModeConfirmed,
  DROP_UNIT_BACKUP_SCRIPT,
  REMOVE_UNIT_SCRIPT,
  restoreUnitScript,
  SAVE_UNIT_SCRIPT,
  linuxHandoffScript,
  MAC_ENABLE_SCRIPT,
  START_UNIT_SCRIPT,
  writeUnitScript,
} from "../hostModeBootstrap.js";
import { probeHost, type ProbeOutcome } from "../hostProbe.js";
import type { HostCommandChannel } from "../remoteShell.js";

const CLIENT = { version: "1.4.0", commit: "abcdef0123" };
const BUILD = '{"daintreeBuildInfo":1,"version":"1.4.0","commit":"abcdef0123"}';

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  stdout,
  stderr: "",
  spawnError: null,
  timedOut: false,
});
const fail = (stderr: string, code = 1): CommandResult => ({
  code,
  stdout: "",
  stderr,
  spawnError: null,
  timedOut: false,
});

function state(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    daintreeHostMode: 1,
    pid: 4242,
    enabled: true,
    startAtLogin: true,
    startAtLoginInstalled: true,
    startAtLoginError: null,
    keychain: {
      state: "ok",
      detail: "Keychain answered a test encrypt and decrypt",
      checked: true,
    },
    ...overrides,
  });
}

function mac(opts: { listening?: boolean; running?: boolean; agent?: boolean; state?: string }) {
  return [
    "@@dt:uname Darwin arm64",
    "@@dt:install app-bundle /Applications/Daintree.app",
    "@@dt:version 1.4.0",
    `@@dt:buildinfo ${BUILD}`,
    ...(opts.running || opts.listening ? ["@@dt:running yes"] : []),
    `@@dt:launchagent ${opts.agent ? "yes" : "no"}`,
    ...(opts.listening ? ["@@dt:listening yes", "@@dt:hostpid 4242"] : []),
    ...(opts.state ? [`@@dt:hostmodestate ${opts.state}`] : []),
    "@@dt:end",
  ].join("\n");
}

function linux(opts: {
  install?: "deb" | "appimage";
  listening?: boolean;
  running?: boolean;
  unit?: "enabled" | "missing";
  linger?: "yes" | "no";
  fuse?: boolean;
  state?: string;
}) {
  const image = "/home/greg/Applications/Daintree.AppImage";
  return [
    "@@dt:uname Linux x86_64",
    ...(opts.install === "appimage"
      ? [`@@dt:appimage ${image}`, `@@dt:appimageinfo ${BUILD}`]
      : ["@@dt:install deb /opt/Daintree", "@@dt:version 1.4.0", `@@dt:buildinfo ${BUILD}`]),
    ...(opts.running || opts.listening ? ["@@dt:running yes"] : []),
    ...(opts.unit === "enabled" ? ["@@dt:unit yes", "@@dt:unitenabled enabled"] : ["@@dt:unit no"]),
    `@@dt:linger Linger=${opts.linger ?? "no"}`,
    `@@dt:fuse ${opts.fuse === false ? "no" : "yes"}`,
    ...(opts.listening ? ["@@dt:listening yes", "@@dt:hostpid 4242"] : []),
    ...(opts.state ? [`@@dt:hostmodestate ${opts.state}`] : []),
    "@@dt:end",
  ].join("\n");
}

interface Recorded {
  script: string;
  input?: CommandInput;
}

/** A running Daintree takes the handoff; there was no unit before; anything else succeeds quietly. */
const handedOver = (script: string) =>
  script.includes("--host-mode-handoff")
    ? ok("@@dt:handoff 0\n")
    : script === SAVE_UNIT_SCRIPT
      ? ok("@@dt:unitsaved no\n")
      : ok();

function scripted(answer: (script: string) => CommandResult = handedOver) {
  const calls: Recorded[] = [];
  const channel: HostCommandChannel = {
    exec: async (script) => {
      calls.push({ script });
      return answer(script);
    },
    execWithInput: async (script, input) => {
      calls.push({ script, input });
      return answer(script);
    },
    sendFile: async () => ok(),
  };
  return { channel, calls };
}

async function outcomeOf(stdout: string): Promise<ProbeOutcome> {
  return probeHost({
    sshTarget: "studio",
    client: CLIENT,
    shell: {
      exec: async () => ok(stdout),
      execWithInput: async () => ok(),
      sendFile: async () => ok(),
    },
  });
}

/** Probe answers in order; the last one repeats. */
function probes(outputs: string[]) {
  const queue = [...outputs];
  let count = 0;
  return {
    probe: async () => {
      count++;
      return outcomeOf(queue.length > 1 ? queue.shift()! : queue[0]!);
    },
    count: () => count,
  };
}

function clock() {
  let t = 0;
  return () => (t += 1_000);
}

describe("bootstrapHostMode on a Mac", () => {
  it("launches through the logged-in session with --enable-host-mode and succeeds only on read-back", async () => {
    const { channel, calls } = scripted();
    const seen = probes([
      mac({ listening: false }),
      mac({ listening: true, agent: false, state: state({ enabled: false, startAtLogin: false }) }),
      mac({ listening: true, agent: true, state: state() }),
    ]);
    const result = await bootstrapHostMode("studio", await outcomeOf(mac({})), {
      channel,
      probe: seen.probe,
      sleep: async () => {},
      now: clock(),
    });
    expect(calls.map((c) => c.script)).toEqual([MAC_ENABLE_SCRIPT]);
    expect(MAC_ENABLE_SCRIPT).toBe(
      "open -n -g -a '/Applications/Daintree.app' --args --host-mode --enable-host-mode"
    );
    expect(seen.count()).toBe(3);
    expect(result.probe.hostModeState).toMatchObject({ enabled: true, startAtLogin: true });
    expect(result.lingerRefused).toBeNull();
  });

  it("fails, naming what it saw, when Host mode listens but the setting never reads back", async () => {
    const { channel } = scripted();
    const listeningOnly = mac({ listening: true, state: state({ enabled: false }) });
    await expect(
      bootstrapHostMode("studio", await outcomeOf(mac({})), {
        channel,
        probe: probes([listeningOnly]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/listening on studio, but its setting there didn't read back as on/);
  });

  it("reports the host's own reason when start at login couldn't be installed", async () => {
    const { channel } = scripted();
    const failed = mac({
      listening: true,
      state: state({
        startAtLogin: false,
        startAtLoginInstalled: false,
        startAtLoginError: "EACCES: permission denied, open '~/Library/LaunchAgents'",
      }),
    });
    await expect(
      bootstrapHostMode("studio", await outcomeOf(mac({})), {
        channel,
        probe: probes([failed]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/start at login couldn't be installed there: EACCES/);
  });

  it("doesn't trust a status file left by an earlier process", () => {
    return outcomeOf(mac({ listening: true, agent: true, state: state({ pid: 1111 }) })).then(
      (outcome) => expect(hostModeConfirmed(outcome)).toBe(false)
    );
  });

  it("does nothing on a host already switched on", async () => {
    const { channel, calls } = scripted();
    const result = await bootstrapHostMode(
      "studio",
      await outcomeOf(mac({ listening: true, agent: true, state: state() })),
      { channel, probe: probes([mac({})]).probe, sleep: async () => {}, now: clock() }
    );
    expect(calls).toEqual([]);
    expect(result.probe.hostModeListening).toBe(true);
  });

  it("refuses a host on another build rather than start something that can't be reached", async () => {
    const { channel, calls } = scripted();
    const other = mac({}).replace(BUILD, BUILD.replace("abcdef0123", "0000000000"));
    await expect(
      bootstrapHostMode("studio", await outcomeOf(other), {
        channel,
        probe: probes([other]).probe,
        sleep: async () => {},
      })
    ).rejects.toThrow(/runs a different build/);
    expect(calls).toEqual([]);
  });
});

describe("bootstrapHostMode on a headless Linux host", () => {
  it("writes and enables the Daintree unit, asks for linger, starts it, then hands over --enable-host-mode", async () => {
    const { channel, calls } = scripted();
    const target = { executable: "/opt/Daintree/daintree", appPath: null };
    const result = await bootstrapHostMode("bigbox", await outcomeOf(linux({})), {
      channel,
      probe: probes([
        linux({ unit: "enabled" }),
        linux({ unit: "enabled", listening: true }),
        linux({ unit: "enabled", listening: true, linger: "yes", state: state() }),
      ]).probe,
      sleep: async () => {},
      now: clock(),
    });
    expect(calls.map((c) => c.script)).toEqual([
      ENABLE_LINGER_SCRIPT,
      SAVE_UNIT_SCRIPT,
      writeUnitScript(),
      START_UNIT_SCRIPT,
      linuxHandoffScript({ ...target, appImageExtractAndRun: false }),
    ]);
    // The very text the host writes for itself, so it finds its unit current.
    expect(calls[2]!.input).toEqual({ text: systemdUnitFor(target) });
    expect(writeUnitScript()).toBe(
      'mkdir -p "$HOME/.config/systemd/user" && cat > "$HOME/.config/systemd/user/daintree-host.service.tmp" && chmod 644 "$HOME/.config/systemd/user/daintree-host.service.tmp" && mv -f "$HOME/.config/systemd/user/daintree-host.service.tmp" "$HOME/.config/systemd/user/daintree-host.service" && systemctl --user daemon-reload && systemctl --user enable daintree-host.service'
    );
    expect(calls[4]!.script).toBe(
      "'/opt/Daintree/daintree' --host-mode --enable-host-mode --host-mode-handoff </dev/null >/dev/null 2>&1; echo \"@@dt:handoff $?\""
    );
    expect(result).toMatchObject({ lingerRefused: null, probe: { hostModeListening: true } });
  });

  it("says in the host's words why lingering was refused, and still switches Host mode on", async () => {
    const { channel } = scripted((script) =>
      script === ENABLE_LINGER_SCRIPT
        ? fail("Could not enable linger: Interactive authentication required.")
        : script.includes("--host-mode-handoff")
          ? ok("@@dt:handoff 0\n")
          : handedOver(script)
    );
    const result = await bootstrapHostMode("bigbox", await outcomeOf(linux({})), {
      channel,
      probe: probes([
        linux({ unit: "enabled", listening: true }),
        linux({ unit: "enabled", listening: true, state: state() }),
      ]).probe,
      sleep: async () => {},
      now: clock(),
    });
    expect(result.lingerRefused).toBe(
      "Could not enable linger: Interactive authentication required."
    );
  });

  it("runs an AppImage unpacked, in the unit and the handoff, where there is no FUSE", async () => {
    const { channel, calls } = scripted();
    const before = linux({ install: "appimage", fuse: false, linger: "yes" });
    await bootstrapHostMode("bigbox", await outcomeOf(before), {
      channel,
      probe: probes([
        linux({
          install: "appimage",
          fuse: false,
          listening: true,
          unit: "enabled",
          linger: "yes",
        }),
        linux({
          install: "appimage",
          fuse: false,
          listening: true,
          unit: "enabled",
          linger: "yes",
          state: state(),
        }),
      ]).probe,
      sleep: async () => {},
      now: clock(),
    });
    const unit = calls.find((c) => c.input)!.input as { text: string };
    expect(unit.text).toContain(
      'ExecStart="/home/greg/Applications/Daintree.AppImage" "--host-mode"'
    );
    expect(unit.text).toContain("Environment=APPIMAGE_EXTRACT_AND_RUN=1");
    expect(calls.at(-1)!.script).toMatch(
      /^APPIMAGE_EXTRACT_AND_RUN=1 '\/home\/greg\/Applications\/Daintree\.AppImage' --host-mode --enable-host-mode --host-mode-handoff /
    );
    // Linger was already on: not asked again.
    expect(calls.some((c) => c.script === ENABLE_LINGER_SCRIPT)).toBe(false);
  });

  it("hands over to a Daintree already running there without installing or starting a unit", async () => {
    const { channel, calls } = scripted((script) =>
      script.includes("--host-mode-handoff") ? ok("@@dt:handoff 0\n") : ok()
    );
    await bootstrapHostMode("bigbox", await outcomeOf(linux({ running: true, linger: "yes" })), {
      channel,
      probe: probes([linux({ unit: "enabled", listening: true, linger: "yes", state: state() })])
        .probe,
      sleep: async () => {},
      now: clock(),
    });
    expect(calls.map((c) => c.script)).toEqual([
      linuxHandoffScript({
        executable: "/opt/Daintree/daintree",
        appPath: null,
        appImageExtractAndRun: false,
      }),
    ]);
  });

  it("stops when the handoff finds nothing running, rather than start a backend under SSH", async () => {
    const { channel } = scripted((script) =>
      script.includes("--host-mode-handoff") ? ok("@@dt:handoff 3\n") : ok()
    );
    await expect(
      bootstrapHostMode("bigbox", await outcomeOf(linux({ running: true, linger: "yes" })), {
        channel,
        probe: probes([linux({ running: true })]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/stopped running on bigbox/);
  });

  it("reports systemctl's own words when the user's service manager can't be reached", async () => {
    const { channel } = scripted((script) =>
      script === writeUnitScript()
        ? fail("Failed to connect to bus: No medium found")
        : handedOver(script)
    );
    await expect(
      bootstrapHostMode("bigbox", await outcomeOf(linux({ linger: "yes" })), {
        channel,
        probe: probes([linux({})]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/Host mode service \(systemctl --user\): Failed to connect to bus/);
  });

  it("removes the unit it wrote when Host mode never reads back, so nothing starts at the next login", async () => {
    const { channel, calls } = scripted();
    await expect(
      bootstrapHostMode("bigbox", await outcomeOf(linux({ linger: "yes" })), {
        channel,
        probe: probes([linux({ unit: "enabled", listening: true, linger: "yes" })]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/didn't record that it was switched on/);
    expect(calls.at(-1)!.script).toBe(REMOVE_UNIT_SCRIPT);
  });

  it("puts back a disabled, stopped unit that was there before, as it was, when setup fails", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted no\n@@dt:unitactive inactive\n")
        : script === START_UNIT_SCRIPT
          ? fail("Job failed")
          : handedOver(script)
    );
    await expect(
      bootstrapHostMode("bigbox", await outcomeOf(linux({ linger: "yes", unit: "enabled" })), {
        channel,
        probe: probes([linux({ unit: "enabled", linger: "yes" })]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/Couldn't start the Host mode service/);
    const restore = restoreUnitScript({ existed: true, wanted: false, active: false });
    expect(calls.map((c) => c.script)).toEqual([
      SAVE_UNIT_SCRIPT,
      writeUnitScript(),
      START_UNIT_SCRIPT,
      restore,
    ]);
    expect(restore).toBe(
      'rm -f "$HOME/.config/systemd/user/default.target.wants/daintree-host.service" && mv -f "$HOME/.config/systemd/user/daintree-host.service.daintree-setup-backup" "$HOME/.config/systemd/user/daintree-host.service" && systemctl --user daemon-reload && { systemctl --user stop daintree-host.service >/dev/null 2>&1; true; }'
    );
    expect(calls.some((c) => c.script === REMOVE_UNIT_SCRIPT)).toBe(false);
  });

  it("puts back an enabled, running unit without touching its links, and running", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted yes\n@@dt:unitactive active\n")
        : script.includes("--host-mode-handoff")
          ? ok("@@dt:handoff 1\n")
          : ok()
    );
    await expect(
      bootstrapHostMode("bigbox", await outcomeOf(linux({ linger: "yes", unit: "enabled" })), {
        channel,
        probe: probes([linux({ unit: "enabled", listening: true, linger: "yes" })]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/didn't take the request/);
    const restore = restoreUnitScript({ existed: true, wanted: true, active: true });
    expect(calls.at(-1)!.script).toBe(restore);
    expect(restore).toBe(
      'mv -f "$HOME/.config/systemd/user/daintree-host.service.daintree-setup-backup" "$HOME/.config/systemd/user/daintree-host.service" && systemctl --user daemon-reload && systemctl --user start daintree-host.service'
    );
  });

  it("drops its copy of the earlier unit once Host mode reads back on", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted no\n@@dt:unitactive inactive\n")
        : handedOver(script)
    );
    await bootstrapHostMode("bigbox", await outcomeOf(linux({ linger: "yes", unit: "enabled" })), {
      channel,
      probe: probes([linux({ unit: "enabled", listening: true, linger: "yes", state: state() })])
        .probe,
      sleep: async () => {},
      now: clock(),
    });
    expect(calls.at(-1)!.script).toBe(DROP_UNIT_BACKUP_SCRIPT);
  });

  it("touches nothing when it can't keep a copy of the unit already there", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved failed\n@@dt:unitwanted yes\n@@dt:unitactive inactive\n")
        : handedOver(script)
    );
    await expect(
      bootstrapHostMode("bigbox", await outcomeOf(linux({ linger: "yes", unit: "enabled" })), {
        channel,
        probe: probes([linux({ unit: "enabled", linger: "yes" })]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/Couldn't keep a copy of the Host mode service/);
    expect(calls.map((c) => c.script)).toEqual([SAVE_UNIT_SCRIPT]);
  });

  it("touches nothing when it can't tell whether the unit already there was running", async () => {
    const { channel, calls } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted yes\n@@dt:unitactive \n")
        : handedOver(script)
    );
    await expect(
      bootstrapHostMode("bigbox", await outcomeOf(linux({ linger: "yes", unit: "enabled" })), {
        channel,
        probe: probes([linux({ unit: "enabled", linger: "yes" })]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(/Couldn't keep a copy of the Host mode service/);
    expect(calls.map((c) => c.script)).toEqual([SAVE_UNIT_SCRIPT]);
  });

  it("says where the earlier unit's copy is when it can't be put back", async () => {
    const { channel } = scripted((script) =>
      script === SAVE_UNIT_SCRIPT
        ? ok("@@dt:unitsaved yes\n@@dt:unitwanted no\n@@dt:unitactive inactive\n")
        : script === START_UNIT_SCRIPT
          ? fail("Job failed")
          : script.startsWith("rm -f")
            ? fail("mv: cannot move: Read-only file system")
            : handedOver(script)
    );
    await expect(
      bootstrapHostMode("bigbox", await outcomeOf(linux({ linger: "yes", unit: "enabled" })), {
        channel,
        probe: probes([linux({ unit: "enabled", linger: "yes" })]).probe,
        sleep: async () => {},
        now: clock(),
      })
    ).rejects.toThrow(
      /Couldn't start the Host mode service: Job failed\. Setup couldn't put back the Host mode service that was already on bigbox: its copy is at ~\/\.config\/systemd\/user\/daintree-host\.service\.daintree-setup-backup there \(mv: cannot move: Read-only file system\)/
    );
  });

  it("doesn't take a host whose listener pid wasn't seen alive as switched on", async () => {
    const stale = await outcomeOf(
      linux({ unit: "enabled", listening: true, state: state() }).replace("@@dt:hostpid 4242\n", "")
    );
    expect(hostModeConfirmed(stale)).toBe(false);
  });
});
