import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { parseArgs } from "../run";
import { REGISTRY } from "../registry";

/**
 * The evidence-rich rerun, and the rule that keeps it from poisoning the
 * numbers it exists to explain.
 *
 * A profiled run is slower, so its durations are not comparable to anything.
 * Two things follow, and both are asserted here: the bundle has to say so
 * where a reader cannot miss it, and the run must stay out of the machine's
 * trend history, which has no column to explain an inflated entry.
 */

const execFileAsync = promisify(execFile);
const perfDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(perfDir, "..", "..");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

async function diagnose(
  args: string[],
  cwd = repoRoot
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(perfDir, "diagnose.ts"), ...args],
      { cwd }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("perf diagnose", () => {
  it("is reachable from the dispatcher", () => {
    expect(REGISTRY.diagnose).toBeDefined();
    expect(REGISTRY.diagnose!.kind).toBe("diagnostic");
  });

  it("requires a scenario", { timeout: 60_000 }, async () => {
    const { code, stderr } = await diagnose([]);
    expect(code).toBe(1);
    expect(stderr).toContain("--scenario is required");
  });

  it("rejects an unknown flag rather than ignoring it", { timeout: 60_000 }, async () => {
    const { code, stderr } = await diagnose(["--scenario", "PERF-036", "--profile"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown flag");
  });

  it("writes a bundle whose manifest refuses its own durations", { timeout: 300_000 }, async () => {
    // Deliberately WITHOUT `--out-dir`, driven from a throwaway cwd: the
    // default `<cwd>/.tmp/perf-diagnostics` is the path every real caller
    // takes, and a test that always passed its own out-dir under the system
    // temp dir never exercised the rename that assembles the bundle there.
    fs.mkdirSync(path.join(repoRoot, ".tmp"), { recursive: true });
    const cwd = fs.mkdtempSync(path.join(repoRoot, ".tmp", "perf-diagnose-cwd-"));
    dirs.push(cwd);
    const outDir = path.join(cwd, ".tmp", "perf-diagnostics");

    const { code, stdout } = await diagnose(["--scenario", "PERF-036"], cwd);
    expect(code, stdout).toBe(0);

    const bundles = fs.readdirSync(outDir).filter((name) => name.startsWith("PERF-036-"));
    expect(bundles).toHaveLength(1);
    const bundle = path.join(outDir, bundles[0]!);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(bundle, "manifest.json"), "utf-8")
    ) as Record<string, unknown>;

    // The one field a reader must not be able to miss.
    expect(manifest.durationsComparable).toBe(false);
    expect(String(manifest.durationsComparableReason)).toContain("inflate");

    // Tied to a commit, a harness and a machine, or it explains nothing later.
    expect(manifest.harnessHash).toMatch(/^[0-9a-f]{16}$/);
    expect((manifest.environment as { sourceSha?: string }).sourceSha).toBeTruthy();
    expect((manifest.benchmarkClass as { kind?: string }).kind).toBe("mechanism");

    // "enforced: false, valid: true" reads as "checked and fine" when it means
    // "not checked". The status says which.
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.integrityStatus).toBe("not-enforced-no-issues");

    // The artifacts a plain-Node scenario can actually produce, each with a
    // size and digest — a filename cannot show a bundle read a month later
    // still holds what its manifest describes.
    type Artifact = { name: string; bytes: number; sha256: string };
    const artifacts = manifest.artifacts as Record<string, Artifact[] | string | null>;
    const cpu = artifacts.cpuProfiles as Artifact[];
    expect(cpu.length).toBeGreaterThan(0);
    expect(cpu[0]!.bytes).toBeGreaterThan(0);
    expect(cpu[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((artifacts.heapProfiles as Artifact[]).length).toBeGreaterThan(0);
    expect(artifacts.summary).toBe("summary.json");

    // What is absent, split by WHY. Two different facts, and conflating them
    // tells a reader the wrong thing about what is possible here.
    const notApplicable = manifest.notApplicable as { items: string[]; reason: string };
    const notImplemented = manifest.notImplemented as { items: string[]; reason: string };
    expect(notApplicable.items.length).toBeGreaterThan(0);
    expect(notApplicable.reason).toContain("no renderer");
    expect(notImplemented.items.length).toBeGreaterThan(0);
    expect(notImplemented.reason).toContain("not built yet");
    expect(String(manifest.scope)).toContain("mechanism-benchmark diagnostics");

    // The report a consumer may read instead of the manifest carries the
    // refusal too, at the very top.
    const report = fs.readFileSync(path.join(bundle, "results", "latest-smoke.report.md"), "utf-8");
    expect(report.startsWith("> **These durations are not comparable")).toBe(true);

    // The bundle is renamed into place, so a directory that exists is one
    // that finished. Nothing partial should be left beside it.
    expect(fs.readdirSync(outDir)).toEqual(bundles);
  });

  it("keeps a diagnostic run out of the trend structurally, not by a flag", () => {
    // `--no-history` is the belt. `--purpose diagnostic` is the braces, and it
    // leads: a future caller that forgets the flag still cannot put an inflated
    // duration into a trend record that has no column to explain it.
    expect(parseArgs(["--scenario", "PERF-036"]).purpose).toBe("benchmark");
    expect(parseArgs(["--scenario", "PERF-036", "--purpose", "diagnostic"]).purpose).toBe(
      "diagnostic"
    );
    expect(() => parseArgs(["--scenario", "PERF-036", "--purpose", "profiling"])).toThrow(
      /expects "benchmark" or "diagnostic"/
    );
  });

  it("parses --no-history and keeps a profiled run out of the trend", () => {
    // The flag `diagnose` relies on. `run.ts` writes history for any run that
    // did not override sampling, and a profiled duration in the trend looks
    // exactly like a regression with nothing to say it was instrumented.
    expect(parseArgs(["--scenario", "PERF-036"]).noHistory).toBe(false);
    expect(parseArgs(["--scenario", "PERF-036", "--no-history"]).noHistory).toBe(true);
    expect(() => parseArgs(["--scenario", "PERF-036", "--no-history=yes"])).toThrow(
      /takes no value/
    );
  });

  it(
    "leaves no bundle under the ordinary name when the run fails",
    { timeout: 120_000 },
    async () => {
      // A half-assembled bundle sitting under the normal name is the thing that
      // gets taken for a complete one a week later. A failure is renamed to
      // `-failed` instead, and nothing is left in a temp directory the caller
      // was never told about.
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-diagnose-fail-"));
      dirs.push(outDir);

      const { code } = await diagnose(["--scenario", "PERF-9999", "--out-dir", outDir]);
      expect(code).toBe(1);

      const entries = fs.readdirSync(outDir);
      expect(entries.filter((name) => /^PERF-9999-[\dTZ:.-]+$/.test(name))).toEqual([]);
    }
  );
});
