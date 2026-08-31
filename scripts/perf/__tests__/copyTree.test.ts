import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CopyTreeResult } from "../../../shared/types/ipc/copyTree";
import {
  addBundleGrade,
  bundleMisses,
  countBundleFileEntries,
  emptyBundleGrade,
  gradeBundle,
  gradeInMemory,
  symmetricDifferenceSize,
  tokensInBundle,
} from "../lib/copyTreeFixture";
import { classifyMetric } from "../lib/comparability";
import { allScenarios } from "../scenarios";

/**
 * These tests are the stub experiment written down.
 *
 * The scenarios themselves drive real `copytree` against real directories,
 * which Vitest cannot do here (Vite resolves the SDK's own dynamic imports),
 * so what is pinned instead is the part a stub experiment is meant to prove:
 * that each predicate goes non-zero for the specific way its operation can
 * break. The interesting case is the third one — a bundle with the right file
 * COUNT and no file BODIES, which is the "subject still doing most of its work"
 * defect a stub experiment cannot see.
 */

const PLANTED = 4;

function tokensFor(count: number): Set<string> {
  const tokens = new Set<string>();
  for (let index = 0; index < count; index += 1) tokens.add(`DTPERF-${index}-END`);
  return tokens;
}

function healthyBundle(count: number, withBodies: boolean): string {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>', "<ct:directory>", "<ct:files>"];
  for (let index = 0; index < count; index += 1) {
    const body = withBodies ? `<![CDATA[// DTPERF-${index}-END\n]]>` : "";
    parts.push(`<ct:file path="@pkg/mod${index}.ts" size="12">${body}</ct:file>`);
  }
  parts.push("</ct:files>", "</ct:directory>");
  return parts.join("\n");
}

let workDir = "";

function writeBundle(name: string, content: string): string {
  const path = join(workDir, name);
  writeFileSync(path, content);
  return path;
}

function resultFor(path: string, content: string, fileCount: number): CopyTreeResult {
  return {
    content: "",
    fileCount,
    filePath: path,
    outputBytes: Buffer.byteLength(content, "utf8"),
  };
}

describe("perf copytree fixture graders", () => {
  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "daintree-perf-copytree-test-"));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("counts file entries and per-file sentinel tokens out of a bundle", () => {
    const document = healthyBundle(PLANTED, true);
    expect(countBundleFileEntries(document)).toBe(PLANTED);
    expect(tokensInBundle(document).size).toBe(PLANTED);
  });

  it("scores a healthy bundle at zero on every term", () => {
    const document = healthyBundle(PLANTED, true);
    const path = writeBundle("healthy.xml", document);
    const grade = gradeBundle(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      resultFor(path, document, PLANTED),
      path
    );
    expect(bundleMisses(grade)).toEqual({
      generateErrorMisses: 0,
      bundleFileCountMisses: 0,
      reportedFileCountMisses: 0,
      sentinelContentMisses: 0,
      outputSizeMisses: 0,
      partialFileMisses: 0,
    });
  });

  it("scores an empty bundle on the count, sentinel and size terms at once", () => {
    const document = "";
    const path = writeBundle("empty.xml", document);
    // The subject still claims it wrote the full bundle — the oracle reads the
    // artifact, not the claim.
    const grade = gradeBundle(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      { content: "", fileCount: PLANTED, filePath: path, outputBytes: 4096 },
      path
    );
    expect(grade.bundleFileCountMisses).toBe(PLANTED);
    expect(grade.sentinelContentMisses).toBe(PLANTED);
    // Twice: the reported byte count disagrees with the file, and a planted
    // tree can never produce a zero-byte bundle.
    expect(grade.outputSizeMisses).toBe(2);
  });

  it("scores a self-consistently empty bundle on the size term as well", () => {
    // The trap the zero-byte rule closes: reporting zero bytes for a zero-byte
    // file passes an equality check, so emptiness has to be its own reading.
    const path = writeBundle("consistent-empty.xml", "");
    const grade = gradeBundle(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      { content: "", fileCount: 0, filePath: path, outputBytes: 0 },
      path
    );
    expect(grade.outputSizeMisses).toBe(1);
    expect(grade.bundleFileCountMisses).toBe(PLANTED);
    expect(grade.sentinelContentMisses).toBe(PLANTED);
  });

  it("catches a bundle with the right file count and no file bodies", () => {
    // The defect a stub experiment misses: the walk ran, the stat block is
    // right, and every file element is empty.
    const document = healthyBundle(PLANTED, false);
    const path = writeBundle("hollow.xml", document);
    const grade = gradeBundle(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      resultFor(path, document, PLANTED),
      path
    );
    expect(grade.bundleFileCountMisses).toBe(0);
    expect(grade.reportedFileCountMisses).toBe(0);
    expect(grade.outputSizeMisses).toBe(0);
    expect(grade.sentinelContentMisses).toBe(PLANTED);
  });

  it("catches a walk that stopped early in both directions", () => {
    const short = healthyBundle(PLANTED - 2, true);
    const shortPath = writeBundle("short.xml", short);
    const shortGrade = gradeBundle(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      resultFor(shortPath, short, PLANTED - 2),
      shortPath
    );
    expect(shortGrade.bundleFileCountMisses).toBe(2);
    expect(shortGrade.reportedFileCountMisses).toBe(2);
    expect(shortGrade.sentinelContentMisses).toBe(2);

    const long = healthyBundle(PLANTED + 1, true);
    const longPath = writeBundle("long.xml", long);
    const longGrade = gradeBundle(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      resultFor(longPath, long, PLANTED + 1),
      longPath
    );
    expect(longGrade.bundleFileCountMisses).toBe(1);
    expect(longGrade.sentinelContentMisses).toBe(1);
  });

  it("scores a byte count that disagrees with the file on disk", () => {
    const document = healthyBundle(PLANTED, true);
    const path = writeBundle("bytes.xml", document);
    const grade = gradeBundle(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      { ...resultFor(path, document, PLANTED), outputBytes: 1 },
      path
    );
    expect(grade.outputSizeMisses).toBe(1);
    expect(grade.bundleFileCountMisses).toBe(0);
  });

  it("scores an error result and a missing artifact on every term", () => {
    const grade = gradeBundle(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      { content: "", fileCount: 0, error: "Failed to generate context" },
      join(workDir, "never-written.xml")
    );
    expect(grade.generateErrorMisses).toBe(1);
    expect(grade.bundleFileCountMisses).toBe(PLANTED);
    expect(grade.sentinelContentMisses).toBe(PLANTED);
    expect(grade.outputSizeMisses).toBe(1);
  });

  it("grades the in-memory arm off the returned document", () => {
    const document = healthyBundle(PLANTED, true);
    const healthy = gradeInMemory(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      { content: document, fileCount: PLANTED }
    );
    expect(healthy.bundleFileCountMisses).toBe(0);
    expect(healthy.sentinelContentMisses).toBe(0);

    const hollow = gradeInMemory(
      { plantedFiles: PLANTED, sentinelTokens: tokensFor(PLANTED) },
      { content: "", fileCount: PLANTED }
    );
    expect(hollow.bundleFileCountMisses).toBe(PLANTED);
    expect(hollow.sentinelContentMisses).toBe(PLANTED);
  });

  it("sums grades across arms", () => {
    const total = emptyBundleGrade();
    addBundleGrade(total, { ...emptyBundleGrade(), sentinelContentMisses: 3 });
    addBundleGrade(total, { ...emptyBundleGrade(), sentinelContentMisses: 4 });
    expect(total.sentinelContentMisses).toBe(7);
  });

  it("computes symmetric difference in both directions", () => {
    expect(symmetricDifferenceSize(new Set(["a", "b"]), new Set(["a"]))).toBe(1);
    expect(symmetricDifferenceSize(new Set(["a"]), new Set(["a", "b"]))).toBe(1);
    expect(symmetricDifferenceSize(new Set(["a"]), new Set(["a"]))).toBe(0);
  });
});

describe("perf copytree scenarios", () => {
  const ids = ["PERF-390", "PERF-391", "PERF-392"];

  it("declares all three scenarios with count-class predicates", () => {
    for (const id of ids) {
      const scenario = allScenarios.find((candidate) => candidate.id === id);
      expect(scenario).toBeDefined();
      const correctness = scenario?.correctness ?? [];
      expect(correctness.length).toBeGreaterThan(0);
      for (const name of correctness) {
        expect(`${name}:${classifyMetric(name)}`).toBe(`${name}:count`);
      }
    }
  });

  it("grades every operation generate() performs, one accumulator each", () => {
    const scenario = allScenarios.find((candidate) => candidate.id === "PERF-390");
    expect([...(scenario?.correctness ?? [])].sort()).toEqual([
      "bundleFileCountMisses",
      "generateErrorMisses",
      "outputSizeMisses",
      "partialFileMisses",
      "reportedFileCountMisses",
      "sentinelContentMisses",
    ]);
  });
});
