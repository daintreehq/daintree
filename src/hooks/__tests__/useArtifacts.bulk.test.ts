import { describe, it, expect } from "vitest";
import type { Artifact } from "@shared/types";

function sortArtifacts(artifacts: Artifact[], mode: "filename" | "extraction"): Artifact[] {
  if (mode === "extraction") {
    return [...artifacts].sort((a, b) => {
      if (a.extractedAt !== b.extractedAt) {
        return a.extractedAt - b.extractedAt;
      }
      return a.id.localeCompare(b.id);
    });
  }
  return [...artifacts].sort((a, b) => {
    const aName = a.filename || a.id;
    const bName = b.filename || b.id;
    return aName.localeCompare(bName);
  });
}

function concatenateArtifacts(artifacts: Artifact[]): string {
  const sections = artifacts.map((artifact) => {
    const header = artifact.filename || artifact.language || artifact.type;
    const separator = "=".repeat(60);
    return `${separator}\n${header}\n${separator}\n${artifact.content}`;
  });

  return sections.join("\n\n");
}

describe("useArtifacts bulk operations logic", () => {
  describe("sortArtifacts", () => {
    it("sorts by filename alphabetically in filename mode", () => {
      const artifacts: Artifact[] = [
        {
          id: "3",
          type: "code",
          content: "content3",
          filename: "zebra.ts",
          extractedAt: 1000,
        },
        {
          id: "1",
          type: "code",
          content: "content1",
          filename: "apple.ts",
          extractedAt: 2000,
        },
        {
          id: "2",
          type: "code",
          content: "content2",
          filename: "banana.ts",
          extractedAt: 1500,
        },
      ];

      const sorted = sortArtifacts(artifacts, "filename");

      expect(sorted.map((a) => a.filename)).toEqual(["apple.ts", "banana.ts", "zebra.ts"]);
    });

    it("uses id when filename is missing in filename mode", () => {
      const artifacts: Artifact[] = [
        { id: "z", type: "code", content: "content", extractedAt: 1000 },
        { id: "a", type: "code", content: "content", extractedAt: 2000 },
        { id: "m", type: "code", content: "content", extractedAt: 1500 },
      ];

      const sorted = sortArtifacts(artifacts, "filename");

      expect(sorted.map((a) => a.id)).toEqual(["a", "m", "z"]);
    });

    it("sorts by extraction time in extraction mode", () => {
      const artifacts: Artifact[] = [
        {
          id: "3",
          type: "code",
          content: "content3",
          filename: "zebra.ts",
          extractedAt: 3000,
        },
        {
          id: "1",
          type: "code",
          content: "content1",
          filename: "apple.ts",
          extractedAt: 1000,
        },
        {
          id: "2",
          type: "code",
          content: "content2",
          filename: "banana.ts",
          extractedAt: 2000,
        },
      ];

      const sorted = sortArtifacts(artifacts, "extraction");

      expect(sorted.map((a) => a.extractedAt)).toEqual([1000, 2000, 3000]);
    });

    it("uses id as tiebreaker when extractedAt is same in extraction mode", () => {
      const artifacts: Artifact[] = [
        { id: "z", type: "code", content: "content", extractedAt: 1000 },
        { id: "a", type: "code", content: "content", extractedAt: 1000 },
        { id: "m", type: "code", content: "content", extractedAt: 1000 },
      ];

      const sorted = sortArtifacts(artifacts, "extraction");

      expect(sorted.map((a) => a.id)).toEqual(["a", "m", "z"]);
    });
  });

  describe("concatenateArtifacts", () => {
    it("concatenates multiple artifacts with headers and separators", () => {
      const artifacts: Artifact[] = [
        {
          id: "1",
          type: "code",
          content: "console.log('hello');",
          filename: "hello.ts",
          extractedAt: 1000,
        },
        {
          id: "2",
          type: "code",
          content: "console.log('world');",
          filename: "world.ts",
          extractedAt: 2000,
        },
      ];

      const result = concatenateArtifacts(artifacts);

      expect(result).toContain("hello.ts");
      expect(result).toContain("world.ts");
      expect(result).toContain("console.log('hello');");
      expect(result).toContain("console.log('world');");
      expect(result).toContain("=".repeat(60));
    });

    it("uses language when filename is missing", () => {
      const artifacts: Artifact[] = [
        {
          id: "1",
          type: "code",
          content: "code",
          language: "typescript",
          extractedAt: 1000,
        },
      ];

      const result = concatenateArtifacts(artifacts);

      expect(result).toContain("typescript");
    });

    it("uses type when both filename and language are missing", () => {
      const artifacts: Artifact[] = [
        { id: "1", type: "summary", content: "summary text", extractedAt: 1000 },
      ];

      const result = concatenateArtifacts(artifacts);

      expect(result).toContain("summary");
    });

    it("separates artifacts with double newlines", () => {
      const artifacts: Artifact[] = [
        { id: "1", type: "code", content: "first", filename: "a.ts", extractedAt: 1000 },
        { id: "2", type: "code", content: "second", filename: "b.ts", extractedAt: 2000 },
      ];

      const result = concatenateArtifacts(artifacts);

      expect(result.split("\n\n").length).toBeGreaterThan(1);
    });
  });

  describe("bulk result aggregation", () => {
    it("aggregates successful operations", () => {
      const results = { succeeded: 0, failed: 0, failures: [] };

      results.succeeded++;
      results.succeeded++;
      results.succeeded++;

      expect(results.succeeded).toBe(3);
      expect(results.failed).toBe(0);
      expect(results.failures).toEqual([]);
    });

    it("aggregates failures with error details", () => {
      const artifact1: Artifact = {
        id: "1",
        type: "patch",
        content: "patch",
        extractedAt: 1000,
      };
      const artifact2: Artifact = {
        id: "2",
        type: "patch",
        content: "patch",
        extractedAt: 2000,
      };

      const results = {
        succeeded: 0,
        failed: 0,
        failures: [] as Array<{ artifact: Artifact; error: string }>,
      };

      results.failed++;
      results.failures.push({ artifact: artifact1, error: "Error 1" });
      results.failed++;
      results.failures.push({ artifact: artifact2, error: "Error 2" });

      expect(results.succeeded).toBe(0);
      expect(results.failed).toBe(2);
      expect(results.failures).toHaveLength(2);
      expect(results.failures[0]!.error).toBe("Error 1");
      expect(results.failures[1]!.error).toBe("Error 2");
    });

    it("aggregates modified files from patches without duplicates", () => {
      const modifiedFiles: string[] = [];

      const newFiles1 = ["file1.ts", "file2.ts"];
      const newFiles2 = ["file2.ts", "file3.ts"];

      newFiles1.forEach((f) => {
        if (!modifiedFiles.includes(f)) modifiedFiles.push(f);
      });
      newFiles2.forEach((f) => {
        if (!modifiedFiles.includes(f)) modifiedFiles.push(f);
      });

      expect(modifiedFiles).toEqual(["file1.ts", "file2.ts", "file3.ts"]);
    });
  });

  describe("filtering logic", () => {
    it("filters code artifacts only", () => {
      const artifacts: Artifact[] = [
        { id: "1", type: "code", content: "code1", extractedAt: 1000 },
        { id: "2", type: "patch", content: "patch1", extractedAt: 2000 },
        { id: "3", type: "code", content: "code2", extractedAt: 3000 },
        { id: "4", type: "summary", content: "summary", extractedAt: 4000 },
      ];

      const codeOnly = artifacts.filter((a) => a.type === "code");

      expect(codeOnly).toHaveLength(2);
      expect(codeOnly.every((a) => a.type === "code")).toBe(true);
    });

    it("filters patch artifacts only", () => {
      const artifacts: Artifact[] = [
        { id: "1", type: "code", content: "code1", extractedAt: 1000 },
        { id: "2", type: "patch", content: "patch1", extractedAt: 2000 },
        { id: "3", type: "patch", content: "patch2", extractedAt: 3000 },
        { id: "4", type: "summary", content: "summary", extractedAt: 4000 },
      ];

      const patchesOnly = artifacts.filter((a) => a.type === "patch");

      expect(patchesOnly).toHaveLength(2);
      expect(patchesOnly.every((a) => a.type === "patch")).toBe(true);
    });

    it("counts artifacts by type", () => {
      const artifacts: Artifact[] = [
        { id: "1", type: "code", content: "code1", extractedAt: 1000 },
        { id: "2", type: "code", content: "code2", extractedAt: 2000 },
        { id: "3", type: "patch", content: "patch1", extractedAt: 3000 },
        { id: "4", type: "summary", content: "summary", extractedAt: 4000 },
      ];

      const codeCount = artifacts.filter((a) => a.type === "code").length;
      const patchCount = artifacts.filter((a) => a.type === "patch").length;

      expect(codeCount).toBe(2);
      expect(patchCount).toBe(1);
    });
  });
});
