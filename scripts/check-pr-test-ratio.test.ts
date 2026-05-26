import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-pr-test-ratio.mjs"
);

function run(stdin: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("node", [SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("check-pr-test-ratio CLI", () => {
  it("emits a notice for a fix PR with no test files and exits 0", async () => {
    const { code, stdout } = await run("src/foo.ts\n", { PR_TITLE: "fix: repair crash" });
    expect(code).toBe(0);
    expect(stdout).toContain("::notice title=Test coverage reminder::");
  });

  it("stays quiet for a fix PR that touches tests", async () => {
    const { code, stdout } = await run("src/foo.test.ts\n", { PR_TITLE: "fix: repair crash" });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("stays quiet for a non-fix PR", async () => {
    const { code, stdout } = await run("src/foo.ts\n", { PR_TITLE: "feat: add feature" });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("treats an unset PR_TITLE as a non-fix PR and exits 0", async () => {
    const { code, stdout } = await run("src/foo.ts\n", { PR_TITLE: "" });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("handles CRLF and blank lines, emitting exactly one notice", async () => {
    const { code, stdout } = await run("src/foo.ts\r\n\n \nsrc/bar.ts\r\n", {
      PR_TITLE: "fix: repair crash",
    });
    expect(code).toBe(0);
    expect(stdout.match(/::notice/g)).toHaveLength(1);
  });
});
