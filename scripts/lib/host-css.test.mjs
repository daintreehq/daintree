import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HOST_CSS_ENTRY, readHostStylesheet } from "./host-css.mjs";

let dir;
let entry;

function write(relative, css) {
  writeFileSync(path.join(dir, relative), css);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "host-css-"));
  mkdirSync(path.join(dir, "styles/host"), { recursive: true });
  entry = path.join(dir, "index.css");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readHostStylesheet", () => {
  it("expands host partials in place and in import order", () => {
    write("styles/host/a.css", ".a {\n  color: red;\n}\n\n");
    write("styles/host/b.css", ".b {\n  color: blue;\n}\n");
    write(
      "index.css",
      '@import "tailwindcss";\n.first {\n}\n@import "./styles/host/b.css";\n@import "./styles/host/a.css";\n.last {\n}\n'
    );

    const { css, files } = readHostStylesheet(entry);

    expect(css).toBe(
      '@import "tailwindcss";\n.first {\n}\n.b {\n  color: blue;\n}\n.a {\n  color: red;\n}\n.last {\n}\n'
    );
    expect(files.map((file) => path.relative(dir, file.path))).toEqual([
      "index.css",
      "styles/host/b.css",
      "styles/host/a.css",
    ]);
  });

  it("leaves other imports and commented-out host imports untouched", () => {
    write(
      "index.css",
      '@import "./styles/design-contract.css";\n@import "./styles/components/dock.css";\n/*\n@import "./styles/host/gone.css";\n*/\n'
    );

    const { css, files } = readHostStylesheet(entry);

    expect(css).toBe(
      '@import "./styles/design-contract.css";\n@import "./styles/components/dock.css";\n/*\n@import "./styles/host/gone.css";\n*/\n'
    );
    expect(files).toHaveLength(1);
  });

  it("reports every file it reads", () => {
    write("styles/host/a.css", ".a {\n}\n");
    write("index.css", '@import "./styles/host/a.css";\n');
    const seen = [];

    readHostStylesheet(entry, { onFile: (file) => seen.push(path.relative(dir, file)) });

    expect(seen).toEqual(["index.css", "styles/host/a.css"]);
  });

  it("throws when a referenced partial is missing", () => {
    write("index.css", '@import "./styles/host/missing.css";\n');

    expect(() => readHostStylesheet(entry)).toThrow(
      "styles/host/missing.css, which does not exist"
    );
  });

  it("throws when a partial imports another", () => {
    write("styles/host/a.css", '@import "./b.css";\n');
    write("index.css", '@import "./styles/host/a.css";\n');

    expect(() => readHostStylesheet(entry)).toThrow("host partials must not nest");
  });

  it("throws on a host import it would not expand", () => {
    write("styles/host/a.css", ".a {\n}\n");
    write("index.css", "@import url(./styles/host/a.css);\n");

    expect(() => readHostStylesheet(entry)).toThrow("in a form other than");
  });

  it("expands the real entry fully", () => {
    const { css, files } = readHostStylesheet(HOST_CSS_ENTRY);

    expect(files.length).toBeGreaterThan(1);
    expect(css).not.toMatch(/@import "\.\/styles\/host\//);
    expect(css).toMatch(/^:root \{/m);
    expect(css).toMatch(/^@media \(forced-colors: active\) \{/m);
    expect(css).toMatch(/^@media \(prefers-contrast: more\) \{/m);
  });
});
