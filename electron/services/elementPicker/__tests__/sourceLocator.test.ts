import path from "node:path";
import { describe, expect, it } from "vitest";
import { joinSourceRoot, locateMapSource, type MapSourceContext } from "../sourceLocator.js";

const posix: MapSourceContext = {
  workspaceId: "ws",
  roots: { worktreePath: "/work/tree", appRoot: "/work/tree/apps/web" },
  previewOrigin: "http://localhost:5173",
  base: "http://localhost:5173/src/components/Card.tsx?t=1700000000000",
  paths: path.posix,
};

const windows: MapSourceContext = {
  ...posix,
  roots: { worktreePath: "C:\\work\\tree", appRoot: "C:\\work\\tree\\apps\\web" },
  paths: path.win32,
};

const locate = (source: string, sourceRoot: string | null = null, context = posix) =>
  locateMapSource(source, sourceRoot, context);

const at = (relative: string) => ({ ok: true, value: { workspaceId: "ws", path: relative } });
const refused = (reason: string) => ({ ok: false, reason });

describe("locateMapSource", () => {
  it("reads a source relative to the module as a path under the dev server's root", () => {
    expect(locate("Card.tsx")).toEqual(at("apps/web/src/components/Card.tsx"));
    expect(locate("../lib/format.ts")).toEqual(at("apps/web/src/lib/format.ts"));
    expect(locate("/src/main.tsx")).toEqual(at("apps/web/src/main.tsx"));
  });

  it("resolves against an external map's own URL", () => {
    expect(
      locate("../src/page.tsx", null, { ...posix, base: "http://localhost:5173/_next/page.js.map" })
    ).toEqual(at("apps/web/src/page.tsx"));
  });

  it("joins sourceRoot as a directory before resolving", () => {
    expect(joinSourceRoot("Card.tsx", "/src/components")).toBe("/src/components/Card.tsx");
    expect(joinSourceRoot("Card.tsx", "/src/components/")).toBe("/src/components/Card.tsx");
    expect(joinSourceRoot("Card.tsx", null)).toBe("Card.tsx");
    expect(locate("Card.tsx", "/src/components")).toEqual(at("apps/web/src/components/Card.tsx"));
    expect(locate("Card.tsx", "http://localhost:5173/src/")).toEqual(at("apps/web/src/Card.tsx"));
  });

  it("reads Vite's /@fs/ URLs as absolute paths, drive letters included", () => {
    expect(locate("/@fs/work/tree/packages/ui/Button.tsx")).toEqual(refused("outside-workspace"));
    expect(locate("/@fs/work/tree/apps/web/src/Card.tsx")).toEqual(at("apps/web/src/Card.tsx"));
    expect(locate("/@fs/C:/work/tree/apps/web/src/Card.tsx", null, windows)).toEqual(
      at("apps/web/src/Card.tsx")
    );
    expect(locate("/@fs/work/tree/apps/web/src/My%20Card.tsx")).toEqual(
      at("apps/web/src/My Card.tsx")
    );
  });

  it("reads Windows and file: paths as paths, never as dev-server URLs", () => {
    expect(locate("C:\\work\\tree\\apps\\web\\src\\Card.tsx", null, windows)).toEqual(
      at("apps/web/src/Card.tsx")
    );
    // Case-insensitive, as the filesystem is.
    expect(locate("c:/Work/Tree/apps/web/src/Card.tsx", null, windows)).toEqual(
      at("apps/web/src/Card.tsx")
    );
    expect(locate("file:///C:/work/tree/apps/web/src/Card.tsx", null, windows)).toEqual(
      at("apps/web/src/Card.tsx")
    );
    expect(locate("file:///work/tree/apps/web/src/Card%20Two.tsx")).toEqual(
      at("apps/web/src/Card Two.tsx")
    );
    // A Windows path on a POSIX host names nothing here.
    expect(locate("C:\\work\\tree\\apps\\web\\src\\Card.tsx")).toEqual(
      refused("outside-workspace")
    );
    expect(locate("\\\\fileserver\\share\\Card.tsx", null, windows)).toEqual(
      refused("outside-workspace")
    );
  });

  it("reads a rooted source as an absolute path only when it lands inside the worktree", () => {
    expect(locate("/work/tree/apps/web/src/Card.tsx")).toEqual(at("apps/web/src/Card.tsx"));
    expect(locate("/srv/app/src/Card.tsx")).toEqual(at("apps/web/srv/app/src/Card.tsx"));
  });

  it("refuses virtual modules and schemes that name no file", () => {
    for (const source of [
      "\0virtual:my-module",
      "/@id/__x00__virtual:my-module",
      "/@id/virtual:routes",
      "/@vite/client",
      "/@react-refresh",
      "webpack://_N_E/./src/Card.tsx",
      "turbopack:///[project]/src/Card.tsx",
      "virtual:routes",
      "",
    ]) {
      expect(locate(source), source).toEqual(refused("unsupported"));
    }
  });

  it("refuses a source on another origin, or one that climbs out of the app", () => {
    expect(locate("http://cdn.example.com/src/Card.tsx")).toEqual(refused("outside-workspace"));
    expect(locate("//cdn.example.com/src/Card.tsx")).toEqual(refused("outside-workspace"));
    expect(locate("http://localhost:5174/src/Card.tsx")).toEqual(refused("outside-workspace"));
    expect(locate("/@fs/etc/passwd")).toEqual(refused("outside-workspace"));
    expect(locate("/@fs/work/tree/apps/web/src/%2E%2E/%2E%2E/%2E%2E/secret.txt")).toEqual(
      refused("outside-workspace")
    );
    expect(locate("/@fs/work/tree/apps/web/src/..%2F..%2F..%2Fsecret.txt")).toEqual(
      refused("outside-workspace")
    );
    expect(locate("file:///etc/passwd")).toEqual(refused("outside-workspace"));
    // The app root itself is not a file in it.
    expect(locate("/@fs/work/tree/apps/web")).toEqual(refused("outside-workspace"));
  });

  it("refuses an encoding it cannot read and control characters that survive decoding", () => {
    expect(locate("/src/%E0%A4%A.tsx")).toEqual(refused("unsupported"));
    expect(locate("/src/Card%00.tsx")).toEqual(refused("unsupported"));
  });
});

describe("locateMapSource on a Next.js page", () => {
  const next: MapSourceContext = { ...posix, nextjs: true };

  it("reads a Webpack module identity as a file in the app, as Next.js's overlay does", () => {
    expect(locate("webpack://_N_E/./app/page.tsx?7c1e", null, next)).toEqual(
      at("apps/web/app/page.tsx")
    );
    expect(locate("webpack-internal:///(rsc)/./app/page.tsx", null, next)).toEqual(
      at("apps/web/app/page.tsx")
    );
    expect(locate("webpack://_N_E/../../../etc/passwd", null, next)).toEqual(
      refused("outside-workspace")
    );
  });

  it("reads Turbopack's project root as the worktree when that lands in the app, and as the app otherwise", () => {
    // A monorepo's lockfile at the top makes the repository Turbopack's project.
    expect(locate("turbopack:///[project]/apps/web/app/page.tsx", null, next)).toEqual(
      at("apps/web/app/page.tsx")
    );
    // An app with a lockfile of its own is its own project.
    expect(locate("[project]/app/page.tsx", null, next)).toEqual(at("apps/web/app/page.tsx"));
    expect(locate("turbopack:///[project]/../secret.txt", null, next)).toEqual(
      refused("outside-workspace")
    );
  });

  it("still names no file for a module that is not one", () => {
    expect(locate("turbopack:///[turbopack]/runtime.ts", null, next)).toEqual(
      refused("unsupported")
    );
    expect(locate("virtual:routes", null, next)).toEqual(refused("unsupported"));
  });
});

describe("locateMapSource for a map read from disk", () => {
  const disk: MapSourceContext = {
    ...posix,
    base: "file:///work/tree/apps/web/.next/dev/server/chunks/ssr/%5Bpage%5D.js.map",
  };

  it("reads a relative source from where the map lies", () => {
    expect(locate("../../../../../app/page.tsx", null, disk)).toEqual(at("apps/web/app/page.tsx"));
    expect(locate("../../../../../../../outside.ts", null, disk)).toEqual(
      refused("outside-workspace")
    );
  });

  it("names nothing on the network from a map that was never there", () => {
    expect(locate("//cdn.example.com/a.ts", null, disk)).toEqual(refused("unsupported"));
  });
});
