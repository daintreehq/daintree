import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { ElementPickerHost, type ElementPickerHostOptions } from "../ElementPickerHost.js";
import type {
  HostSourceResolver,
  ResolveResponse,
} from "../../../../shared/elementPicker/resolver.js";
import type { ResolverLoaders } from "../worker/runtime.js";
import type { SourceChange } from "../sourceTracker.js";
import { revisionOf, type SourceMapProvider } from "../sourceAccess.js";
import { createSourceMapSymbolicator, symbolicatedResult } from "../worker/symbolication.js";
import { COORDINATE_CONVENTIONS } from "../../../../shared/elementPicker/coordinates.js";
import type { SourceCandidate } from "../../../../shared/elementPicker/source.js";
import {
  RuntimeChild,
  STUB_MARKER,
  type RuntimeChildOptions,
  candidate,
  observation,
  request,
  stallingResolver,
  stubResolver,
} from "./fixtures.js";

let root: string;
const hosts: ElementPickerHost[] = [];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picker-host-")));
  fs.mkdirSync(path.join(root, "app", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "other"), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "src", "App.svelte"), `<h1>${STUB_MARKER}</h1>`);
  fs.writeFileSync(path.join(root, "app", "src", "Plain.svelte"), "<p>plain</p>");
  fs.writeFileSync(path.join(root, "other", "Elsewhere.svelte"), `<p>${STUB_MARKER}</p>`);
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  fs.rmSync(root, { recursive: true, force: true });
});

interface Harness {
  host: ElementPickerHost;
  children: RuntimeChild[];
  kill: ReturnType<typeof vi.fn>;
  watched: Map<string, (changedPath: string) => void>;
}

function harness(
  loaders: ResolverLoaders | (() => ResolverLoaders) = { svelte: async () => stubResolver() },
  options: ElementPickerHostOptions & { child?: RuntimeChildOptions } = {}
): Harness {
  const children: RuntimeChild[] = [];
  const watched = new Map<string, (changedPath: string) => void>();
  const kill = vi.fn((pid: number) => children.find((child) => child.pid === pid)?.exit(9));
  const host = new ElementPickerHost({
    fork: () => {
      const child = new RuntimeChild(
        typeof loaders === "function" ? loaders() : loaders,
        options.child
      );
      children.push(child);
      return child;
    },
    kill,
    watch: (directory, onChange) => {
      watched.set(directory, onChange);
      return () => watched.delete(directory);
    },
    idleMs: 60_000,
    ...options,
  });
  hosts.push(host);
  return { host, children, kill, watched };
}

async function workspace(
  host: ElementPickerHost,
  onSourceChanged: (change: SourceChange) => void = () => {}
): Promise<string> {
  return host.registerWorkspace({
    worktreePath: root,
    appRoot: path.join(root, "app"),
    onSourceChanged,
  });
}

function sha256(file: string): string {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

/** Captures a rejection the moment the call is made, so it is never unhandled while a test waits. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

function results(response: ResolveResponse) {
  return response.outcomes.flatMap((outcome) => outcome.results);
}

describe("ElementPickerHost", () => {
  it("round-trips a stub resolver through the host, which reads the bytes main served", async () => {
    const { host, children } = harness();
    const id = await workspace(host);
    expect(host.running).toBe(false);
    expect(children).toHaveLength(0);

    const response = await host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-1", "app/src/App.svelte"),
          candidate("c-2", "app/src/Plain.svelte"),
        ]),
      ])
    );

    expect(children).toHaveLength(1);
    expect(results(response)).toEqual([
      {
        state: "verified",
        candidateId: "c-1",
        claim: "file-hint",
        target: { file: { workspaceId: id, path: "app/src/App.svelte" }, location: null },
        fileRevision: sha256(path.join(root, "app", "src", "App.svelte")),
      },
      {
        state: "unavailable",
        candidateId: "c-2",
        claim: "file-hint",
        reason: "mismatch",
        read: {
          file: { workspaceId: id, path: "app/src/Plain.svelte" },
          fileRevision: sha256(path.join(root, "app", "src", "Plain.svelte")),
        },
      },
    ]);
  });

  it("refuses reads outside the app root without reading them", async () => {
    const { host } = harness();
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [
        observation("el-1", [
          candidate("c-1", "other/Elsewhere.svelte"),
          candidate("c-2", "app/src/Missing.svelte"),
        ]),
      ])
    );
    expect(
      results(response).map((result) => result.state === "unavailable" && result.reason)
    ).toEqual(["outside-workspace", "file-missing"]);
  });

  it("starts one host for concurrent resolves and loads only the frameworks requested", async () => {
    const react = vi.fn(async () => stubResolver("react"));
    const { host, children } = harness({ svelte: async () => stubResolver(), react });
    const id = await workspace(host);
    const [first, second] = await Promise.all([
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])),
      host.resolve(
        request(id, [observation("el-2", [candidate("c-2", "app/src/App.svelte", "vue")])])
      ),
    ]);
    expect(children).toHaveLength(1);
    expect(results(first)[0]?.state).toBe("verified");
    expect(results(second)).toEqual([
      { state: "unavailable", candidateId: "c-2", claim: "file-hint", reason: "unsupported" },
    ]);
    expect(react).not.toHaveBeenCalled();
  });

  it("retires an idle host and forks a fresh one for the next resolve", async () => {
    const { host, children } = harness(undefined, { idleMs: 20 });
    const id = await workspace(host);
    const ask = () =>
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]));

    await ask();
    await vi.waitFor(() => expect(children[0]?.alive).toBe(false));
    expect(children[0]?.posted).toContain("dispose");
    expect(host.running).toBe(false);

    const again = await ask();
    expect(children).toHaveLength(2);
    expect(results(again)[0]?.state).toBe("verified");
  });

  it("fails the jobs a crashed host held and recovers on the next resolve", async () => {
    let generation = 0;
    const { host, children } = harness(() => {
      generation += 1;
      return generation === 1
        ? { svelte: async () => stallingResolver(false) }
        : { svelte: async () => stubResolver() };
    });
    const id = await workspace(host);
    const ask = () =>
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]));

    const stuck = failure(ask());
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    children[0]!.exit(1);
    expect(await stuck).toMatchObject({ code: "HOST_CRASHED" });
    expect(host.running).toBe(false);

    const recovered = await ask();
    expect(children).toHaveLength(2);
    expect(results(recovered)[0]?.state).toBe("verified");
  });

  it("fails a host that exits before it is ready with HOST_START_FAILED", async () => {
    const { host, children } = harness(undefined, { child: { start: false } });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(1);
    expect(await pending).toMatchObject({ code: "HOST_START_FAILED" });
  });

  it("retires a host that never becomes ready, killing it once the backstop lapses", async () => {
    const { host, children, kill } = harness(undefined, {
      child: { ready: false, ignoreDispose: true },
      startTimeoutMs: 20,
      disposeKillMs: 20,
    });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    expect(await pending).toMatchObject({ code: "HOST_START_FAILED" });
    expect(host.running).toBe(false);
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(children[0]!.pid));
    expect(children[0]?.alive).toBe(false);
  });

  it("kills a retired host that had no pid yet as soon as it spawns", async () => {
    const { host, children, kill } = harness(undefined, {
      child: { start: false, ignoreDispose: true },
      startTimeoutMs: 10,
      disposeKillMs: 10,
    });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    expect(await pending).toMatchObject({ code: "HOST_START_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(kill).not.toHaveBeenCalled();
    children[0]!.start();
    expect(kill).toHaveBeenCalledWith(children[0]!.pid);
  });

  // The deadline runs from admission, so each window below is wide enough for
  // a cold start, and each test proves the resolver was reached before it.
  it("answers budget-exhausted at the deadline and retires a host that ignores the cancel", async () => {
    let entered = false;
    const { host, children } = harness(
      { svelte: async () => stallingResolver(false, () => (entered = true)) },
      { cancelGraceMs: 20 }
    );
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])], {
        deadlineMs: 600,
      })
    );
    expect(entered).toBe(true);
    expect(results(response)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "budget-exhausted" },
    ]);
    expect(children[0]?.posted).toContain("cancel");
    await vi.waitFor(() => expect(children[0]?.alive).toBe(false));
  });

  it("reports a cooperative resolver stopped by the deadline as out of budget, not cancelled", async () => {
    let entered = false;
    const { host, children } = harness({
      svelte: async () => stallingResolver(true, () => (entered = true)),
    });
    const id = await workspace(host);
    const response = await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])], {
        deadlineMs: 600,
      })
    );
    expect(entered).toBe(true);
    expect(results(response)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "budget-exhausted" },
    ]);
    // The grace fallback retires the host as it settles; still running means
    // the resolver's own answer is what came back.
    expect(host.running).toBe(true);
    expect(children[0]?.alive).toBe(true);
  });

  it("keeps a cancel a cancel when the deadline passes before the resolver answers it", async () => {
    let entered = false;
    // Honours the cancel, but only answers once the deadline has also passed.
    const slow: HostSourceResolver = {
      framework: "svelte",
      resolve: (req, _access, signal) =>
        new Promise((resolve) => {
          entered = true;
          signal.addEventListener("abort", () =>
            setTimeout(
              () =>
                resolve({
                  requestId: req.requestId,
                  documentEpoch: req.documentEpoch,
                  outcomes: [],
                }),
              1_200
            )
          );
        }),
    };
    const { host } = harness({ svelte: async () => slow }, { cancelGraceMs: 3_000 });
    const id = await workspace(host);
    const controller = new AbortController();
    const pending = host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])], {
        deadlineMs: 1_000,
      }),
      { signal: controller.signal }
    );
    // Cancelled as soon as it starts, answered only after the deadline has passed.
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort();
    expect(results(await pending)[0]).toMatchObject({ reason: "cancelled" });
    expect(host.running).toBe(true);
  });

  it("keeps a host that answers a cancel, with every unanswered candidate cancelled", async () => {
    const { host, children } = harness({ svelte: async () => stallingResolver(true) });
    const id = await workspace(host);
    const controller = new AbortController();
    const pending = host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]),
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    controller.abort();
    expect(results(await pending)).toEqual([
      { state: "unavailable", candidateId: "c-1", claim: "file-hint", reason: "cancelled" },
    ]);
    expect(children[0]?.alive).toBe(true);
    expect(host.running).toBe(true);
  });

  it("cancels a resolve whose workspace is released", async () => {
    const { host, children } = harness({ svelte: async () => stallingResolver(true) });
    const id = await workspace(host);
    const pending = host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])
    );
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    expect(host.releaseWorkspace(id)).toBe(true);
    expect(results(await pending)[0]).toMatchObject({ reason: "cancelled" });
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "UNKNOWN_WORKSPACE" });
  });

  it("rejects a resolver's answer that names another workspace's file", async () => {
    const forger: HostSourceResolver = {
      framework: "svelte",
      resolve: async (req) => ({
        requestId: req.requestId,
        documentEpoch: req.documentEpoch,
        outcomes: [
          {
            elementId: "el-1",
            results: [
              {
                state: "observed",
                candidateId: "c-1",
                claim: "file-hint",
                target: { file: { workspaceId: "elsewhere", path: "x.svelte" }, location: null },
                fileRevision: null,
              },
            ],
          },
        ],
      }),
    };
    const { host } = harness({ svelte: async () => forger });
    const id = await workspace(host);
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
    expect(host.running).toBe(true);
  });

  it("rejects a resolver's answer that claims a revision main never served", async () => {
    const liar: HostSourceResolver = {
      framework: "svelte",
      resolve: async (req) => ({
        requestId: req.requestId,
        documentEpoch: req.documentEpoch,
        outcomes: [
          {
            elementId: "el-1",
            results: [
              {
                state: "verified",
                candidateId: "c-1",
                claim: "file-hint",
                target: {
                  file: { workspaceId: req.workspaceId, path: "app/src/App.svelte" },
                  location: null,
                },
                fileRevision: `sha256:${"0".repeat(64)}`,
              },
            ],
          },
        ],
      }),
    };
    const { host } = harness({ svelte: async () => liar });
    const id = await workspace(host);
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
  });

  it("rejects a resolver's answer that names a file outside the app", async () => {
    const wanderer: HostSourceResolver = {
      framework: "svelte",
      resolve: async (req) => ({
        requestId: req.requestId,
        documentEpoch: req.documentEpoch,
        outcomes: [
          {
            elementId: "el-1",
            results: [
              {
                state: "observed",
                candidateId: "c-1",
                claim: "file-hint",
                target: {
                  file: { workspaceId: req.workspaceId, path: "other/Elsewhere.svelte" },
                  location: null,
                },
                fileRevision: null,
              },
            ],
          },
        ],
      }),
    };
    const { host } = harness({ svelte: async () => wanderer });
    const id = await workspace(host);
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
  });

  it("refuses a request whose observations share an element id, before forking", async () => {
    const { host, children } = harness();
    const id = await workspace(host);
    await expect(
      host.resolve(
        request(id, [
          observation("el-1", [candidate("c-1", "app/src/App.svelte")]),
          observation("el-1", [candidate("c-2", "app/src/App.svelte")]),
        ])
      )
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(children).toHaveLength(0);
  });

  it("retires a host that sends a malformed message", async () => {
    const { host, children } = harness({ svelte: async () => stallingResolver(false) });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    children[0]!.deliver({ type: "resolved", jobId: "not-a-number" });
    expect(await pending).toMatchObject({ code: "HOST_CRASHED" });
    await vi.waitFor(() => expect(children[0]?.alive).toBe(false));
  });

  it("tracks what a resolve read and reports a real change without waking the host", async () => {
    const changes: SourceChange[] = [];
    const { host, children, watched } = harness(undefined, { idleMs: 20 });
    const id = await workspace(host, (change) => changes.push(change));
    const file = path.join(root, "app", "src", "App.svelte");
    await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])
    );
    await vi.waitFor(() => expect(host.running).toBe(false));

    const onChange = watched.get(path.dirname(file));
    expect(onChange).toBeDefined();
    // An event for unchanged content first: the single push below proves it added none.
    onChange!(file);
    fs.writeFileSync(file, `<h2>${STUB_MARKER}</h2>`);
    onChange!(file);
    await vi.waitFor(() =>
      expect(changes).toEqual([
        { file: { workspaceId: id, path: "app/src/App.svelte" }, revision: sha256(file) },
      ])
    );
    expect(children).toHaveLength(1);
  });

  it("fails in-flight work on dispose and never forks again", async () => {
    const { host, children } = harness({ svelte: async () => stallingResolver(false) });
    const id = await workspace(host);
    const pending = failure(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    );
    await vi.waitFor(() => expect(children[0]?.posted).toContain("resolve"));
    await host.dispose();
    expect(await pending).toMatchObject({ code: "HOST_DISPOSED" });
    expect(children[0]?.alive).toBe(false);
    await expect(
      host.resolve(request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])]))
    ).rejects.toMatchObject({ code: "HOST_DISPOSED" });
    expect(children).toHaveLength(1);
  });

  it("maps a frame through a map main served, and rejects an answer citing one it did not", async () => {
    const module = "http://localhost:5173/src/App.svelte?t=1";
    const content = fs.readFileSync(path.join(root, "app", "src", "App.svelte"), "utf8");
    const text = JSON.stringify({
      version: 3,
      sources: ["App.svelte"],
      names: [],
      mappings: "AAAA",
      sourcesContent: [content],
    });
    const sourceMaps = vi.fn<SourceMapProvider>(async ({ generatedUrl, allowance }) => {
      allowance.request();
      return {
        ok: true,
        value: {
          url: null,
          base: generatedUrl,
          revision: revisionOf(new TextEncoder().encode(text)),
          text,
        },
      };
    });
    const frame: Extract<SourceCandidate, { kind: "element-creation" }> = {
      kind: "element-creation",
      candidateId: "c-1",
      framework: "svelte",
      extraction: { kind: "generated-stack-frame", field: "stack", frameIndex: 0 },
      file: module,
      location: { ...COORDINATE_CONVENTIONS.v8StackFrame, columnUnit: "utf16", line: 1, column: 1 },
    };
    const mapper = (forge: boolean): HostSourceResolver => ({
      framework: "svelte",
      resolve: async (req, access, signal) => {
        const symbolication = await createSourceMapSymbolicator(access).symbolicate(
          { url: frame.file, location: frame.location },
          signal
        );
        const result = symbolicatedResult(frame, symbolication);
        if (forge && result.state === "mapped") {
          result.sourceMap = { ...result.sourceMap, mapUrl: "http://localhost:5173/forged.map" };
        }
        return {
          requestId: req.requestId,
          documentEpoch: req.documentEpoch,
          outcomes: [{ elementId: "el-1", results: [result] }],
        };
      },
    });
    for (const forge of [false, true]) {
      const { host } = harness({ svelte: async () => mapper(forge) }, { sourceMaps });
      const id = await host.registerWorkspace({
        worktreePath: root,
        appRoot: path.join(root, "app"),
        previewOrigin: "http://localhost:5173/some/page",
        onSourceChanged: () => {},
      });
      const resolving = host.resolve(request(id, [observation("el-1", [frame])]));
      if (forge) {
        await expect(resolving).rejects.toMatchObject({ code: "RESOLVER_FAILED" });
        continue;
      }
      await expect(resolving).resolves.toMatchObject({
        outcomes: [
          {
            results: [
              {
                state: "mapped",
                target: { file: { workspaceId: id, path: "app/src/App.svelte" } },
                fileRevision: sha256(path.join(root, "app", "src", "App.svelte")),
                sourceMap: { mapUrl: null, sourceCheck: "matches" },
              },
            ],
          },
        ],
      });
      expect(sourceMaps).toHaveBeenLastCalledWith(
        expect.objectContaining({ previewOrigin: "http://localhost:5173", generatedUrl: module }),
        expect.anything()
      );
    }
  });

  it("fetches no map for a workspace registered without a preview origin", async () => {
    const sourceMaps = vi.fn<SourceMapProvider>();
    const fetched: unknown[] = [];
    const { host } = harness(
      {
        svelte: async () => ({
          framework: "svelte",
          resolve: async (req, access, signal) => {
            fetched.push(await access.fetchSourceMap("http://localhost:5173/a.js", signal));
            return { requestId: req.requestId, documentEpoch: req.documentEpoch, outcomes: [] };
          },
        }),
      },
      { sourceMaps }
    );
    const id = await workspace(host);
    await host.resolve(
      request(id, [observation("el-1", [candidate("c-1", "app/src/App.svelte")])])
    );
    expect(fetched).toEqual([{ ok: false, reason: "unsupported" }]);
    expect(sourceMaps).not.toHaveBeenCalled();
  });

  it("refuses a preview origin that is not a plain HTTP(S) origin", async () => {
    const { host } = harness();
    for (const previewOrigin of ["not a url", "file:///srv/app", "http://user:pw@localhost:5173"]) {
      await expect(
        host.registerWorkspace({ worktreePath: root, previewOrigin, onSourceChanged: () => {} }),
        previewOrigin
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("refuses a malformed request and an app root outside the worktree", async () => {
    const { host } = harness();
    await expect(host.resolve({ requestId: "r" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      host.registerWorkspace({
        worktreePath: path.join(root, "app"),
        appRoot: path.join(root, "other"),
        onSourceChanged: () => {},
      })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
