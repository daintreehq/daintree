import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  PROJECT_SHELL_FILE_PLACEHOLDER,
  projectShellChunkPlugin,
  rewriteProjectShellPlaceholder,
} from "./vite-project-shell.ts";
import {
  PROJECT_SHELL_CHUNK_NAME,
  PROJECT_SHELL_SOURCE,
} from "../../shared/config/projectShell.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const SHELL_FILE = "assets/project-shell-Ab3_x-9Z.js";

type Hook = (this: unknown, ...args: unknown[]) => unknown;

function hook(plugin: ReturnType<typeof projectShellChunkPlugin>, name: string): Hook {
  return (plugin as unknown as Record<string, Hook>)[name]!;
}

interface FakeChunk {
  type: "chunk";
  fileName: string;
  name: string;
  isEntry: boolean;
  code: string;
}

/**
 * Drives the plugin's hooks the way a build would. `shell` overrides the
 * emitted shell chunk (`null` leaves it out); `added` are chunks that reach the
 * bundle without passing through renderChunk, as a later transform's would.
 */
function runBuild(
  rendered: Array<{ fileName: string; code: string }>,
  { shell, added = [] }: { shell?: Partial<FakeChunk> | null; added?: FakeChunk[] } = {}
) {
  const plugin = projectShellChunkPlugin();
  const emitted: unknown[] = [];
  hook(plugin, "configResolved").call(undefined, { root: REPO });
  hook(plugin, "buildStart").call({
    emitFile: (file: unknown) => {
      emitted.push(file);
      return "shell-ref";
    },
  });
  const renderContext = { getFileName: (ref: string) => (ref === "shell-ref" ? SHELL_FILE : "") };
  const bundle: Record<string, FakeChunk> = {};
  for (const chunk of rendered) {
    const result = hook(plugin, "renderChunk").call(renderContext, chunk.code, chunk) as {
      code: string;
    } | null;
    bundle[chunk.fileName] = {
      type: "chunk",
      fileName: chunk.fileName,
      name: path.posix.basename(chunk.fileName, ".js"),
      isEntry: false,
      code: result?.code ?? chunk.code,
    };
  }
  if (shell !== null) {
    bundle[SHELL_FILE] = {
      type: "chunk",
      fileName: SHELL_FILE,
      name: PROJECT_SHELL_CHUNK_NAME,
      isEntry: true,
      code: "",
      ...shell,
    };
  }
  for (const chunk of added) bundle[chunk.fileName] = chunk;
  const errors: string[] = [];
  hook(plugin, "generateBundle").call(
    {
      error: (message: string) => {
        errors.push(message);
        throw new Error(message);
      },
    },
    {},
    bundle
  );
  return { emitted, bundle, errors };
}

describe("rewriteProjectShellPlaceholder", () => {
  it("leaves a chunk without the placeholder alone", () => {
    expect(rewriteProjectShellPlaceholder("const a = 1;", "assets/boot.js", SHELL_FILE)).toBeNull();
  });

  it("points at the shell relative to the chunk that resolves it", () => {
    const code = `new URL("${PROJECT_SHELL_FILE_PLACEHOLDER}", import.meta.url)`;
    expect(rewriteProjectShellPlaceholder(code, "assets/boot-1.js", SHELL_FILE)).toBe(
      'new URL("./project-shell-Ab3_x-9Z.js", import.meta.url)'
    );
    expect(rewriteProjectShellPlaceholder(code, "assets/nested/boot-1.js", SHELL_FILE)).toBe(
      'new URL("../project-shell-Ab3_x-9Z.js", import.meta.url)'
    );
  });
});

describe("projectShellChunkPlugin", () => {
  it("rewrites the placeholder that src/projectWindow/projectShellUrl.ts carries", () => {
    // The two sides only meet in a build; a renamed placeholder would otherwise
    // surface as a failed build in CI rather than here.
    const source = readFileSync(path.join(REPO, "src/projectWindow/projectShellUrl.ts"), "utf8");
    expect(source).toContain(`"${PROJECT_SHELL_FILE_PLACEHOLDER}"`);
  });

  it("emits the shell source as a named entry chunk", () => {
    const { emitted } = runBuild([
      { fileName: "assets/boot-1.js", code: `"${PROJECT_SHELL_FILE_PLACEHOLDER}"` },
    ]);
    expect(emitted).toEqual([
      {
        type: "chunk",
        id: path.resolve(REPO, PROJECT_SHELL_SOURCE),
        name: PROJECT_SHELL_CHUNK_NAME,
      },
    ]);
  });

  it("passes a build where exactly one chunk carried the placeholder", () => {
    const { bundle, errors } = runBuild([
      { fileName: "assets/boot-1.js", code: `x="${PROJECT_SHELL_FILE_PLACEHOLDER}"` },
      { fileName: "assets/boot-2.js", code: "y=1" },
    ]);
    expect(errors).toEqual([]);
    expect(bundle["assets/boot-1.js"]!.code).toBe('x="./project-shell-Ab3_x-9Z.js"');
  });

  it("fails a build where no chunk carried the placeholder", () => {
    expect(() => runBuild([{ fileName: "assets/boot-1.js", code: "y=1" }])).toThrow(
      /expected one chunk to carry the project shell URL/
    );
  });

  it("fails a build where two chunks carried the placeholder", () => {
    // Two copies mean the URL module was split or duplicated; at most one of
    // them is the binding main.tsx reads, so the build can't vouch for it.
    expect(() =>
      runBuild([
        { fileName: "assets/boot-1.js", code: `"${PROJECT_SHELL_FILE_PLACEHOLDER}"` },
        { fileName: "assets/boot-2.js", code: `"${PROJECT_SHELL_FILE_PLACEHOLDER}"` },
      ])
    ).toThrow(/expected one chunk to carry the project shell URL.*found 2/);
  });

  it("fails a build where a placeholder reaches the bundle after rendering", () => {
    expect(() =>
      runBuild([{ fileName: "assets/boot-1.js", code: `"${PROJECT_SHELL_FILE_PLACEHOLDER}"` }], {
        added: [
          {
            type: "chunk",
            fileName: "assets/late-1.js",
            name: "late",
            isEntry: false,
            code: `"${PROJECT_SHELL_FILE_PLACEHOLDER}"`,
          },
        ],
      })
    ).toThrow(/placeholder survived in assets\/late-1\.js/);
  });

  it("fails a build where the shell chunk is not an entry", () => {
    expect(() =>
      runBuild([{ fileName: "assets/boot-1.js", code: `"${PROJECT_SHELL_FILE_PLACEHOLDER}"` }], {
        shell: { isEntry: false },
      })
    ).toThrow(/no entry chunk named "project-shell"/);
  });

  it("fails a build with no shell chunk at all", () => {
    expect(() =>
      runBuild([{ fileName: "assets/boot-1.js", code: `"${PROJECT_SHELL_FILE_PLACEHOLDER}"` }], {
        shell: null,
      })
    ).toThrow(/no entry chunk named "project-shell"/);
  });
});
