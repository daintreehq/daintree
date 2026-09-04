/**
 * The structural check is only worth having if it actually rejects things, so
 * these drive the real script over temporary files rather than asserting on the
 * repo's current (passing) state.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/ci/check-design-contract.mjs");

const VALID_INDEX = '@import "tailwindcss";\n@import "./styles/design-contract.css";\n';

let sandbox;

/**
 * Run the checker against a throwaway repo whose layout mirrors the real one.
 * The script resolves paths from its own location, so it is copied in.
 */
function runCheck(contractCss, indexCss = VALID_INDEX) {
  writeFileSync(path.join(sandbox, "src/styles/design-contract.css"), contractCss);
  writeFileSync(path.join(sandbox, "src/index.css"), indexCss);
  try {
    execFileSync(process.execPath, [path.join(sandbox, "scripts/ci/check-design-contract.mjs")], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { ok: true, output: "" };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "design-contract-"));
  mkdirSync(path.join(sandbox, "src/styles"), { recursive: true });
  mkdirSync(path.join(sandbox, "scripts/ci"), { recursive: true });
  writeFileSync(
    path.join(sandbox, "scripts/ci/check-design-contract.mjs"),
    readFileSync(SCRIPT, "utf-8")
  );
});

afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

describe("check-design-contract", () => {
  it("accepts comments, @theme, @custom-variant and @utility", () => {
    const result = runCheck(`/* tokens */
@theme inline {
  --color-*: initial;
  --color-surface-panel: var(--theme-surface-panel);
}
@theme {
  --text-2xs: 0.6875rem;
}
@custom-variant reduce-motion {
  @media (prefers-reduced-motion: reduce) {
    @slot;
  }
}
@utility scrollbar-none {
  scrollbar-width: none;
}
`);

    expect(result.ok, result.output).toBe(true);
  });

  it("rejects a bare selector, which plugin views would never receive", () => {
    const result = runCheck(`@theme { --text-2xs: 0.6875rem; }
.panel-header {
  color: red;
}
`);

    expect(result.ok).toBe(false);
    expect(result.output).toContain(".panel-header");
  });

  it("rejects at-rules outside the vocabulary", () => {
    // Preflight, fonts and keyframes are host chrome; letting them in here
    // would mean the plugin compiler emitted them into every plugin root.
    const result = runCheck(`@theme { --text-2xs: 0.6875rem; }
@font-face {
  font-family: "X";
}
`);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("@font-face");
  });

  it("rejects a token declared twice", () => {
    // Tailwind keeps the last declaration with no warning from any build step,
    // so a partial extraction shows up as a colour regression, not an error.
    const result = runCheck(`@theme inline {
  --color-surface-panel: var(--theme-surface-panel);
  --color-surface-panel: var(--theme-surface-dialog);
}
`);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("--color-surface-panel");
    expect(result.output).toContain("already declared");
  });

  it("ignores duplicates that are only inside comments", () => {
    const result = runCheck(`@theme inline {
  /* --color-surface-panel: var(--theme-surface-dialog); */
  --color-surface-panel: var(--theme-surface-panel);
}
`);

    expect(result.ok, result.output).toBe(true);
  });

  it("fails when index.css stops importing the contract", () => {
    const result = runCheck(`@theme { --text-2xs: 0.6875rem; }\n`, '@import "tailwindcss";\n');

    expect(result.ok).toBe(false);
    expect(result.output).toContain("design-contract.css");
  });

  it("fails when a token or variant is left behind in index.css", () => {
    const result = runCheck(
      `@theme { --text-2xs: 0.6875rem; }\n`,
      `${VALID_INDEX}\n@theme {\n  --text-3xs: 0.625rem;\n}\n`
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("belongs in src/styles/design-contract.css");
  });

  it("passes against the repository's real contract file", () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, encoding: "utf-8", stdio: "pipe" })
    ).not.toThrow();
  });
});
