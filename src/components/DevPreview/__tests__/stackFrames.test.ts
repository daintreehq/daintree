import { describe, expect, it } from "vitest";
import type { CdpStackFrame } from "@shared/types/ipc/webviewConsole";
import {
  frameFileName,
  isLibraryFrame,
  framePath,
  primaryFrame,
  segmentFrames,
  stripV8StackTail,
} from "../stackFrames";

const f = (url: string, functionName = "fn"): CdpStackFrame => ({
  functionName,
  url,
  lineNumber: 1,
  columnNumber: 1,
});

describe("framePath", () => {
  it("drops the shared origin and dev-server cache-busting queries", () => {
    expect(framePath(f("http://localhost:5173/src/lib/cart.ts?t=1727170000123"))).toBe(
      "src/lib/cart.ts"
    );
    expect(framePath(f("http://localhost:5173/node_modules/.vite/deps/react.js?v=4c1a"))).toBe(
      "node_modules/.vite/deps/react.js"
    );
  });

  it("keeps query parameters that are part of the module's identity", () => {
    expect(framePath(f("http://localhost:5173/src/App.vue?vue&type=script&t=9"))).toBe(
      "src/App.vue?vue&type=script"
    );
  });

  it("strips webpack's internal scheme down to the source path", () => {
    expect(framePath(f("webpack-internal:///./src/components/Header.tsx"))).toBe(
      "src/components/Header.tsx"
    );
  });

  it("is empty for a frame with no source", () => {
    expect(framePath(f(""))).toBe("");
  });

  it("never loses information for URLs it cannot shorten", () => {
    expect(framePath(f("chrome-extension://abc/content.js"))).toBe(
      "chrome-extension://abc/content.js"
    );
    expect(framePath(f("not a url"))).toBe("not a url");
  });
});

describe("frameFileName", () => {
  it("is the last path segment without the query", () => {
    expect(frameFileName(f("http://localhost:5173/src/routes/+page.ts?t=1"))).toBe("+page.ts");
  });
});

describe("primaryFrame", () => {
  it("skips library frames to reach the user's own code", () => {
    const frames = [
      f("http://localhost:5173/node_modules/.vite/deps/react-dom.js", "warn"),
      f("http://localhost:5173/src/Cart.tsx", "Cart"),
    ];
    expect(primaryFrame(frames)?.functionName).toBe("Cart");
  });

  it("falls back to the call site when every frame is library code", () => {
    const frames = [
      f("", "JSON.parse"),
      f("http://localhost:5173/@vite/client", "connect"),
      f("http://localhost:5173/node_modules/x.js", "other"),
    ];
    expect(primaryFrame(frames)?.functionName).toBe("connect");
  });
});

describe("isLibraryFrame", () => {
  it("judges ownership by the path, not by how Vite happened to serve the file", () => {
    expect(
      isLibraryFrame(f("http://localhost:5173/@fs/Users/me/repo/packages/ui/Button.tsx"))
    ).toBe(false);
    expect(
      isLibraryFrame(f("http://localhost:5173/@fs/Users/me/repo/node_modules/react/index.js"))
    ).toBe(true);
  });
});

describe("stripV8StackTail", () => {
  it("removes V8's trailing frame lines and keeps a multi-line message", () => {
    const summary = "TypeError: bad\ndetail line\n    at a (x.js:1:1)\n    at x.js:2:2";
    expect(stripV8StackTail(summary)).toBe("TypeError: bad\ndetail line");
  });

  it("never strips the message itself, and leaves text without a tail untouched", () => {
    expect(stripV8StackTail("    at looks like a frame")).toBe("    at looks like a frame");
    expect(stripV8StackTail("plain\ntext")).toBe("plain\ntext");
  });
});

describe("segmentFrames", () => {
  const app = (name: string) => f(`http://localhost:5173/src/${name}.ts`, name);
  const lib = (name: string) => f(`http://localhost:5173/node_modules/.vite/deps/${name}.js`, name);

  it("accounts for every frame exactly once, in order", () => {
    const frames = [app("a"), lib("b"), lib("c"), app("d"), lib("e"), lib("f"), lib("g")];
    const order = segmentFrames(frames).flatMap((s) =>
      s.kind === "frame" ? [s.index] : s.frames.map((x) => x.index)
    );
    expect(order).toEqual(frames.map((_, i) => i));
  });

  it("folds only runs of two or more library frames", () => {
    const segments = segmentFrames([app("a"), lib("b"), app("c"), lib("d"), lib("e")]);
    expect(segments.map((s) => s.kind)).toEqual(["frame", "frame", "frame", "library"]);
  });

  it("folds nothing when the whole stack is library code", () => {
    const segments = segmentFrames([lib("a"), lib("b"), lib("c")]);
    expect(segments.every((s) => s.kind === "frame")).toBe(true);
  });
});
