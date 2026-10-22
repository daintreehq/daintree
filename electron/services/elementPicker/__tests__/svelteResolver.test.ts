import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { ElementPickerHost } from "../ElementPickerHost.js";
import type { SourceChange } from "../sourceTracker.js";
import { RESOLVER_LOADERS } from "../worker/resolverRegistry.js";
import { RuntimeChild, request } from "./fixtures.js";
import {
  APP,
  createSandbox,
  evidence,
  fileHint,
  locationOf,
  rangeOf,
  ref,
  resolveIn,
  resolveOne,
  revisionOf,
  revisionOfFile,
  selection,
  templateLocation,
  type Sandbox,
} from "./svelteTestContext.js";

const NATIVE = "src/lib/native.svelte";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

async function native(): Promise<string> {
  return fs.readFile(sandbox.file(NATIVE), "utf8");
}

describe("the Svelte resolver's element locations", () => {
  it("verifies the exact element range at the revision of the bytes on disk", async () => {
    const source = await native();
    const result = await resolveOne(
      sandbox,
      selection({
        tagName: "H1",
        sourceCandidates: [templateLocation(NATIVE, locationOf(source, "<h1"))],
      })
    );
    expect(result).toMatchObject({
      state: "verified",
      claim: "template-location",
      target: { file: ref(NATIVE), location: rangeOf(source, "<h1", "</h1>") },
      fileRevision: await revisionOfFile(sandbox.file(NATIVE)),
    });
    expect(result).not.toHaveProperty("placedBy");
  });

  it("reads a location in the convention it was reported in", async () => {
    const source = await native();
    const meta = locationOf(source, "<p");
    // The same position, as a 0-based line and 1-based column.
    const shifted = {
      ...meta,
      lineBase: 0,
      columnBase: 1,
      line: meta.line - 1,
      column: meta.column + 1,
    } as const;
    const result = await resolveOne(
      sandbox,
      selection({ tagName: "P", sourceCandidates: [templateLocation(NATIVE, shifted)] })
    );
    expect(result).toMatchObject({
      state: "verified",
      target: { location: rangeOf(source, "<p", "</p>") },
    });
  });

  it("verifies an element created by `element-creation` the same way", async () => {
    const source = await native();
    const at = locationOf(source, "<a");
    const candidate = {
      ...templateLocation(NATIVE, at),
      kind: "element-creation",
      location: at,
    } as const;
    const result = await resolveOne(
      sandbox,
      selection({ tagName: "A", sourceCandidates: [candidate] })
    );
    expect(result).toMatchObject({ state: "verified", claim: "element-creation" });
  });

  it("names a file reported by its absolute path inside the app", async () => {
    const source = await native();
    const result = await resolveOne(
      sandbox,
      selection({
        tagName: "H1",
        sourceCandidates: [templateLocation(sandbox.file(NATIVE), locationOf(source, "<h1"))],
      })
    );
    expect(result).toMatchObject({ state: "verified", target: { file: ref(NATIVE) } });
  });

  it("places a hydrated page's misstamped element by its shape, and proves it there", async () => {
    // Svelte's dev walk counted the Header's root while hydrating, so the
    // toolbar div carries the location of the span after it.
    const file = "src/routes/hydrated.svelte";
    const source = [
      "<script>import Header from '$lib/Header.svelte';</script>",
      "<Header />",
      '<div class="journal">',
      '  <div class="toolbar"><p>September</p></div>',
      "</div>",
      '<div class="end"><span>*</span></div>',
      "",
    ].join("\n");
    await sandbox.write(file, source);
    const stamped = locationOf(source, "<span");
    const frame = {
      type: "component",
      file: ".svelte-kit/generated/root.svelte",
      line: 56,
      column: 18,
      componentTag: "Pyramid_2",
    };
    const shape = {
      file,
      path: [
        { tag: "div", index: 0 },
        { tag: "div", index: 0 },
      ],
    };
    const placed = await resolveOne(
      sandbox,
      selection({
        sourceCandidates: [templateLocation(file, stamped)],
        evidence: evidence({ ancestry: [frame], sameLocCount: 7, structure: shape }),
      })
    );
    expect(placed).toMatchObject({
      state: "verified",
      target: { file: ref(file), location: rangeOf(source, '<div class="toolbar"', "</div>") },
      placedBy: "structure",
    });

    // Without the shape, the disagreement is reported as what it is: the file
    // was read and the claim does not hold in it.
    const revision = await revisionOfFile(sandbox.file(file));
    const mismatch = {
      state: "unavailable",
      reason: "mismatch",
      read: { file: ref(file), fileRevision: revision },
    };
    expect(
      await resolveOne(
        sandbox,
        selection({
          sourceCandidates: [templateLocation(file, stamped)],
          evidence: evidence({ ancestry: [frame] }),
        })
      )
    ).toMatchObject(mismatch);
    // A shape the source cannot follow leaves the disagreement as it was.
    expect(
      await resolveOne(
        sandbox,
        selection({
          sourceCandidates: [templateLocation(file, stamped)],
          evidence: evidence({
            ancestry: [frame],
            structure: { file, path: [{ tag: "div", index: 4 }] },
          }),
        })
      )
    ).toMatchObject(mismatch);
    // A shape described in another file says nothing about this one.
    expect(
      await resolveOne(
        sandbox,
        selection({
          sourceCandidates: [templateLocation(file, stamped)],
          evidence: evidence({ ancestry: [frame], structure: { ...shape, file: NATIVE } }),
        })
      )
    ).toMatchObject(mismatch);
  });

  it("keeps a stamp the file agrees with, whatever the shape says", async () => {
    // The page can move an element after stamping it; its new place says
    // nothing about its source.
    const file = "src/routes/twins.svelte";
    const source = [
      "<script>import Header from '$lib/Header.svelte';</script>",
      "<Header />",
      '<section class="one"><p>1</p></section>',
      '<section class="two"><p>2</p></section>',
      "",
    ].join("\n");
    await sandbox.write(file, source);
    const result = await resolveOne(
      sandbox,
      selection({
        tagName: "SECTION",
        sourceCandidates: [templateLocation(file, locationOf(source, '<section class="two"'))],
        evidence: evidence({
          ancestry: [
            { type: "component", file: ".svelte-kit/generated/root.svelte", line: 5, column: 0 },
          ],
          structure: { file, path: [{ tag: "section", index: 0 }] },
        }),
      })
    );
    expect(result).toMatchObject({
      state: "verified",
      target: { location: rangeOf(source, '<section class="two"', "</section>") },
    });
    expect(result).not.toHaveProperty("placedBy");
  });

  it("places an element the page could not stamp at all, by its shape alone", async () => {
    const file = "src/routes/tail.svelte";
    const source = [
      "<script>import Header from '$lib/Header.svelte';</script>",
      "<Header />",
      '<div class="toolbar"><p class="label">September</p></div>',
      "",
    ].join("\n");
    await sandbox.write(file, source);
    const structure = {
      file,
      path: [
        { tag: "div", index: 0 },
        { tag: "p", index: 0 },
      ],
    };
    const frame = {
      type: "component",
      file: ".svelte-kit/generated/root.svelte",
      line: 5,
      column: 0,
    };
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "P",
          sourceCandidates: [templateLocation(file, null)],
          evidence: evidence({ ancestry: [frame], structure }),
        })
      )
    ).toMatchObject({
      state: "verified",
      target: { file: ref(file), location: rangeOf(source, '<p class="label"', "</p>") },
      placedBy: "structure",
    });
    // With neither a stamp nor a shape there is nothing to place, and nothing is read.
    const { results, reads } = await resolveIn(sandbox, [
      selection({ tagName: "P", sourceCandidates: [templateLocation(file, null)] }),
    ]);
    expect(results[0]).toMatchObject({ state: "unavailable", reason: "unsupported" });
    expect(reads).toEqual([]);
  });

  it("reports a location that no longer lands on an element as a mismatch, never a neighbour", async () => {
    const original = await native();
    const captured = locationOf(original, "<h1");
    // An agent inserts a line above: the captured position now points into
    // the `<section` line.
    await sandbox.write(NATIVE, `<!-- banner -->\n${original}`);
    const revision = await revisionOfFile(sandbox.file(NATIVE));
    for (const location of [captured, { ...captured, column: captured.column + 1 }]) {
      expect(
        await resolveOne(
          sandbox,
          selection({ tagName: "H1", sourceCandidates: [templateLocation(NATIVE, location)] })
        )
      ).toEqual({
        state: "unavailable",
        candidateId: expect.any(String),
        claim: "template-location",
        reason: "mismatch",
        read: { file: ref(NATIVE), fileRevision: revision },
      });
    }
  });

  it("reports a location that now lands on an element of another tag as a mismatch", async () => {
    const original = await native();
    const captured = locationOf(original, "<p");
    await sandbox.write(NATIVE, original.replace("<p", "<h3").replace("</p>", "</h3>"));
    expect(
      await resolveOne(
        sandbox,
        selection({ tagName: "P", sourceCandidates: [templateLocation(NATIVE, captured)] })
      )
    ).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("never verifies a rendered element at a component's call site", async () => {
    const source = await fs.readFile(sandbox.file("src/lib/invocations.svelte"), "utf8");
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "ARTICLE",
          sourceCandidates: [
            templateLocation("src/lib/invocations.svelte", locationOf(source, "<Card")),
          ],
        })
      )
    ).toMatchObject({ state: "unavailable", reason: "mismatch" });
  });

  it("refuses a reported path that escapes the app root, without reading it", async () => {
    const files = [
      "../../packages/ui/Button.svelte",
      "src/../../../packages/ui/Button.svelte",
      "../../../outside.svelte",
      `${sandbox.root}/outside.svelte`,
    ];
    const { results, reads } = await resolveIn(sandbox, [
      selection({
        tagName: "BUTTON",
        sourceCandidates: files.map((file) =>
          templateLocation(file, {
            lineBase: 1,
            columnBase: 0,
            columnUnit: "utf16",
            line: 1,
            column: 0,
          })
        ),
      }),
    ]);
    expect(results.map((result) => result.state === "unavailable" && result.reason)).toEqual(
      files.map(() => "outside-workspace")
    );
    expect(reads).toEqual([]);
  });

  it("refuses a path that reaches outside the app through a symlinked directory", async () => {
    await fs.symlink(`${sandbox.worktree}/packages/ui`, sandbox.file("src/shared"), "dir");
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "BUTTON",
          sourceCandidates: [
            templateLocation("src/shared/Button.svelte", {
              lineBase: 1,
              columnBase: 0,
              columnUnit: "utf16",
              line: 1,
              column: 0,
            }),
          ],
        })
      )
    ).toMatchObject({ state: "unavailable", reason: "outside-workspace" });
  });

  it("refuses a generated file and unmapped content without reading either", async () => {
    const head = { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 1, column: 0 } as const;
    const { results, reads } = await resolveIn(sandbox, [
      selection({
        sourceCandidates: [templateLocation(".svelte-kit/generated/root.svelte", head)],
      }),
      selection({
        sourceCandidates: [templateLocation(NATIVE, head)],
        evidence: evidence({ unmapped: true }),
      }),
    ]);
    expect(results.map((result) => result.state === "unavailable" && result.reason)).toEqual([
      "unsupported",
      "unsupported",
    ]);
    expect(reads).toEqual([]);
  });

  it("names an element's file hint as read, never as a line", async () => {
    expect(
      await resolveOne(sandbox, selection({ sourceCandidates: [fileHint(NATIVE)] }))
    ).toMatchObject({
      state: "observed",
      claim: "file-hint",
      target: { file: ref(NATIVE), location: null },
      fileRevision: await revisionOfFile(sandbox.file(NATIVE)),
    });
  });

  it("traces a plain Svelte app that has no SvelteKit at all", async () => {
    await sandbox.cleanup();
    sandbox = await createSandbox({ kit: false });
    const source = await native();
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "H1",
          sourceCandidates: [templateLocation(NATIVE, locationOf(source, "<h1"))],
        })
      )
    ).toMatchObject({ state: "verified", target: { file: ref(NATIVE) } });
  });
});

describe("byte order mark", () => {
  it("resolves against BOM-free offsets while the revision keeps the BOM", async () => {
    const file = "src/lib/bom.svelte";
    const original = '﻿<h1 class="title">Hello</h1>\n';
    await sandbox.write(file, original);
    const bytes = await fs.readFile(sandbox.file(file));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const result = await resolveOne(
      sandbox,
      selection({
        tagName: "H1",
        sourceCandidates: [
          templateLocation(file, {
            lineBase: 1,
            columnBase: 0,
            columnUnit: "utf16",
            line: 1,
            column: 0,
          }),
        ],
      })
    );
    expect(result).toMatchObject({
      state: "verified",
      target: { location: { line: 1, column: 0, end: { line: 1, column: original.length - 2 } } },
      fileRevision: revisionOf(bytes),
    });
  });

  it("keeps a second leading U+FEFF as content", async () => {
    const file = "src/lib/double-bom.svelte";
    await sandbox.write(file, "﻿﻿<h1>Hello</h1>\n");
    // What Svelte's dev runtime reports: one BOM removed, the second is column 0's content.
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "H1",
          sourceCandidates: [
            templateLocation(file, {
              lineBase: 1,
              columnBase: 0,
              columnUnit: "utf16",
              line: 1,
              column: 1,
            }),
          ],
        })
      )
    ).toMatchObject({ state: "verified" });
  });
});

describe("revisions", () => {
  it("resolves as usual when the file is still at the revision an earlier result held", async () => {
    const source = await native();
    const known = await revisionOfFile(sandbox.file(NATIVE));
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "H1",
          sourceCandidates: [templateLocation(NATIVE, locationOf(source, "<h1"))],
        }),
        { knownRevisions: [{ file: ref(NATIVE), revision: known }] }
      )
    ).toMatchObject({ state: "verified", fileRevision: known });
  });

  it("reports a file that changed since an earlier result as stale, even where the claim still holds", async () => {
    const source = await native();
    const location = locationOf(source, "<h1");
    const known = await revisionOfFile(sandbox.file(NATIVE));
    // Appended, so the heading is still exactly where it was.
    await sandbox.write(NATIVE, `${source}\n<!-- agent -->\n`);
    const candidate = templateLocation(NATIVE, location);
    expect(
      await resolveOne(sandbox, selection({ tagName: "H1", sourceCandidates: [candidate] }), {
        knownRevisions: [{ file: ref(NATIVE), revision: known }],
      })
    ).toEqual({
      state: "stale",
      candidateId: candidate.candidateId,
      claim: "template-location",
      held: { state: "observed", target: { file: ref(NATIVE), location }, fileRevision: known },
      currentFileRevision: await revisionOfFile(sandbox.file(NATIVE)),
      reason: "file-changed",
    });
  });

  it("never relocates an element in a file that changed since an earlier result", async () => {
    const file = "src/routes/tail.svelte";
    await sandbox.write(file, '<div class="toolbar"><p class="label">September</p></div>\n');
    const known = await revisionOfFile(sandbox.file(file));
    await sandbox.write(file, '<div class="toolbar"><p class="label">October</p></div>\n');
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "P",
          sourceCandidates: [templateLocation(file, null)],
          evidence: evidence({
            structure: {
              file,
              path: [
                { tag: "div", index: 0 },
                { tag: "p", index: 0 },
              ],
            },
          }),
        }),
        { knownRevisions: [{ file: ref(file), revision: known }] }
      )
    ).toMatchObject({
      state: "stale",
      reason: "file-changed",
      held: { target: { location: null } },
    });
  });

  it("reports a file that is gone since an earlier result as stale, with nothing on disk now", async () => {
    const source = await native();
    const known = await revisionOfFile(sandbox.file(NATIVE));
    await fs.rm(sandbox.file(NATIVE));
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "H1",
          sourceCandidates: [templateLocation(NATIVE, locationOf(source, "<h1"))],
        }),
        { knownRevisions: [{ file: ref(NATIVE), revision: known }] }
      )
    ).toMatchObject({ state: "stale", reason: "file-missing", currentFileRevision: null });
  });

  it("reads each file once per resolve, so every candidate in it cites the same bytes", async () => {
    const source = await native();
    const { results, reads } = await resolveIn(sandbox, [
      selection({
        tagName: "H1",
        sourceCandidates: [templateLocation(NATIVE, locationOf(source, "<h1"))],
      }),
      selection({
        tagName: "P",
        sourceCandidates: [templateLocation(NATIVE, locationOf(source, "<p"))],
      }),
    ]);
    expect(reads).toEqual([`${APP}/${NATIVE}`]);
    const revision = await revisionOfFile(sandbox.file(NATIVE));
    expect(
      results.map((result) => [result.state, "fileRevision" in result && result.fileRevision])
    ).toEqual([
      ["verified", revision],
      ["verified", revision],
    ]);
  });
});

describe("cancellation", () => {
  it("answers what it had not begun when the job was withdrawn as cancelled, even from bytes in hand", async () => {
    const source = await native();
    const card = "src/lib/card.svelte";
    const cardSource = await fs.readFile(sandbox.file(card), "utf8");
    const { results } = await resolveIn(
      sandbox,
      [
        selection({
          tagName: "H1",
          sourceCandidates: [templateLocation(NATIVE, locationOf(source, "<h1"))],
        }),
        selection({
          tagName: "ARTICLE",
          sourceCandidates: [templateLocation(card, locationOf(cardSource, "<article"))],
        }),
        // Its file was read for the first observation, before the cancel.
        selection({
          tagName: "P",
          sourceCandidates: [templateLocation(NATIVE, locationOf(source, "<p"))],
        }),
      ],
      { beforeRead: (file, cancel) => file.endsWith(card) && cancel() }
    );
    expect(
      results.map((result) => (result.state === "unavailable" ? result.reason : result.state))
    ).toEqual(["verified", "cancelled", "cancelled"]);
  });
});

describe("source reads are bounded", () => {
  const head = { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 1, column: 0 } as const;

  it("refuses a file past the request's byte limit without parsing it", async () => {
    await sandbox.write("src/lib/huge.svelte", `<div>${"x".repeat(200)}</div>\n`);
    expect(
      await resolveOne(
        sandbox,
        selection({ sourceCandidates: [templateLocation("src/lib/huge.svelte", head)] }),
        {
          budget: { maxFileBytes: 64 },
        }
      )
    ).toMatchObject({ state: "unavailable", reason: "budget-exhausted" });
  });

  it.skipIf(process.platform === "win32")(
    "never reads something that is not a regular file",
    async () => {
      // A FIFO named `x.svelte` stats as size 0 and its read need never end.
      execFileSync("mkfifo", [sandbox.file("src/lib/pipe.svelte")]);
      expect(
        await resolveOne(
          sandbox,
          selection({ sourceCandidates: [templateLocation("src/lib/pipe.svelte", head)] })
        )
      ).toMatchObject({ state: "unavailable", reason: "file-missing" });
    }
  );

  it("names bytes that are not UTF-8 as read, and holds no claim in them", async () => {
    await sandbox.write(
      "src/lib/latin1.svelte",
      Uint8Array.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])
    );
    expect(
      await resolveOne(
        sandbox,
        selection({
          tagName: "P",
          sourceCandidates: [templateLocation("src/lib/latin1.svelte", head)],
        })
      )
    ).toMatchObject({
      state: "unavailable",
      reason: "unsupported",
      read: {
        file: ref("src/lib/latin1.svelte"),
        fileRevision: await revisionOfFile(sandbox.file("src/lib/latin1.svelte")),
      },
    });
  });

  it("names source the compiler cannot parse as read, not as a contradicted claim", async () => {
    await sandbox.write("src/lib/broken.svelte", "<div>{#if}</div>\n");
    expect(
      await resolveOne(
        sandbox,
        selection({ sourceCandidates: [templateLocation("src/lib/broken.svelte", head)] })
      )
    ).toMatchObject({
      state: "unavailable",
      reason: "unsupported",
      read: { file: ref("src/lib/broken.svelte") },
    });
  });
});

describe("the Svelte resolver in the host", () => {
  it("is registered, resolves through main's locator and reads, and tracks what it read", async () => {
    const watched = new Map<string, (changedPath: string) => void>();
    const host = new ElementPickerHost({
      fork: () => new RuntimeChild(RESOLVER_LOADERS),
      kill: () => {},
      watch: (directory, onChange) => {
        watched.set(directory, onChange);
        return () => watched.delete(directory);
      },
      idleMs: 60_000,
    });
    try {
      const changes: SourceChange[] = [];
      const workspaceId = await host.registerWorkspace({
        worktreePath: sandbox.worktree,
        appRoot: sandbox.appRoot,
        onSourceChanged: (change) => changes.push(change),
      });
      const source = await native();
      const candidate = templateLocation(NATIVE, locationOf(source, "<h1"));
      const response = await host.resolve(
        request(workspaceId, [selection({ tagName: "H1", sourceCandidates: [candidate] })])
      );
      const file = { workspaceId, path: `${APP}/${NATIVE}` };
      expect(response.outcomes[0]?.results).toEqual([
        {
          state: "verified",
          candidateId: candidate.candidateId,
          claim: "template-location",
          target: { file, location: rangeOf(source, "<h1", "</h1>") },
          fileRevision: await revisionOfFile(sandbox.file(NATIVE)),
        },
      ]);

      // An agent rewrites the file the resolve read: whoever holds the result hears of it.
      const external = `${source}\n<!-- agent -->\n`;
      await fs.writeFile(`${sandbox.file(NATIVE)}.tmp`, external);
      await fs.rename(`${sandbox.file(NATIVE)}.tmp`, sandbox.file(NATIVE));
      for (const onChange of watched.values()) onChange(sandbox.file(NATIVE));
      await vi.waitFor(() => expect(changes).toEqual([{ file, revision: revisionOf(external) }]), {
        timeout: 5_000,
      });
    } finally {
      await host.dispose();
    }
  });
});
