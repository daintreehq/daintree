import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStaticImports, staticSpecifiers, walkEagerGraph } from "./static-import-graph.mjs";

/**
 * The failure this pins is silent by construction: a `.ts` file parsed as TSX
 * dies on the first generic arrow, recovery eats the rest of the statement
 * list, and the walk reports zero edges and zero problems.
 */

describe("script kind follows the file extension", () => {
  it("keeps the imports after a generic arrow in a .ts source", () => {
    const source = [
      'import a from "top";',
      "const identity = <T>(value: T): T => value;",
      'import b from "after";',
      'import "zod";',
    ].join("\n");

    expect(parseStaticImports(source, "helper.ts").parseErrors).toEqual([]);
    expect(staticSpecifiers(source, "helper.ts")).toEqual(["top", "after", "zod"]);
  });

  it("keeps the imports after an angle-bracket assertion in a .mts source", () => {
    const source = 'import a from "top";\nconst name = <string>a;\nimport "zod";';

    expect(parseStaticImports(source, "helper.mts").parseErrors).toEqual([]);
    expect(staticSpecifiers(source, "helper.mts")).toEqual(["top", "zod"]);
  });

  it("still reads JSX in a .tsx source", () => {
    const source = 'import a from "top";\nconst node = <div className="x" />;\nimport "zod";';

    expect(parseStaticImports(source, "component.tsx").parseErrors).toEqual([]);
    expect(staticSpecifiers(source, "component.tsx")).toEqual(["top", "zod"]);
  });
});

describe("a source that will not parse fails loudly", () => {
  const broken = 'import a from "top";\nconst x = (((;\n';

  it("reports the syntax errors instead of a short edge list", () => {
    const { parseErrors } = parseStaticImports(broken, "broken.ts");

    expect(parseErrors.length).toBeGreaterThan(0);
  });

  it("throws from staticSpecifiers rather than returning what survived", () => {
    expect(() => staticSpecifiers(broken, "broken.ts")).toThrow(/failed to parse/);
  });
});

describe("walkEagerGraph over real files", () => {
  const root = mkdtempSync(join(tmpdir(), "static-import-graph-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("follows the imports a generic arrow used to hide", () => {
    const dir = mkdtempSync(join(root, "arrow-"));
    writeFileSync(
      join(dir, "entry.ts"),
      'const identity = <T>(value: T): T => value;\nexport const used = identity(1);\nimport "./reached.ts";\n'
    );
    writeFileSync(join(dir, "reached.ts"), 'import "zod";\n');

    const { files, unresolved, bare } = walkEagerGraph(join(dir, "entry.ts"), dir);

    expect(unresolved).toEqual([]);
    expect(files).toContain(join(dir, "reached.ts"));
    expect(bare.get(join(dir, "reached.ts"))).toEqual(["zod"]);
  });

  it("surfaces an unparseable file in unresolved", () => {
    const dir = mkdtempSync(join(root, "broken-"));
    writeFileSync(join(dir, "entry.ts"), 'import "./broken.ts";\n');
    writeFileSync(join(dir, "broken.ts"), "const x = (((;\n");

    const { unresolved } = walkEagerGraph(join(dir, "entry.ts"), dir);

    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.join("\n")).toContain("broken.ts failed to parse");
  });
});
