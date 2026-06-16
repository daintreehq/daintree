import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(repoRoot, "scripts/validate-plugin-manifests.ts");

function run(base: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", SCRIPT], {
      cwd: repoRoot,
      env: { ...process.env, DAINTREE_PLUGIN_MANIFEST_BASE: base },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function writeManifest(base: string, kind: "builtin" | "sample", name: string, manifest: unknown) {
  const dir = path.join(base, kind, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2)
  );
}

const validManifest = { name: "acme.example", version: "1.0.0" };

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-validate-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("validate-plugin-manifests CLI", () => {
  it("exits 0 when every manifest is valid", async () => {
    writeManifest(base, "builtin", "github", validManifest);
    writeManifest(base, "sample", "acme-example", validManifest);
    const { code, stdout } = await run(base);
    expect(code).toBe(0);
    expect(stdout).toContain("all manifests valid");
  });

  it("exits 0 with no plugin directories present", async () => {
    const { code } = await run(base);
    expect(code).toBe(0);
  });

  it("fails on malformed JSON and names the offending file", async () => {
    writeManifest(base, "sample", "broken", "{ not valid json ");
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toContain("Invalid JSON");
    expect(stderr).toContain(path.join("sample", "broken", "plugin.json"));
  });

  it("fails on a schema-invalid manifest and names the field", async () => {
    // `name` must be in publisher.name format — a bare name is rejected.
    writeManifest(base, "sample", "badname", { name: "nodot", version: "1.0.0" });
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toContain("name");
  });

  it("accepts a daintree.* sample name (validated as built-in, mirroring sideload)", async () => {
    // Sample plugins are sideloaded with isBuiltin: true, so the reserved
    // daintree.* namespace must pass — this guards the flag choice.
    writeManifest(base, "sample", "daintree-hello", { name: "daintree.hello", version: "0.1.0" });
    const { code } = await run(base);
    expect(code).toBe(0);
  });

  it("skips a directory that has no plugin.json", async () => {
    fs.mkdirSync(path.join(base, "sample", "manifest-less"), { recursive: true });
    const { code } = await run(base);
    expect(code).toBe(0);
  });

  it("reports every invalid manifest, not just the first", async () => {
    writeManifest(base, "sample", "bad-one", { name: "nodot", version: "1.0.0" });
    writeManifest(base, "sample", "bad-two", "{ broken ");
    const { code, stderr } = await run(base);
    expect(code).toBe(1);
    expect(stderr).toContain("2 invalid manifest(s)");
  });
});
