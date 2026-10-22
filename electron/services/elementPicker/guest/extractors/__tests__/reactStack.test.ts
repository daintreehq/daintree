import { afterEach, describe, expect, it } from "vitest";
import { componentFrame, creationFrames, readRawStack } from "../reactStack.js";

const ctor = Error as unknown as { prepareStackTrace?: unknown };
const original = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");

afterEach(() => {
  if (original) Object.defineProperty(Error, "prepareStackTrace", original);
  else delete ctor.prepareStackTrace;
});

/** An object shaped like React's `_debugStack`, with a stack as V8 would print it. */
function debugStack(...frames: string[]): { stack: string } {
  return { stack: ["Error: react-stack-top-frame", ...frames].join("\n") };
}

const FACTORY =
  "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:15)";
const BOTTOM =
  "    at Object.react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:18509:20)";

describe("creationFrames", () => {
  it("reads the frames between React's factory and its render entry, in generated coordinates", () => {
    const { frames, omitted } = creationFrames(
      debugStack(
        FACTORY,
        "    at Card (http://localhost:5173/src/Card.tsx?t=1712:12:7)",
        "    at http://localhost:5173/src/list.ts:3:9",
        BOTTOM,
        "    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:5650:22)"
      ),
      4
    );
    expect(frames).toEqual([
      { index: 1, file: "http://localhost:5173/src/Card.tsx?t=1712", line: 12, column: 7 },
      { index: 2, file: "http://localhost:5173/src/list.ts", line: 3, column: 9 },
    ]);
    expect(omitted).toBe(0);
  });

  it("keeps each frame's position however many around it have no location", () => {
    const { frames } = creationFrames(
      debugStack(
        FACTORY,
        "    at Array.map (<anonymous>)",
        "    at eval (eval at run (http://localhost:5173/src/a.ts:1:1), <anonymous>:2:3)",
        "    at async Promise.all (index 0)",
        "    at List (/Users/me/My Project (copy)/src/List.tsx:40:12)",
        "    at Wrapped (inner) (http://localhost:5173/src/wrap.tsx:7:2)",
        "    at async http://localhost:5173/src/load.ts:9:4",
        BOTTOM
      ),
      4
    );
    // A parenthesis in a path or a function name, or an anonymous async frame, leaves the location whole.
    expect(frames).toEqual([
      { index: 4, file: "/Users/me/My Project (copy)/src/List.tsx", line: 40, column: 12 },
      { index: 5, file: "http://localhost:5173/src/wrap.tsx", line: 7, column: 2 },
      { index: 6, file: "http://localhost:5173/src/load.ts", line: 9, column: 4 },
    ]);
  });

  it("keeps the frames of a stack deeper than React's capture, which has no bottom marker", () => {
    const deep = Array.from(
      { length: 9 },
      (_, depth) => `    at Level${depth} (http://localhost:5173/src/deep.ts:${depth + 1}:1)`
    );
    const { frames, omitted } = creationFrames(debugStack(FACTORY, ...deep), 4);
    expect(frames.map((frame) => frame.line)).toEqual([1, 2, 3, 4]);
    // Read, not sent: a reader choosing among them is told it did not see them all.
    expect(omitted).toBe(5);
  });

  it("reads nothing from a stack that is not React's, or a frame it cannot place", () => {
    expect(creationFrames({ stack: "TypeError: nope\n    at x (a.js:1:1)" }, 4).frames).toEqual([]);
    expect(creationFrames(null, 4).frames).toEqual([]);
    expect(creationFrames("Error: react-stack-top-frame", 4).frames).toEqual([]);
    const huge = "http://localhost/" + "a".repeat(2048);
    const { frames } = creationFrames(
      debugStack(FACTORY, `    at A (${huge}:1:1)`, "    at B (http://x/b.js:0:4)", BOTTOM),
      4
    );
    expect(frames).toEqual([]);
  });

  it("reads React's real capture, which starts with its own factory frame", () => {
    function jsxDEV(): Error {
      return Error("react-stack-top-frame");
    }
    function Component(): Error {
      return jsxDEV();
    }
    const { frames } = creationFrames(Component(), 4);
    expect(frames[0]?.index).toBe(1);
    expect(frames[0]?.file).toContain("reactStack.test.ts");
    expect(frames[0]?.line).toBeGreaterThan(0);
  });
});

describe("componentFrame", () => {
  it("is the last frame above React's render entry: the function React called", () => {
    const frame = componentFrame(
      debugStack(
        FACTORY,
        "    at renderRow (http://localhost:5173/src/rows.tsx?t=4:8:12)",
        "    at Array.map (<anonymous>)",
        "    at Table (http://localhost:5173/src/Table.tsx?t=4:21:18)",
        BOTTOM,
        "    at renderWithHooks (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1:5650:22)"
      )
    );
    expect(frame).toEqual({
      index: 3,
      file: "http://localhost:5173/src/Table.tsx?t=4",
      line: 21,
      column: 18,
      name: "Table",
    });
  });

  it("names the function as V8 printed it, and an anonymous one not at all", () => {
    const named = (line: string) => componentFrame(debugStack(FACTORY, line, BOTTOM))?.name;
    expect(named("    at Legacy.render (http://localhost:5173/src/Legacy.tsx:9:12)")).toBe(
      "Legacy.render"
    );
    expect(named("    at new Widget (http://localhost:5173/src/Widget.tsx:4:3)")).toBe("Widget");
    expect(named("    at http://localhost:5173/src/anonymous.tsx:2:30")).toBeNull();
  });

  it("is nothing for a stack cut short of the marker, or one with no located frame above it", () => {
    const deep = Array.from(
      { length: 9 },
      (_, depth) => `    at Level${depth} (http://localhost:5173/src/deep.ts:${depth + 1}:1)`
    );
    // Wherever the capture limit fell is not the component.
    expect(componentFrame(debugStack(FACTORY, ...deep))).toBeNull();
    expect(
      componentFrame(debugStack(FACTORY, "    at Array.map (<anonymous>)", BOTTOM))
    ).toBeNull();
    expect(componentFrame({ stack: "TypeError: nope\n    at x (a.js:1:1)" })).toBeNull();
  });
});

describe("readRawStack", () => {
  it("formats with V8's own format under a page's formatter, and puts the formatter back", () => {
    const pageFormatter = (): string => "formatted by the page";
    ctor.prepareStackTrace = pageFormatter;
    const raw = readRawStack(new Error("react-stack-top-frame"));
    expect(raw?.startsWith("Error: react-stack-top-frame\n")).toBe(true);
    expect(ctor.prepareStackTrace).toBe(pageFormatter);
  });

  it("leaves a page without a formatter untouched", () => {
    ctor.prepareStackTrace = undefined;
    let writes = 0;
    const descriptor = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    Object.defineProperty(Error, "prepareStackTrace", {
      configurable: true,
      get: () => undefined,
      set: () => {
        writes += 1;
      },
    });
    try {
      expect(readRawStack(new Error("react-stack-top-frame"))).toContain("react-stack-top-frame");
      expect(writes).toBe(0);
    } finally {
      if (descriptor) Object.defineProperty(Error, "prepareStackTrace", descriptor);
      else delete ctor.prepareStackTrace;
    }
  });

  it("survives a stack that throws or is not a string", () => {
    const hostile = Object.defineProperty({}, "stack", {
      get() {
        throw new Error("no");
      },
    });
    expect(readRawStack(hostile)).toBeNull();
    expect(readRawStack({ stack: 42 })).toBeNull();
  });
});
