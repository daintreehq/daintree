import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import type { ProjectContext } from "../../../../../shared/elementPicker/projectContext.js";
import type { SourceTracker } from "../../sourceTracker.js";
import type { PickerWorkspace } from "../../workspaceRegistry.js";
import { PROJECT_CONTEXT_ADMISSION, ProjectContextService } from "../projectContext.js";
import type {
  ProjectAdapter,
  ProjectAdapterRegistration,
  ProjectContextRequest,
} from "../types.js";

const CONTEXT: ProjectContext = {
  adapter: "sveltekit",
  appPath: ".",
  route: null,
  routes: { directory: "src/routes", source: "default", basePath: "", complete: true },
  toolchain: {
    versions: { svelte: "5.1.0", kit: "2.8.0", tailwind: null, vite: null },
    verdict: "tested",
    reasons: [],
    missingInstall: [],
  },
  diagnostics: [],
};

const never = <T>() => new Promise<T>(() => {});

let root: string;

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picker-context-")));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } })
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function workspaceAt(appRoot = root): PickerWorkspace {
  return {
    id: "ws-1",
    roots: { worktreePath: root, appRoot },
    previewOrigin: null,
    lifetime: new AbortController(),
    tracker: { dispose() {} } as unknown as SourceTracker,
  };
}

function registration(
  describe: ProjectAdapter["describe"],
  overrides: Partial<ProjectAdapterRegistration> = {}
): ProjectAdapterRegistration {
  return {
    id: "sveltekit",
    detects: () => true,
    load: async () => ({ describe }),
    ...overrides,
  };
}

function service(adapter: ProjectAdapterRegistration, deadlineMs = 2_000) {
  return new ProjectContextService({ adapters: [adapter], deadlineMs });
}

describe("ProjectContextService", () => {
  it("hands the adapter the app, the URL's path and a reader, and returns its reading", async () => {
    const seen: ProjectContextRequest[] = [];
    const workspace = workspaceAt();
    const outcome = await service(
      registration(async (request) => {
        seen.push(request);
        expect(await request.reader.readFile(path.join(root, "package.json"))).toContain("kit");
        return CONTEXT;
      })
    ).describe(workspace, "http://localhost:5173/blog/hello?draft=1#top");

    expect(outcome).toEqual({ status: "described", context: CONTEXT });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      workspaceId: "ws-1",
      roots: workspace.roots,
      pathname: "/blog/hello",
    });
  });

  it("reads none when no adapter recognises the app, without loading any", async () => {
    const load = vi.fn(async () => ({ describe: async () => CONTEXT }));

    await expect(
      service(registration(async () => CONTEXT, { detects: () => false, load })).describe(
        workspaceAt(),
        "http://localhost/"
      )
    ).resolves.toEqual({ status: "none" });
    expect(load).not.toHaveBeenCalled();
  });

  it("reads none for an app with no readable manifest", async () => {
    fs.mkdirSync(path.join(root, "bare"));
    const detects = vi.fn(() => true);

    await expect(
      service(registration(async () => CONTEXT, { detects })).describe(
        workspaceAt(path.join(root, "bare")),
        "http://localhost/"
      )
    ).resolves.toEqual({ status: "none" });
    expect(detects).not.toHaveBeenCalled();
  });

  it("turns an adapter that throws into an outcome", async () => {
    await expect(
      service(
        registration(async () => {
          throw new Error("route parser exploded");
        })
      ).describe(workspaceAt(), "http://localhost/")
    ).resolves.toEqual({ status: "unavailable", reason: "failed" });
  });

  it("refuses a reading outside the contract", async () => {
    await expect(
      service(registration(async () => ({ ...CONTEXT, appPath: "" }) as ProjectContext)).describe(
        workspaceAt(),
        "http://localhost/"
      )
    ).resolves.toEqual({ status: "unavailable", reason: "failed" });
  });

  it("settles at its deadline when an adapter never answers", async () => {
    const started = performance.now();

    await expect(
      service(
        registration(() => never()),
        50
      ).describe(workspaceAt(), "http://localhost/")
    ).resolves.toEqual({ status: "unavailable", reason: "budget-exhausted" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("counts loading the adapter against the deadline", async () => {
    await expect(
      service(
        registration(async () => CONTEXT, { load: () => never() }),
        50
      ).describe(workspaceAt(), "http://localhost/")
    ).resolves.toEqual({ status: "unavailable", reason: "budget-exhausted" });
  });

  it("is cancelled by its caller and by its workspace closing", async () => {
    const hanging = service(
      registration(() => never()),
      60_000
    );
    const caller = new AbortController();
    const byCaller = hanging.describe(workspaceAt(), "http://localhost/", caller.signal);
    const workspace = workspaceAt();
    const byWorkspace = hanging.describe(workspace, "http://localhost/");

    caller.abort();
    workspace.lifetime.abort();

    await expect(byCaller).resolves.toEqual({ status: "unavailable", reason: "cancelled" });
    await expect(byWorkspace).resolves.toEqual({ status: "unavailable", reason: "cancelled" });
  });

  it("aborts the adapter's reads once the request has settled", async () => {
    let entered!: (signal: AbortSignal) => void;
    const entry = new Promise<AbortSignal>((resolve) => (entered = resolve));
    const caller = new AbortController();
    // A deadline far off, so only the caller's abort can end this request.
    const pending = service(
      registration(async (request) => {
        entered(request.signal);
        return never();
      }),
      60_000
    ).describe(workspaceAt(), "http://localhost/", caller.signal);

    const signal = await entry;
    expect(signal.aborted).toBe(false);
    caller.abort();

    await expect(pending).resolves.toEqual({ status: "unavailable", reason: "cancelled" });
    expect(signal.aborted).toBe(true);
  });

  it("frees a hung adapter's slot at the deadline, so hangs cannot wedge later requests", async () => {
    const deadlineMs = 1_000;
    let entered = 0;
    let allEntered!: () => void;
    const slotsHeld = new Promise<void>((resolve) => (allEntered = resolve));
    // Only the deadline's timer is faked: the manifest reads are real I/O and
    // must finish on their own before the deadline is moved.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hangs = service(
        registration(async ({ pathname }) => {
          if (pathname !== "/hang") return CONTEXT;
          if (++entered === PROJECT_CONTEXT_ADMISSION.concurrent) allEntered();
          return never();
        }),
        deadlineMs
      );
      const hung = Array.from({ length: PROJECT_CONTEXT_ADMISSION.concurrent }, () =>
        hangs.describe(workspaceAt(), "http://localhost/hang")
      );
      // Every slot is held by an adapter that will never answer.
      await slotsHeld;
      vi.advanceTimersByTime(deadlineMs);

      await expect(Promise.all(hung)).resolves.toEqual(
        hung.map(() => ({ status: "unavailable", reason: "budget-exhausted" }))
      );
      await expect(hangs.describe(workspaceAt(), "http://localhost/")).resolves.toEqual({
        status: "described",
        context: CONTEXT,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses rather than queueing past its limit", async () => {
    const busy = service(
      registration(() => never()),
      60_000
    );
    const caller = new AbortController();
    const held = Array.from(
      { length: PROJECT_CONTEXT_ADMISSION.concurrent + PROJECT_CONTEXT_ADMISSION.queued },
      () => busy.describe(workspaceAt(), "http://localhost/", caller.signal)
    );
    await expect(busy.describe(workspaceAt(), "http://localhost/")).resolves.toEqual({
      status: "unavailable",
      reason: "busy",
    });

    caller.abort();
    await expect(Promise.all(held)).resolves.toEqual(
      held.map(() => ({ status: "unavailable", reason: "cancelled" }))
    );
  });

  it("tries a failed load again on the next request", async () => {
    let attempts = 0;
    const flaky = service(
      registration(async () => CONTEXT, {
        load: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("chunk missing");
          return { describe: async () => CONTEXT };
        },
      })
    );

    await expect(flaky.describe(workspaceAt(), "http://localhost/")).resolves.toEqual({
      status: "unavailable",
      reason: "failed",
    });
    await expect(flaky.describe(workspaceAt(), "http://localhost/")).resolves.toEqual({
      status: "described",
      context: CONTEXT,
    });
    await flaky.describe(workspaceAt(), "http://localhost/");
    expect(attempts).toBe(2);
  });
});
