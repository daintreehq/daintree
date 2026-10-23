// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CapabilitiesSchema } from "../../../../../shared/elementPicker/observation.js";
import { SourceCandidateSchema } from "../../../../../shared/elementPicker/source.js";
import { EXTRACTOR_REGISTRY_GLOBAL, channelEvent, type ExtractReply } from "../../guestChannel.js";
import { parseSourceLoc, solidContribution } from "../extractors/solidLocator.js";

const scope = globalThis as Record<string, unknown>;

afterEach(() => {
  (scope[EXTRACTOR_REGISTRY_GLOBAL] as { dispose(): void } | undefined)?.dispose();
  delete scope.api;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function element(sourceLoc?: string): Element {
  const node = document.createElement("button");
  if (sourceLoc !== undefined) node.setAttribute("data-source-loc", sourceLoc);
  document.body.appendChild(node);
  return node;
}

describe("parseSourceLoc", () => {
  it("splits from the right, so a colon in the path stays in the path", () => {
    expect(parseSourceLoc("src/components/Counter.tsx:14:8")).toEqual({
      file: "src/components/Counter.tsx",
      line: 14,
      column: 8,
    });
    expect(parseSourceLoc("C:/work/app/src/App.tsx:3:0")).toEqual({
      file: "C:/work/app/src/App.tsx",
      line: 3,
      column: 0,
    });
  });

  it.each([
    ["no coordinates", "src/App.tsx"],
    ["a line only", "src/App.tsx:3"],
    ["no path", ":3:4"],
    ["a line below Babel's first", "src/App.tsx:0:4"],
    ["a coordinate past any real file", "src/App.tsx:99999999:0"],
    ["a non-numeric column", "src/App.tsx:3:x"],
    ["a value longer than any path can make", "a".repeat(5_000) + ":1:0"],
  ])("refuses %s rather than guessing", (_label, value) => {
    expect(parseSourceLoc(value)).toBeNull();
  });
});

describe("solidContribution", () => {
  it("reports the element's own creation site, attributed to the attribute it came from", () => {
    const contribution = solidContribution(element("src/App.tsx:9:6"));
    expect(contribution?.sourceCandidates).toEqual([
      {
        kind: "element-creation",
        candidateId: "solid-source-loc",
        framework: "solid",
        extraction: { kind: "attribute", attribute: "data-source-loc" },
        file: "src/App.tsx",
        location: { lineBase: 1, columnBase: 0, columnUnit: "utf16", line: 9, column: 6 },
      },
    ]);
    expect(z.array(SourceCandidateSchema).safeParse(contribution?.sourceCandidates).success).toBe(
      true
    );
    // A creation site names no component and spans no range.
    expect(contribution?.componentChain).toBeUndefined();
    expect(CapabilitiesSchema.parse(contribution?.capabilities)).toEqual({
      names: { state: "unavailable", reason: "not-exposed" },
      chain: { state: "unavailable", reason: "not-exposed" },
      componentSelection: { state: "unavailable", reason: "not-exposed" },
      file: { state: "available" },
      line: { state: "available" },
      exactRange: { state: "unavailable", reason: "not-exposed" },
    });
  });

  it("never lends an ancestor's creation site to the element inside it", () => {
    const parent = element("src/App.tsx:8:4");
    const child = document.createElement("span");
    parent.appendChild(child);
    expect(solidContribution(child)).toBeNull();
  });

  it("contributes nothing for a malformed value", () => {
    expect(solidContribution(element("src/App.tsx"))).toBeNull();
  });
});

describe("the Solid extractor asset", () => {
  const CHANNEL = "solid-test";

  /** Evaluates the shipped entry as the host does: with its `api` global in scope. */
  async function installAsset(): Promise<void> {
    scope.api = { channel: CHANNEL, framework: "solid", installed: false };
    vi.resetModules();
    await import("../extractors/solid.js");
  }

  function ask(target: Element, id: number, phase: "hover" | "selection"): ExtractReply {
    let reply: ExtractReply | null = null;
    const controller = new AbortController();
    document.addEventListener(
      channelEvent(CHANNEL, "extracted"),
      (event) => {
        reply = JSON.parse((event as CustomEvent<string>).detail) as ExtractReply;
      },
      { capture: true, signal: controller.signal }
    );
    target.dispatchEvent(
      new CustomEvent(channelEvent(CHANNEL, "extract"), {
        detail: JSON.stringify({ id, phase }),
        composed: true,
      })
    );
    controller.abort();
    if (reply === null) throw new Error("the registry did not answer");
    return reply;
  }

  it("reads and parses the locator on a selection, never on a hover", async () => {
    await installAsset();
    const stamped = element("src/App.tsx:9:6");
    const reads = vi.spyOn(Element.prototype, "getAttribute");

    // Not a look at all: a hover says neither what Solid found nor that it found nothing.
    expect(ask(stamped, 1, "hover")).toEqual({ id: 1, contributions: [], empty: [] });
    expect(reads.mock.calls.filter(([name]) => name === "data-source-loc")).toEqual([]);

    const selection = ask(stamped, 2, "selection");
    expect(selection.contributions.map((entry) => entry.framework)).toEqual(["solid"]);
    expect(reads.mock.calls.filter(([name]) => name === "data-source-loc")).not.toEqual([]);
  });
});
