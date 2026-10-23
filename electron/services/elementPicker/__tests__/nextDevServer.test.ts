import { describe, expect, it } from "vitest";
import type { SelectionObservation } from "../../../../shared/elementPicker/observation.js";
import {
  frameMapNames,
  nextDevServer,
  serverFrameFile,
  serverMapKey,
  turbopackProjectPath,
  webpackModulePath,
} from "../nextDevServer.js";
import { observation } from "./fixtures.js";

const CHUNK = "file:///work/app/.next/dev/server/chunks/ssr/[root-of-the-server]__page._.js";

describe("serverFrameFile", () => {
  it("reads the server's file out of the wrapper Flight names a fake frame by, either spelling", () => {
    expect(serverFrameFile(`about://React/Server/${encodeURI(CHUNK)}?12`)).toBe(CHUNK);
    expect(serverFrameFile(`rsc://React/Prerender/${encodeURI(CHUNK)}?0`)).toBe(CHUNK);
    // No counter when the fake function was the only one.
    expect(serverFrameFile(`about://React/Cache/${encodeURI(CHUNK)}`)).toBe(CHUNK);
    // A query of the file's own is the file's.
    expect(serverFrameFile("about://React/Server/webpack-internal:///(rsc)/./a.tsx?v=1?3")).toBe(
      "webpack-internal:///(rsc)/./a.tsx?v=1"
    );
  });

  it("is null for any other URL, and for one that will not decode", () => {
    for (const url of [
      "http://localhost:3000/_next/static/chunks/app.js",
      CHUNK,
      "about://React/",
      "about://Other/Server/file:///a.js?1",
      "about://React/Server/%E0%A4%A?1",
    ]) {
      expect(serverFrameFile(url), url).toBeNull();
    }
  });

  it("gives every frame of one file one name to ask its map by", () => {
    const one = serverFrameFile(`about://React/Server/${encodeURI(CHUNK)}?1`)!;
    const two = serverFrameFile(`rsc://React/Prerender/${encodeURI(CHUNK)}?2`)!;
    expect(serverMapKey(one)).toBe(serverMapKey(two));
    expect(serverFrameFile(serverMapKey(one))).toBe(CHUNK);
    // A numeric query of the file's own survives the round trip through main.
    const queried = "webpack-internal:///(rsc)/./app/page.tsx?123";
    expect(serverFrameFile(`about://React/Server/${queried}?7`)).toBe(queried);
    expect(serverFrameFile(serverMapKey(queried))).toBe(queried);
  });
});

describe("frameMapNames", () => {
  it("asks for a server file's map by the route's name, then by the file on disk", () => {
    expect(frameMapNames(`about://React/Server/${encodeURI(CHUNK)}?4`)).toEqual({
      url: serverMapKey(CHUNK),
      alternates: [CHUNK],
    });
    expect(frameMapNames("about://React/Server/C:%5Capp%5C.next%5Cchunk.js?4").alternates).toEqual([
      "C:\\app\\.next\\chunk.js",
    ]);
  });

  it("has no file to fall back on for a Webpack module, and leaves any other frame as it is", () => {
    const module = "webpack-internal:///(rsc)/./app/page.tsx";
    expect(frameMapNames(`about://React/Server/${module}?1`)).toEqual({
      url: serverMapKey(module),
      alternates: [],
    });
    const client = "http://localhost:3000/_next/static/chunks/app.js";
    expect(frameMapNames(client)).toEqual({ url: client, alternates: [] });
  });
});

describe("webpackModulePath", () => {
  it("strips the prefixes Next.js's overlay strips, and a resource query", () => {
    expect(webpackModulePath("webpack-internal:///(rsc)/./app/page.tsx")).toBe("./app/page.tsx");
    expect(webpackModulePath("webpack-internal:///(app-pages-browser)/./src/Card.tsx")).toBe(
      "./src/Card.tsx"
    );
    expect(webpackModulePath("webpack://_N_E/./app/page.tsx?7c1e")).toBe("./app/page.tsx");
    expect(webpackModulePath("webpack:///./lib/a.ts")).toBe("./lib/a.ts");
  });

  it("is null for anything Webpack did not name", () => {
    for (const name of [
      "file:///a.ts",
      "turbopack:///[project]/a.ts",
      "webpack-internal:///",
      "",
    ]) {
      expect(webpackModulePath(name), name).toBeNull();
    }
  });
});

describe("turbopackProjectPath", () => {
  it("reads a source named from Turbopack's project root, with or without its scheme", () => {
    expect(turbopackProjectPath("turbopack:///[project]/app/page.tsx")).toBe("app/page.tsx");
    expect(turbopackProjectPath("[project]/apps/web/app/page.tsx")).toBe("apps/web/app/page.tsx");
    expect(turbopackProjectPath("turbopack:///[turbopack]/runtime.ts")).toBeNull();
    expect(turbopackProjectPath("app/page.tsx")).toBeNull();
  });
});

describe("nextDevServer", () => {
  function reporting(fields: Array<{ name: string; value: string | number | boolean | null }>) {
    return {
      ...observation("el-1", []),
      frameworkEvidence: [{ kind: "generic", framework: "react", fields }],
    } as SelectionObservation;
  }

  it("asks the routes only of a major they were written against", () => {
    expect(nextDevServer([reporting([{ name: "nextVersion", value: "16.0.3" }])])).toEqual({
      routes: true,
    });
    expect(nextDevServer([reporting([{ name: "nextVersion", value: "16.1.0-canary.4" }])])).toEqual(
      { routes: true }
    );
    for (const version of ["15.5.0", "17.0.0", "1600.0.0", "16"]) {
      expect(
        nextDevServer([reporting([{ name: "nextVersion", value: version }])]),
        version
      ).toEqual({ routes: false });
    }
  });

  it("knows a Next.js page by its router alone, and nothing of a page that reported neither", () => {
    expect(nextDevServer([reporting([{ name: "nextRouter", value: "pages" }])])).toEqual({
      routes: false,
    });
    expect(nextDevServer([reporting([{ name: "fiberLookup", value: "element" }])])).toBeNull();
    expect(nextDevServer([observation("el-1", [])])).toBeNull();
  });

  it("reads React's evidence only", () => {
    const other = {
      ...observation("el-1", []),
      frameworkEvidence: [
        { kind: "generic", framework: "vue", fields: [{ name: "nextVersion", value: "16.0.3" }] },
      ],
    } as SelectionObservation;
    expect(nextDevServer([other])).toBeNull();
  });
});
