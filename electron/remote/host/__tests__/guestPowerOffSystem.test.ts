// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GuestPowerOffTarget } from "../../cloud/machineKeeperLink.js";
import {
  createGuestPowerOffSystem,
  runCommand,
  verifyCloudIdentity,
  type CommandRun,
  type MetadataFetch,
  type MetadataResponse,
} from "../guestPowerOffSystem.js";

const AWS: GuestPowerOffTarget = {
  provider: "aws",
  accountId: "123456789012",
  region: "eu-west-1",
  instanceId: "i-0abc0000000000001",
};
const GCE: GuestPowerOffTarget = {
  provider: "gce",
  project: "daintree-build",
  zone: "us-central1-a",
  instanceId: "9007199254740993123",
};
const signal = new AbortController().signal;

const ok = (body: string, headers: MetadataResponse["headers"] = {}): MetadataResponse => ({
  status: 200,
  headers,
  body,
});

function ec2Metadata(document: Record<string, unknown>): MetadataFetch {
  return async (request) => {
    if (request.method === "PUT") return ok("token-1");
    if (request.headers["X-aws-ec2-metadata-token"] !== "token-1") {
      return { status: 401, headers: {}, body: "" };
    }
    return ok(JSON.stringify(document));
  };
}

function gceMetadata(values: Record<string, string>, flavor = "Google"): MetadataFetch {
  return async (request) => {
    const key = request.path.replace("/computeMetadata/v1/", "");
    const value = values[key];
    return value === undefined
      ? { status: 404, headers: {}, body: "" }
      : ok(value, { "metadata-flavor": flavor });
  };
}

function system(overrides: { run?: CommandRun; platform?: NodeJS.Platform } = {}) {
  const files = new Map<string, string>([
    ["/proc/sys/kernel/random/boot_id", "6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b\n"],
  ]);
  const run = vi.fn<CommandRun>(overrides.run ?? (async () => ({ code: 0, stderr: "" })));
  return {
    files,
    run,
    system: createGuestPowerOffSystem({
      armFile: "/data/guest-power-off.json",
      platform: overrides.platform ?? "linux",
      fetch: async () => ok(""),
      run,
      exists: async (file) => file === "/bin/systemctl",
      readFile: async (file) => {
        const content = files.get(file);
        if (content === undefined) throw new Error("ENOENT");
        return content;
      },
      writeFile: async (file, data) => {
        files.set(file, data);
      },
      removeFile: async (file) => {
        files.delete(file);
      },
    }),
  };
}

describe("verifyCloudIdentity (#17362)", () => {
  it("takes an EC2 machine its identity document names, with an IMDSv2 token", async () => {
    const fetch = vi.fn(
      ec2Metadata({ accountId: AWS.accountId, region: AWS.region, instanceId: AWS.instanceId })
    );
    await expect(verifyCloudIdentity(fetch, AWS, signal)).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls.map(([request]) => `${request.method} ${request.path}`)).toEqual([
      "PUT /latest/api/token",
      "GET /latest/dynamic/instance-identity/document",
    ]);
  });

  it("says definitely not for another account, region or instance", async () => {
    for (const other of [
      { accountId: "210987654321" },
      { region: "us-east-2" },
      { instanceId: "i-0abc0000000000009" },
    ]) {
      const fetch = ec2Metadata({ ...AWS, ...other });
      await expect(verifyCloudIdentity(fetch, AWS, signal)).resolves.toMatchObject({
        ok: false,
        definite: true,
      });
    }
  });

  it("can't tell when the metadata server doesn't answer as EC2's would", async () => {
    const noToken: MetadataFetch = async () => ({ status: 404, headers: {}, body: "" });
    const garbled: MetadataFetch = async (request) =>
      request.method === "PUT" ? ok("token-1") : ok("not json");
    const unreachable: MetadataFetch = async () => {
      throw new Error("EHOSTUNREACH");
    };
    for (const fetch of [noToken, garbled, unreachable]) {
      await expect(verifyCloudIdentity(fetch, AWS, signal)).resolves.toMatchObject({
        ok: false,
        definite: false,
      });
    }
  });

  it("takes a Compute Engine VM its metadata names, keeping a large id exact", async () => {
    const fetch = gceMetadata({
      "project/project-id": GCE.project,
      "instance/zone": `projects/123456789/zones/${GCE.zone}`,
      "instance/id": GCE.instanceId,
    });
    await expect(verifyCloudIdentity(fetch, GCE, signal)).resolves.toEqual({ ok: true });
    await expect(
      verifyCloudIdentity(fetch, { ...GCE, instanceId: "9007199254740993124" }, signal)
    ).resolves.toMatchObject({ ok: false, definite: true });
  });

  it("trusts no Compute Engine answer without Google's flavor, or with a zone it can't read", async () => {
    const values = {
      "project/project-id": GCE.project,
      "instance/zone": `projects/123456789/zones/${GCE.zone}`,
      "instance/id": GCE.instanceId,
    };
    await expect(
      verifyCloudIdentity(gceMetadata(values, "Other"), GCE, signal)
    ).resolves.toMatchObject({ ok: false, definite: false });
    await expect(
      verifyCloudIdentity(gceMetadata({ ...values, "instance/zone": GCE.zone }), GCE, signal)
    ).resolves.toMatchObject({ ok: false, definite: false });
  });
});

describe("createGuestPowerOffSystem (#17362)", () => {
  it("only a Linux machine may power itself off", () => {
    expect(system({ platform: "darwin" }).system.unsupported()).toMatch(/Linux/);
    expect(system().system.unsupported()).toBeNull();
  });

  it("asks sudo whether it may power off without running it, then powers off without a shell or password", async () => {
    const { system: machine, run } = system();
    await expect(machine.probePowerOff(signal)).resolves.toBeNull();
    await expect(machine.powerOff(signal)).resolves.toEqual({ kind: "accepted" });
    expect(run.mock.calls.map(([file, args]) => [file, ...args])).toEqual([
      ["/usr/bin/sudo", "-n", "-l", "/bin/systemctl", "poweroff"],
      ["/usr/bin/sudo", "-n", "/bin/systemctl", "poweroff"],
    ]);
  });

  it("says why when sudo wants a password, and tells a refusal from a cut-off command", async () => {
    const refused = system({
      run: async () => ({ code: 1, stderr: "sudo: a password is required\n" }),
    });
    await expect(refused.system.probePowerOff(signal)).resolves.toMatch(/without a password/);
    await expect(refused.system.powerOff(signal)).resolves.toEqual({
      kind: "refused",
      problem: "This machine refused to power itself off: sudo: a password is required",
    });
    const cutOff = system({ run: async () => ({ code: null, stderr: "" }) });
    await expect(cutOff.system.powerOff(signal)).resolves.toEqual({ kind: "unknown" });
  });

  it("keeps an arm for this boot only, and reads back nothing it didn't write", async () => {
    const { system: machine, files } = system();
    const bootId = await machine.bootId();
    expect(bootId).toBe("6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b");
    await machine.saveArm({ bootId: bootId!, target: GCE });
    await expect(machine.loadArm()).resolves.toEqual({ bootId, target: GCE });
    files.set("/data/guest-power-off.json", JSON.stringify({ version: 2, bootId, target: GCE }));
    await expect(machine.loadArm()).resolves.toBeNull();
    files.set(
      "/data/guest-power-off.json",
      JSON.stringify({ version: 1, bootId, target: { ...GCE, secret: "x" } })
    );
    await expect(machine.loadArm()).resolves.toBeNull();
    files.set("/data/guest-power-off.json", "{");
    await expect(machine.loadArm()).resolves.toBeNull();
    await machine.saveArm(null);
    expect(files.has("/data/guest-power-off.json")).toBe(false);
  });
});

describe("runCommand", () => {
  it("reports the exit code and what the program said, with no shell between", async () => {
    await expect(
      runCommand("/bin/sh", ["-c", "echo refused >&2; exit 3"], signal)
    ).resolves.toEqual({ code: 3, stderr: "refused\n" });
  });

  it("says nothing is known of a command cut off before it answered", async () => {
    const controller = new AbortController();
    const running = runCommand("/bin/sh", ["-c", "sleep 5"], controller.signal);
    controller.abort();
    await expect(running).resolves.toMatchObject({ code: null });
  });
});
