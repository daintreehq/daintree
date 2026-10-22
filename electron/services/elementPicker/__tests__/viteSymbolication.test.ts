import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { COORDINATE_CONVENTIONS } from "../../../../shared/elementPicker/coordinates.js";
import type {
  HostSourceResolver,
  ResolveResponse,
} from "../../../../shared/elementPicker/resolver.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import { ElementPickerHost } from "../ElementPickerHost.js";
import { observationCandidates, unavailableResult } from "../outcomes.js";
import { revisionOf } from "../sourceAccess.js";
import { createSourceMapSymbolicator, symbolicatedResult } from "../worker/symbolication.js";
import { RuntimeChild, observation, request } from "./fixtures.js";

/**
 * A generated frame from a real Vite 8 React dev server, mapped end to end:
 * main fetches the module from the preview origin, the host process decodes
 * its inline map, and main says which workspace file the source is.
 */

const REPO_NODE_MODULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../node_modules"
);

const CARD = [
  'import { useState } from "react";',
  "",
  "export function Card({ title }: { title: string }) {",
  "  const [open, setOpen] = useState(false);",
  "  return (",
  '    <section className="card" onClick={() => setOpen(!open)}>',
  '      <h2 className="card-title">{title}</h2>',
  "    </section>",
  "  );",
  "}",
  "",
].join("\n");

let root: string;
let cardPath: string;
let server: ViteDevServer;
let origin: string;
let host: ElementPickerHost;
let workspaceId: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** What React's resolver will do with a `_debugStack` frame, as far as mapping goes. */
function symbolicatingResolver(): HostSourceResolver {
  return {
    framework: "react",
    async resolve(req, access, signal): Promise<ResolveResponse> {
      const symbolicator = createSourceMapSymbolicator(access);
      return {
        requestId: req.requestId,
        documentEpoch: req.documentEpoch,
        outcomes: await Promise.all(
          req.observations.map(async (obs) => ({
            elementId: obs.elementId,
            results: await Promise.all(
              observationCandidates(obs).map(async (candidate) =>
                candidate.kind === "file-hint"
                  ? unavailableResult(candidate, "unsupported")
                  : symbolicatedResult(
                      candidate,
                      await symbolicator.symbolicate(
                        { url: candidate.file, location: candidate.location },
                        signal
                      )
                    )
              )
            ),
          }))
        ),
      };
    },
  };
}

/** Where `needle` first appears in `text`: 1-based line, 0-based column. */
function positionOf(text: string, needle: string): { line: number; column: number } {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  if (index === -1) throw new Error(`${needle} is not in the text`);
  return { line: index + 1, column: lines[index]!.indexOf(needle) };
}

/** The frame a `jsxDEV` call for `<h2>` reports: V8 numbers both from 1. */
async function h2Frame(): Promise<SourceCandidate> {
  const url = `${origin}/src/Card.tsx?t=${Date.now()}`;
  const served = await (await fetch(url)).text();
  const call = positionOf(served, 'jsxDEV("h2"');
  return {
    kind: "element-creation",
    candidateId: "c-1",
    framework: "react",
    extraction: { kind: "generated-stack-frame", field: "_debugStack", frameIndex: 1 },
    file: url,
    location: {
      ...COORDINATE_CONVENTIONS.v8StackFrame,
      columnUnit: "utf16",
      line: call.line,
      column: call.column + 1,
    },
  };
}

async function resolveFrame(frame: SourceCandidate) {
  const response = await host.resolve(request(workspaceId, [observation("el-1", [frame])]));
  return response.outcomes[0]!.results[0]!;
}

function authoredH2(text: string) {
  return {
    ...COORDINATE_CONVENTIONS.sourceMap,
    columnUnit: "utf16",
    ...positionOf(text, "<h2"),
  };
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picker-vite-")));
  fs.mkdirSync(path.join(root, "src"));
  cardPath = path.join(root, "src", "Card.tsx");
  fs.writeFileSync(cardPath, CARD);
  fs.symlinkSync(REPO_NODE_MODULES, path.join(root, "node_modules"), "junction");

  const port = await freePort();
  server = await createServer({
    root,
    configFile: false,
    envFile: false,
    logLevel: "silent",
    cacheDir: path.join(root, ".vite"),
    plugins: [react()],
    // No watcher: the test decides when the dev server notices an edit.
    server: { host: "127.0.0.1", port, strictPort: true, watch: null },
    // Pre-bundling React changes nothing about Card.tsx's own map, and an
    // optimizer run still in flight holds `close()` open under vitest.
    optimizeDeps: { disabled: true },
  });
  await server.listen();
  origin = `http://127.0.0.1:${port}`;

  host = new ElementPickerHost({
    fork: () => new RuntimeChild({ react: async () => symbolicatingResolver() }),
    kill: vi.fn(),
    watch: () => () => undefined,
    idleMs: 60_000,
  });
  workspaceId = await host.registerWorkspace({
    worktreePath: root,
    previewOrigin: origin,
    onSourceChanged: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await host?.dispose();
  await server?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("symbolication against a real Vite 8 React dev server", () => {
  let firstMap: string;

  it("maps a generated frame to the authored file and line", async () => {
    const result = await resolveFrame(await h2Frame());
    expect(result).toEqual({
      state: "mapped",
      candidateId: "c-1",
      claim: "element-creation",
      target: { file: { workspaceId, path: "src/Card.tsx" }, location: authoredH2(CARD) },
      fileRevision: revisionOf(fs.readFileSync(cardPath)),
      sourceMap: {
        mapUrl: null,
        mapRevision: expect.stringMatching(/^sha256:/),
        sourceCheck: "matches",
      },
    });
    firstMap = result.state === "mapped" ? result.sourceMap.mapRevision : "";
  });

  it("calls the mapping stale once the file changes under a map the server has not rebuilt", async () => {
    const frame = await h2Frame();
    const edited = `// edited\n// again\n${CARD}`;
    fs.writeFileSync(cardPath, edited);
    const result = await resolveFrame(frame);
    expect(result).toMatchObject({
      state: "stale",
      reason: "file-changed",
      currentFileRevision: revisionOf(fs.readFileSync(cardPath)),
      held: {
        state: "mapped",
        target: { location: authoredH2(CARD) },
        sourceMap: { mapRevision: firstMap, sourceCheck: "differs" },
      },
    });
  });

  it("maps through the new map once the update reaches the server", async () => {
    server.watcher.emit("change", cardPath);
    const edited = fs.readFileSync(cardPath, "utf8");
    const result = await resolveFrame(await h2Frame());
    expect(result).toMatchObject({
      state: "mapped",
      target: { file: { path: "src/Card.tsx" }, location: authoredH2(edited) },
      sourceMap: { sourceCheck: "matches" },
    });
    expect(result.state === "mapped" && result.sourceMap.mapRevision).not.toBe(firstMap);
    expect(authoredH2(edited).line).toBe(authoredH2(CARD).line + 2);
  });

  it("fetches nothing for a frame from another origin", async () => {
    const frame = await h2Frame();
    const foreign = { ...frame, file: frame.file.replace("127.0.0.1", "localhost") };
    await expect(resolveFrame(foreign)).resolves.toMatchObject({
      state: "unavailable",
      reason: "outside-workspace",
    });
  });
});
