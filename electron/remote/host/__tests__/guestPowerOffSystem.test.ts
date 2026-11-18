// @vitest-environment node
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GuestPowerOffTarget } from "../../cloud/machineKeeperLink.js";
import {
  createGuestPowerOffSystem,
  createMetadataFetch,
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
    if (request.method === "PUT") {
      // IMDSv2 turns away a token request that doesn't say how long it should last.
      return request.headers["X-aws-ec2-metadata-token-ttl-seconds"]
        ? ok("token-1")
        : { status: 400, headers: {}, body: "" };
    }
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
    const noToken: MetadataFetch = async () => ({ status: 404, headers: {}, body: "token-1" });
    const emptyToken: MetadataFetch = async (request) =>
      request.method === "PUT" ? ok("") : ok(JSON.stringify(AWS));
    const garbled: MetadataFetch = async (request) =>
      request.method === "PUT" ? ok("token-1") : ok("not json");
    const unreachable: MetadataFetch = async () => {
      throw new Error("EHOSTUNREACH");
    };
    for (const fetch of [noToken, emptyToken, garbled, unreachable]) {
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
    const launch = await machine.preparePowerOff();
    if (typeof launch === "string") throw new Error(launch);
    // Readying it ran nothing.
    expect(run).toHaveBeenCalledTimes(1);
    const outcome = launch(signal);
    // Started the moment it was called, before anything else could run.
    expect(run).toHaveBeenCalledTimes(2);
    await expect(outcome).resolves.toEqual({ kind: "accepted" });
    expect(run.mock.calls.map(([file, args]) => [file, ...args])).toEqual([
      ["/usr/bin/sudo", "-n", "-l", "/bin/systemctl", "poweroff"],
      ["/usr/bin/sudo", "-n", "/bin/systemctl", "poweroff"],
    ]);
  });

  it("says why when sudo wants a password, and tells a refusal from a cut-off command", async () => {
    const launchWith = async (machine: ReturnType<typeof system>["system"]) => {
      const launch = await machine.preparePowerOff();
      if (typeof launch === "string") throw new Error(launch);
      return launch(signal);
    };
    const refused = system({
      run: async () => ({ code: 1, stderr: "sudo: a password is required\n" }),
    });
    await expect(refused.system.probePowerOff(signal)).resolves.toMatch(/without a password/);
    await expect(launchWith(refused.system)).resolves.toEqual({
      kind: "refused",
      problem: "This machine refused to power itself off: sudo: a password is required",
    });
    const cutOff = system({ run: async () => ({ code: null, stderr: "" }) });
    await expect(launchWith(cutOff.system)).resolves.toEqual({ kind: "unknown" });
    const missing = system({
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(launchWith(missing.system)).resolves.toMatchObject({ kind: "refused" });
  });

  it("writes the saved permission readable by its owner only", async () => {
    if (process.platform === "win32") return;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "guest-power-off-"));
    try {
      const file = path.join(dir, "guest-power-off.json");
      const machine = createGuestPowerOffSystem({ armFile: file, platform: "linux" });
      await machine.saveArm({ bootId: "6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b", target: GCE });
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      await expect(machine.loadArm()).resolves.toMatchObject({ target: GCE });
      await machine.saveArm(null);
      await expect(fs.access(file)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

describe("createMetadataFetch", () => {
  async function serve(handler: http.RequestListener) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      fetch: createMetadataFetch({ host: "127.0.0.1", port, timeoutMs: 300 }),
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  it("gives up on a server that trickles its answer past the deadline", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200);
      // Never quiet long enough for a socket timeout, and done only well after the deadline.
      const timer = setInterval(() => res.write("x"), 50);
      const done = setTimeout(() => res.end(), 1_000);
      res.on("close", () => {
        clearInterval(timer);
        clearTimeout(done);
      });
    });
    try {
      const started = Date.now();
      await expect(server.fetch({ method: "GET", path: "/", headers: {} }, signal)).rejects.toThrow(
        /timed out/
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.close();
    }
  });

  it("follows no redirect, and refuses an answer past its size cap", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/moved") {
        res.writeHead(302, { location: "http://example.com/" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("x".repeat(70 * 1024));
    });
    try {
      await expect(
        server.fetch({ method: "GET", path: "/moved", headers: {} }, signal)
      ).resolves.toMatchObject({ status: 302, body: "" });
      await expect(
        server.fetch({ method: "GET", path: "/big", headers: {} }, signal)
      ).rejects.toThrow(/too large/);
    } finally {
      server.close();
    }
  });
});

describe("runCommand", () => {
  const node = process.execPath;

  it("reports the exit code and what the program said, with no shell between", async () => {
    await expect(
      runCommand(node, ["-e", "process.stderr.write('refused\\n'); process.exit(3)"], signal)
    ).resolves.toEqual({ code: 3, stderr: "refused\n" });
  });

  it("says nothing is known of a command cut off after it started", async () => {
    const controller = new AbortController();
    const running = runCommand(node, ["-e", "setTimeout(() => {}, 5000)"], controller.signal);
    controller.abort();
    await expect(running).resolves.toMatchObject({ code: null });
  });

  it("starts nothing once its signal has fired, and refuses a program that can't start", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCommand(node, ["-e", "0"], controller.signal)).rejects.toThrow(/Cancelled/);
    await expect(
      runCommand(path.join(os.tmpdir(), "no-such-program-daintree"), [], signal)
    ).rejects.toThrow();
  });
});
