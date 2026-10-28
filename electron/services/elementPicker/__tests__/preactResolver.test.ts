import { transformWithOxc } from "vite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import { FIXTURE_SOURCE } from "../guest/__tests__/preactFixture.js";
import {
  at,
  component,
  createSandbox,
  creation,
  invocation,
  positionOf,
  ref,
  resolveIn,
  resolveOne,
  revisionOf,
  selection,
  type Sandbox,
} from "./preactTestContext.js";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

/** What Vite 8 serves a Preact module as in dev: Oxc's JSX transform, as `@preact/preset-vite` configures it. */
async function devTransform(source: string, file: string): Promise<string> {
  const result = await transformWithOxc(source, file, {
    jsx: { runtime: "automatic", importSource: "preact", development: true },
  });
  return result.code;
}

interface Recorded {
  line: number;
  column: number;
  /** The tag the source has at that position, read off the text itself. */
  tag: string;
}

/** Every jsx-source position the transform wrote, with the tag found there in the source. */
function recordedPositions(code: string, source: string): Recorded[] {
  const lines = source.split(/\r\n?|[\n\u2028\u2029]/);
  return [...code.matchAll(/lineNumber: (\d+),\s*columnNumber: (\d+)/g)].map((match) => {
    const line = Number(match[1]);
    const column = Number(match[2]);
    const text = lines[line - 1]!.slice(column - 1);
    expect(text.startsWith("<")).toBe(true);
    return { line, column, tag: /^<([\w$.:-]*)/.exec(text)![1]! };
  });
}

/** A recorded position as the extractor reports it: an element's own, or a record's call site. */
function observationFor(file: string, recorded: Recorded): SelectionObservation {
  const location = {
    lineBase: 1 as const,
    columnBase: 1 as const,
    columnUnit: "utf16" as const,
    line: recorded.line,
    column: recorded.column,
  };
  return /^[a-z]/.test(recorded.tag)
    ? selection({ tagName: recorded.tag, sourceCandidates: [creation(file, location)] })
    : selection({ components: [component([invocation(file, location)])] });
}

describe("the Preact resolver", () => {
  it("verifies every position Vite's dev transform records for a Preact app, at the element's range", async () => {
    await sandbox.write("src/App.tsx", FIXTURE_SOURCE);
    const file = sandbox.file("src/App.tsx");
    // Fragments carry a source too, but no fragment is ever a claim.
    const recorded = recordedPositions(
      await devTransform(FIXTURE_SOURCE, file),
      FIXTURE_SOURCE
    ).filter((entry) => entry.tag !== "");
    expect(recorded.length).toBeGreaterThan(20);
    expect(recorded.some((entry) => /^[a-z]/.test(entry.tag))).toBe(true);
    expect(recorded.some((entry) => /^[A-Z]/.test(entry.tag))).toBe(true);

    const { results, reads } = await resolveIn(
      sandbox,
      recorded.map((entry) => observationFor(file, entry))
    );
    expect(results.map((result) => result.state)).toEqual(recorded.map(() => "verified"));
    results.forEach((result, index) => {
      if (result.state !== "verified") return;
      expect(result.target.file).toEqual(ref("src/App.tsx"));
      expect(result.fileRevision).toBe(revisionOf(FIXTURE_SOURCE));
      expect(result.target.location).toMatchObject({
        line: recorded[index]!.line,
        column: recorded[index]!.column,
      });
    });
    // One read for every claim in the file.
    expect(reads).toEqual([ref("src/App.tsx").path]);
  });

  it("names the element from its `<` to the end of its closing tag", async () => {
    await sandbox.write("src/App.tsx", FIXTURE_SOURCE);
    const start = FIXTURE_SOURCE.indexOf('<Card title="Fixture">');
    const end = FIXTURE_SOURCE.indexOf("</Card>", start) + "</Card>".length;
    const result = await resolveOne(
      sandbox,
      selection({
        components: [
          component([
            invocation(sandbox.file("src/App.tsx"), at(FIXTURE_SOURCE, '<Card title="Fixture">')),
          ]),
        ],
      })
    );
    expect(result).toMatchObject({
      state: "verified",
      claim: "component-invocation",
      target: {
        location: {
          lineBase: 1,
          columnBase: 1,
          ...positionOf(FIXTURE_SOURCE, start),
          end: positionOf(FIXTURE_SOURCE, end),
        },
      },
    });
  });

  it("counts columns in UTF-16 units and lines by every terminator, as the transform does", async () => {
    const source =
      "/** @jsxImportSource preact */\r\n" +
      'export const Mood = () => <p title="x">{"😀 é"}<b>bold</b></p>;\r\n' +
      "export const Lone = () => <span>\r<em>after a lone CR</em></span>;\n" +
      'const separated = "a\u2028b";\n' +
      "export const Kept = () => <i>{separated}<u>after U+2028</u></i>;\n";
    await sandbox.write("src/Mood.tsx", source);
    const file = sandbox.file("src/Mood.tsx");
    const recorded = recordedPositions(await devTransform(source, file), source);
    // The transform writes a child's source before its parent's, so order says nothing.
    expect(recorded.map((entry) => entry.tag).sort()).toEqual(["b", "em", "i", "p", "span", "u"]);
    const { results } = await resolveIn(
      sandbox,
      recorded.map((entry) => observationFor(file, entry))
    );
    expect(results.map((result) => result.state)).toEqual(recorded.map(() => "verified"));
  });

  it("holds an invocation by its component tag, however the file spells the component", async () => {
    const source = [
      'import * as ui from "./ui";',
      "import { Button as Action } from './Button';",
      "export const Bar = () => (",
      "  <ui.Toolbar>",
      '    <Action label="go" />',
      "  </ui.Toolbar>",
      ");",
      "",
    ].join("\n");
    await sandbox.write("src/Bar.jsx", source);
    const file = sandbox.file("src/Bar.jsx");
    const { results } = await resolveIn(sandbox, [
      selection({
        components: [
          component([invocation(file, at(source, "<Action"))]),
          component([invocation(file, at(source, "<ui.Toolbar>"))]),
        ],
      }),
    ]);
    expect(results.map((result) => result.state)).toEqual(["verified", "verified"]);
  });

  it("reads an intrinsic tag as the document names the element: HTML lowercased, SVG as written", async () => {
    const source =
      'export const Frame = () => <div><iFrame src="/x" /><svg><linearGradient id="g" /><lineargradient id="h" /></svg></div>;\n';
    await sandbox.write("src/Frame.jsx", source);
    const file = sandbox.file("src/Frame.jsx");
    const results = await Promise.all(
      [
        ["iframe", "<iFrame"],
        ["linearGradient", "<linearGradient"],
        // A name the document kept mixed-case is one only that spelling makes.
        ["linearGradient", "<lineargradient"],
      ].map(([tagName, marker]) =>
        resolveOne(
          sandbox,
          selection({ tagName, sourceCandidates: [creation(file, at(source, marker!))] })
        )
      )
    );
    expect(results.map((result) => result.state)).toEqual(["verified", "verified", "unavailable"]);
  });

  it("refuses a claim the file contradicts, naming what it read", async () => {
    const source = [
      "/** @jsxImportSource preact */",
      '// <Card title="in a comment">',
      'const text = "<Card in a string>";',
      "export const View = () => (",
      '  <section class="view">',
      "    <Card title={text} />",
      "  </section>",
      ");",
      "",
    ].join("\n");
    await sandbox.write("src/View.tsx", source);
    const file = sandbox.file("src/View.tsx");
    const claims: SelectionObservation[] = [
      // A component tag where the page says an element was made, and the reverse.
      selection({
        tagName: "card",
        sourceCandidates: [creation(file, at(source, "<Card title={text}"))],
      }),
      selection({ components: [component([invocation(file, at(source, "<section"))])] }),
      // The right kind of tag, but not this element's.
      selection({ tagName: "span", sourceCandidates: [creation(file, at(source, "<section"))] }),
      // `<Card` text that is no element at all.
      selection({ components: [component([invocation(file, at(source, '<Card title="in'))])] }),
      selection({ components: [component([invocation(file, at(source, "<Card in a string"))])] }),
      // One column off the `<`, and past the end of the line and of the file.
      selection({
        components: [
          component([
            invocation(file, {
              ...at(source, "<Card title={text}"),
              column: at(source, "<Card title={text}").column + 1,
            }),
          ]),
        ],
      }),
      selection({
        tagName: "section",
        sourceCandidates: [creation(file, { ...at(source, "<section"), column: 400 })],
      }),
      selection({
        tagName: "section",
        sourceCandidates: [creation(file, { ...at(source, "<section"), line: 400 })],
      }),
    ];
    const { results } = await resolveIn(sandbox, claims);
    for (const result of results) {
      expect(result).toEqual({
        state: "unavailable",
        candidateId: result.candidateId,
        claim: result.claim,
        reason: "mismatch",
        read: { file: ref("src/View.tsx"), fileRevision: revisionOf(source) },
      });
    }
  });

  it("will not vouch for an element that is not well-formed JSX, whatever the parse made of it", async () => {
    const recovered = 'export const Recovered = () => <div class="x">{oops(</div>;\n';
    // The grammar takes these names independently, so each parses without an error node.
    const mismatched = [
      'export const Mismatched = () => <div class="y"><b>x</b></span>;',
      'export const Nested = () => <section class="z"><p>x</div></section>;',
      'export const Fine = () => <section class="w"><p>x</p></section>;',
      // Comments between a tag's parts are no part of its name, either way round.
      'export const Commented = () => <section class="c"><UI /* c */ . Card></UI.Card></section>;',
      'export const Hidden = () => <div class="h">< /*a*/ b></ /*b*/ i></div>;',
      "",
    ].join("\n");
    await sandbox.write("src/Recovered.jsx", recovered);
    await sandbox.write("src/Mismatched.jsx", mismatched);
    const file = sandbox.file("src/Mismatched.jsx");
    const { results } = await resolveIn(sandbox, [
      selection({
        tagName: "div",
        sourceCandidates: [creation(sandbox.file("src/Recovered.jsx"), at(recovered, "<div"))],
      }),
      selection({ tagName: "div", sourceCandidates: [creation(file, at(mismatched, "<div"))] }),
      selection({
        tagName: "section",
        sourceCandidates: [creation(file, at(mismatched, '<section class="z"'))],
      }),
      selection({
        tagName: "section",
        sourceCandidates: [creation(file, at(mismatched, '<section class="w"'))],
      }),
      selection({
        tagName: "section",
        sourceCandidates: [creation(file, at(mismatched, '<section class="c"'))],
      }),
      selection({
        tagName: "div",
        sourceCandidates: [creation(file, at(mismatched, '<div class="h"'))],
      }),
    ]);
    expect(
      results.map((result) => (result.state === "unavailable" ? result.reason : result.state))
    ).toEqual(["unsupported", "unsupported", "unsupported", "verified", "verified", "unsupported"]);
    expect(results[0]).toMatchObject({ read: { file: ref("src/Recovered.jsx") } });
  });

  it("reports a file that changed or went away since an earlier result as stale, never resolving it anew", async () => {
    await sandbox.write("src/App.tsx", FIXTURE_SOURCE);
    const file = sandbox.file("src/App.tsx");
    const claim = () =>
      selection({
        tagName: "section",
        sourceCandidates: [creation(file, at(FIXTURE_SOURCE, '<section class="card">'))],
      });
    const earlier = revisionOf("// an older App.tsx\n");

    const changed = await resolveOne(sandbox, claim(), {
      knownRevisions: [{ file: ref("src/App.tsx"), revision: earlier }],
    });
    expect(changed).toMatchObject({
      state: "stale",
      reason: "file-changed",
      held: { state: "observed", target: { file: ref("src/App.tsx") }, fileRevision: earlier },
      currentFileRevision: revisionOf(FIXTURE_SOURCE),
    });

    await sandbox.remove("src/App.tsx");
    const gone = await resolveOne(sandbox, claim(), {
      knownRevisions: [{ file: ref("src/App.tsx"), revision: earlier }],
    });
    expect(gone).toMatchObject({
      state: "stale",
      reason: "file-missing",
      currentFileRevision: null,
    });
  });

  it("answers what it cannot check without guessing, and maps nothing", async () => {
    await sandbox.write("src/App.tsx", FIXTURE_SOURCE);
    await sandbox.write("src/Card.vue", "<template><div /></template>\n");
    await sandbox.write("src/Bytes.tsx", new Uint8Array([0x3c, 0x64, 0xff, 0xfe]));
    const file = sandbox.file("src/App.tsx");
    const location = at(FIXTURE_SOURCE, '<section class="card">');
    const { results, maps } = await resolveIn(sandbox, [
      // A generated frame is a claim about served code, which Preact never makes.
      selection({
        tagName: "section",
        sourceCandidates: [
          creation(file, location, {
            kind: "generated-stack-frame",
            field: "_debugStack",
            frameIndex: 1,
          }),
        ],
      }),
      selection({
        tagName: "div",
        sourceCandidates: [
          creation(sandbox.file("src/Card.vue"), { ...location, line: 1, column: 11 }),
        ],
      }),
      selection({
        tagName: "d",
        sourceCandidates: [
          creation(sandbox.file("src/Bytes.tsx"), { ...location, line: 1, column: 1 }),
        ],
      }),
      selection({
        tagName: "p",
        sourceCandidates: [
          creation(sandbox.file("../../../Outside.tsx"), { ...location, line: 1, column: 30 }),
        ],
      }),
      selection({
        tagName: "p",
        sourceCandidates: [creation(sandbox.file("src/Missing.tsx"), location)],
      }),
    ]);
    expect(
      results.map((result) => (result.state === "unavailable" ? result.reason : result.state))
    ).toEqual(["unsupported", "unsupported", "unsupported", "outside-workspace", "file-missing"]);
    // Undecodable bytes were read, and say so.
    expect(results[2]).toMatchObject({ read: { file: ref("src/Bytes.tsx") } });
    expect(maps).toEqual([]);
  });

  it("stops at a withdrawal, answering what it had not begun as cancelled", async () => {
    await sandbox.write("src/App.tsx", FIXTURE_SOURCE);
    await sandbox.write("src/Other.tsx", FIXTURE_SOURCE);
    const { results } = await resolveIn(
      sandbox,
      [
        selection({
          tagName: "section",
          sourceCandidates: [
            creation(sandbox.file("src/App.tsx"), at(FIXTURE_SOURCE, '<section class="card">')),
          ],
        }),
        selection({
          tagName: "section",
          sourceCandidates: [
            creation(sandbox.file("src/Other.tsx"), at(FIXTURE_SOURCE, '<section class="card">')),
          ],
        }),
      ],
      { beforeRead: (file, cancel) => file.endsWith("App.tsx") && cancel() }
    );
    expect(
      results.map((result) => (result.state === "unavailable" ? result.reason : result.state))
    ).toEqual(["cancelled", "cancelled"]);
  });
});
