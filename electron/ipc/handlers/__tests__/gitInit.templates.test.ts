import { describe, it, expect } from "vitest";
import { computeMissingTemplateEntries } from "../projectCrud/gitInit.js";
import { getGitignoreTemplate } from "../projectCrud/gitignoreTemplates.js";
import {
  GITIGNORE_TEMPLATE_OPTIONS,
  DEFAULT_GITIGNORE_TEMPLATE_ID,
  isGitignoreTemplateId,
} from "../../../../shared/config/gitignoreTemplates.js";

const TEMPLATE_IDS = GITIGNORE_TEMPLATE_OPTIONS.map((option) => option.value);
const LANGUAGE_IDS = TEMPLATE_IDS.filter((id) => id !== "minimal" && id !== "none");

function activeLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function resolve(id: string): string {
  const content = getGitignoreTemplate(id);
  if (content === null) throw new Error(`Expected template "${id}" to resolve`);
  return content;
}

describe("gitignore template registry", () => {
  it("exposes unique ids", () => {
    expect(new Set(TEMPLATE_IDS).size).toBe(TEMPLATE_IDS.length);
  });

  it("defaults to the first listed option", () => {
    expect(DEFAULT_GITIGNORE_TEMPLATE_ID).toBe(TEMPLATE_IDS[0]);
  });

  it("resolves content for every id except the opt-out one", () => {
    for (const id of TEMPLATE_IDS) {
      const content = getGitignoreTemplate(id);
      if (id === "none") {
        expect(content, `${id} should not produce a file`).toBeNull();
      } else {
        expect(content, `${id} should produce a file`).not.toBeNull();
      }
    }
  });

  it("recognises exactly the registered ids", () => {
    for (const id of TEMPLATE_IDS) {
      expect(isGitignoreTemplateId(id)).toBe(true);
    }
    expect(isGitignoreTemplateId("unknown")).toBe(false);
    expect(isGitignoreTemplateId(undefined)).toBe(false);
  });

  it("returns null for unknown templates", () => {
    expect(getGitignoreTemplate("unknown")).toBeNull();
  });
});

describe("gitignore template composition", () => {
  it("layers every language template on top of the full minimal baseline", () => {
    const minimal = resolve("minimal");
    for (const id of LANGUAGE_IDS) {
      const content = resolve(id);
      expect(content.startsWith(`${minimal}\n`), `${id} should open with minimal`).toBe(true);
    }
  });

  it("adds language-specific rules beyond the baseline", () => {
    const minimalLineCount = activeLines(resolve("minimal")).length;
    for (const id of LANGUAGE_IDS) {
      expect(activeLines(resolve(id)).length, `${id} should add rules`).toBeGreaterThan(
        minimalLineCount
      );
    }
  });

  it("gives each language template distinct content", () => {
    const rendered = LANGUAGE_IDS.map((id) => resolve(id));
    expect(new Set(rendered).size).toBe(LANGUAGE_IDS.length);
  });

  it("ends every template with a single trailing newline", () => {
    for (const id of TEMPLATE_IDS.filter((candidate) => candidate !== "none")) {
      const content = resolve(id);
      expect(content.endsWith("\n"), `${id} should end with a newline`).toBe(true);
      expect(content.endsWith("\n\n"), `${id} should not end with a blank line`).toBe(false);
    }
  });
});

describe("gitignore pattern semantics", () => {
  // `*.key` also matches Apple Keynote documents, so a broad rule silently
  // swallows real files. Scoped rules like `/storage/*.key` are still fine.
  it("never ignores every .key file", () => {
    for (const id of TEMPLATE_IDS.filter((candidate) => candidate !== "none")) {
      expect(activeLines(resolve(id)), `${id} should not blanket-ignore .key`).not.toContain(
        "*.key"
      );
    }
  });

  // Git refuses to descend into an excluded directory, so a negation is dead if
  // one of its parent directories is excluded outright. `dir/*` keeps the
  // directory traversable; `dir/` or `dir` does not.
  it("keeps every negation reachable", () => {
    for (const id of TEMPLATE_IDS.filter((candidate) => candidate !== "none")) {
      const lines = activeLines(resolve(id));

      lines.forEach((line, index) => {
        if (!line.startsWith("!")) return;

        const segments = line.slice(1).replace(/\/$/, "").split("/");
        const earlier = lines.slice(0, index);

        for (let depth = 1; depth < segments.length; depth++) {
          const parent = segments.slice(0, depth).join("/");
          const blocked = earlier.filter((prior) => prior === parent || prior === `${parent}/`);
          expect(blocked, `${id}: "${line}" is unreachable — "${parent}" is excluded`).toEqual([]);
        }
      });
    }
  });
});

describe("computeMissingTemplateEntries", () => {
  it("returns all template entries when existing file is empty", () => {
    const template = "# comment\n.env\nnode_modules/\n";
    const missing = computeMissingTemplateEntries("", template);
    expect(missing).toEqual([".env", "node_modules/"]);
  });

  it("returns an empty list when the existing file covers every entry", () => {
    const template = "# OS\n.DS_Store\n.env\n";
    const existing = "# my notes\n.env\nfoo/\n.DS_Store\n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([]);
  });

  it("ignores comments and blank lines on both sides", () => {
    const template = "# header\n\n.env\n\n.DS_Store\n";
    const existing = "\n\n# other\n.env\n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([".DS_Store"]);
  });

  it("normalizes CRLF line endings", () => {
    const template = ".env\r\n.DS_Store\r\n";
    const existing = ".env\r\n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([".DS_Store"]);
  });

  it("trims whitespace before comparing", () => {
    const template = ".env\n.DS_Store\n";
    const existing = "  .env  \n .DS_Store \n";
    expect(computeMissingTemplateEntries(existing, template)).toEqual([]);
  });
});
