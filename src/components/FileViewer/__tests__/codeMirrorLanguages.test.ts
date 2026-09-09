import { describe, it, expect, vi } from "vitest";
import { LanguageDescription } from "@codemirror/language";
import { CODEMIRROR_LANGUAGES, loadMarkdownSupport } from "../codeMirrorLanguages";

// Wraps the real `markdown()` so the configuration it receives is observable
// while the parse-tree assertions below still exercise the real grammar.
const { markdownSpy } = vi.hoisted(() => ({
  markdownSpy: vi.fn<(config?: Record<string, unknown>) => unknown>(),
}));
vi.mock("@codemirror/lang-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/lang-markdown")>();
  markdownSpy.mockImplementation((config) => actual.markdown(config));
  return { ...actual, markdown: markdownSpy };
});

describe("loadMarkdownSupport — the one Markdown configuration (#12323)", () => {
  const nodeNames = (tree: { cursor(): { name: string; next(): boolean } }): string[] => {
    const names: string[] = [];
    const cursor = tree.cursor();
    do names.push(cursor.name);
    while (cursor.next());
    return names;
  };

  it("parses GFM, not just CommonMark", async () => {
    const support = await loadMarkdownSupport();
    const tree = support.language.parser.parse(
      "~~gone~~\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] todo\n"
    );
    const names = nodeNames(tree);
    expect(names).toContain("Strikethrough");
    expect(names).toContain("Table");
    expect(names).toContain("Task");
  });

  it("the Markdown registry entry loads the same configuration", async () => {
    const desc = CODEMIRROR_LANGUAGES.find((d) => d.name === "Markdown");
    const support = await desc!.load();
    const names = nodeNames(support.language.parser.parse("~~x~~"));
    expect(names).toContain("Strikethrough");
  });

  it("hands fences the viewer registry and turns off the two rewriting options", async () => {
    await loadMarkdownSupport();
    expect(markdownSpy).toHaveBeenCalled();
    const config = markdownSpy.mock.calls.at(-1)?.[0];
    expect(config?.codeLanguages).toBe(CODEMIRROR_LANGUAGES);
    expect(config?.completeHTMLTags).toBe(false);
    expect(config?.pasteURLAsLink).toBe(false);
  });
});

describe("CODEMIRROR_LANGUAGES — curated registry shape", () => {
  it("is a non-empty array of LanguageDescription instances", () => {
    expect(Array.isArray(CODEMIRROR_LANGUAGES)).toBe(true);
    expect(CODEMIRROR_LANGUAGES.length).toBeGreaterThan(0);
    for (const desc of CODEMIRROR_LANGUAGES) {
      expect(desc).toBeInstanceOf(LanguageDescription);
    }
  });

  it("has no duplicate names", () => {
    const names = CODEMIRROR_LANGUAGES.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every entry has at least one extension or filename matcher", () => {
    for (const desc of CODEMIRROR_LANGUAGES) {
      const hasExt = Array.isArray(desc.extensions) && desc.extensions.length > 0;
      const hasFilename = desc.filename instanceof RegExp;
      expect(hasExt || hasFilename).toBe(true);
    }
  });

  it("every entry has a callable load function", () => {
    for (const desc of CODEMIRROR_LANGUAGES) {
      expect(typeof desc.load).toBe("function");
    }
  });
});

describe("CODEMIRROR_LANGUAGES — matchFilename coverage for common file types", () => {
  const cases: Array<[string, string]> = [
    ["foo.ts", "TypeScript"],
    ["foo.tsx", "TSX"],
    ["foo.jsx", "JSX"],
    ["foo.js", "JavaScript"],
    ["foo.mjs", "JavaScript"],
    ["foo.cjs", "JavaScript"],
    ["foo.json", "JSON"],
    ["foo.py", "Python"],
    ["foo.rs", "Rust"],
    ["foo.go", "Go"],
    ["foo.html", "HTML"],
    ["foo.css", "CSS"],
    ["foo.scss", "SCSS"],
    ["foo.sass", "Sass"],
    ["foo.less", "LESS"],
    ["foo.xml", "XML"],
    ["foo.svg", "XML"],
    ["foo.yaml", "YAML"],
    ["foo.yml", "YAML"],
    ["foo.md", "Markdown"],
    ["foo.sh", "Shell"],
    ["foo.bash", "Shell"],
    ["foo.rb", "Ruby"],
    ["Gemfile", "Ruby"],
    ["Rakefile", "Ruby"],
    ["foo.lua", "Lua"],
    ["Dockerfile", "Dockerfile"],
    ["foo.sql", "SQL"],
    ["foo.cs", "C#"],
    ["foo.kt", "Kotlin"],
    ["foo.dart", "Dart"],
    ["foo.scala", "Scala"],
    ["foo.swift", "Swift"],
    ["foo.toml", "TOML"],
    ["foo.proto", "ProtoBuf"],
    ["foo.pl", "Perl"],
    ["foo.cpp", "C++"],
    ["foo.c", "C"],
    ["foo.php", "PHP"],
    ["foo.java", "Java"],
    ["foo.vue", "Vue"],
    ["CMakeLists.txt", "CMake"],
    ["foo.r", "R"],
  ];

  it.each(cases)("matches %s to %s", (filename, expectedName) => {
    const desc = LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, filename);
    expect(desc).not.toBeNull();
    expect(desc?.name).toBe(expectedName);
  });

  it.each([["foo.unknown"], ["foo"], [""]])("returns null for %s", (filename) => {
    const desc = LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, filename);
    expect(desc).toBeNull();
  });

  it("resolves .m to Mathematica (upstream order: Mathematica → Objective-C → Octave)", () => {
    // matchFilename is first-match-wins. Three entries claim `.m` (Mathematica,
    // Objective-C, Octave). Preserving upstream order keeps behavior parity.
    const desc = LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, "foo.m");
    expect(desc?.name).toBe("Mathematica");
  });

  it("resolves .v to SystemVerilog (declared before Verilog)", () => {
    const desc = LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, "foo.v");
    expect(desc?.name).toBe("SystemVerilog");
  });

  it("resolves .sig to PGP (declared before SML)", () => {
    const desc = LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, "foo.sig");
    expect(desc?.name).toBe("PGP");
  });
});

describe("CODEMIRROR_LANGUAGES — filename regex boundaries", () => {
  it.each([
    ["Dockerfile", "Dockerfile"],
    ["Gemfile", "Ruby"],
    ["Rakefile", "Ruby"],
    ["Jenkinsfile", "Groovy"],
    ["BUCK", "Python"],
    ["BUILD", "Python"],
    ["PKGBUILD", "Shell"],
    ["CMakeLists.txt", "CMake"],
    ["extensions.conf", "Asterisk"],
    ["my-nginx.conf", "Nginx"],
  ])("filename %s matches %s", (filename, expectedName) => {
    const desc = LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, filename);
    expect(desc?.name).toBe(expectedName);
  });

  it.each([["Dockerfile.dev"], ["myGemfile"], ["myJenkinsfile"]])(
    "filename %s does NOT match a regex-only entry",
    (filename) => {
      // Anchors (`^...$`) prevent partial matches; these names should fall through to null.
      const desc = LanguageDescription.matchFilename(CODEMIRROR_LANGUAGES, filename);
      expect(desc).toBeNull();
    }
  );
});

describe("CODEMIRROR_LANGUAGES — load() round-trip for representative entries", () => {
  // Guards against typos in legacy-modes export names (`m.csharp` vs `m.cSharp`)
  // or dialect identifiers in lang-sql that `typeof load === "function"` can't catch.
  // Targeted subset; full coverage would require loading every parser at test time.
  const samples = ["TypeScript", "SQL", "CQL", "PLSQL", "C#", "TOML", "Shell", "Vue"];

  it.each(samples)("%s loads without rejection", async (name) => {
    const desc = CODEMIRROR_LANGUAGES.find((d) => d.name === name);
    expect(desc).toBeDefined();
    const support = await desc!.load();
    expect(support).toBeDefined();
  });
});
