import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { WorktreeAttachment } from "../../../shared/types/worktree.js";
import { AttachmentService, ATTACHMENT_HOLDER_REMOVED_ERROR } from "../AttachmentService.js";
import {
  LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR,
  WorktreeLifecycleService,
  type AttachmentConfig,
  type RunCommandsOptions,
  type RunCommandsResult,
} from "../WorktreeLifecycleService.js";
import {
  FileProjectAttachmentStore,
  resolveProjectAttachmentsDir,
  type ProjectAttachmentRecords,
  type ProjectAttachmentStore,
} from "../projectAttachmentStore.js";
import type { WorktreeMonitor } from "../WorktreeMonitor.js";

const ROOT = "/repo";

interface FakeMonitor {
  id: string;
  path: string;
  name: string;
  branch: string | undefined;
  isRunning: boolean;
  hasInitialStatus: boolean;
  lifecycleCommandsNeedApproval: boolean | undefined;
  attachments: WorktreeAttachment[] | undefined;
  setLifecycleCommandsNeedApproval(value: boolean): void;
  setAttachments(value: WorktreeAttachment[] | undefined): void;
}

function fakeMonitor(id: string, branch: string): FakeMonitor {
  return {
    id,
    path: id,
    name: id.split("/").pop()!,
    branch,
    isRunning: true,
    hasInitialStatus: true,
    lifecycleCommandsNeedApproval: undefined,
    attachments: undefined,
    setLifecycleCommandsNeedApproval(value) {
      this.lifecycleCommandsNeedApproval = value;
    },
    setAttachments(value) {
      this.attachments = value;
    },
  };
}

class MemoryStore implements ProjectAttachmentStore {
  saved: ProjectAttachmentRecords = {};
  saves = 0;
  constructor(initial: ProjectAttachmentRecords = {}) {
    this.saved = structuredClone(initial);
  }
  async load(): Promise<ProjectAttachmentRecords> {
    return structuredClone(this.saved);
  }
  async save(_root: string, records: ProjectAttachmentRecords): Promise<void> {
    this.saves++;
    this.saved = structuredClone(records);
  }
}

type CommandScript = (command: string, options: RunCommandsOptions) => Partial<RunCommandsResult>;

interface Harness {
  service: AttachmentService;
  store: MemoryStore;
  monitors: Map<string, FakeMonitor>;
  ran: Array<{ command: string; cwd: string; env: Record<string, string> }>;
  emitted: string[];
  setScript(script: CommandScript): void;
  setApproved(value: boolean): void;
  setAttachments(value: Record<string, AttachmentConfig> | null): void;
}

const TUNNEL: AttachmentConfig = {
  attach: ["tunnel up {branch}"],
  detach: ["tunnel down"],
  status: "tunnel status",
};

async function createHarness(
  options: {
    stored?: ProjectAttachmentRecords;
    attachments?: Record<string, AttachmentConfig>;
  } = {}
): Promise<Harness> {
  const monitors = new Map<string, FakeMonitor>([
    ["/wt/a", fakeMonitor("/wt/a", "feature/a")],
    ["/wt/b", fakeMonitor("/wt/b", "feature/b")],
  ]);
  const ran: Harness["ran"] = [];
  const emitted: string[] = [];
  let script: CommandScript = () => ({ success: true });
  let approved = true;
  let attachments: Record<string, AttachmentConfig> | null = options.attachments ?? {
    tunnel: TUNNEL,
  };

  const lifecycle = new WorktreeLifecycleService("/home/none", {
    isApproved: async () => false,
    approve: async () => {},
  });
  vi.spyOn(lifecycle, "resolveAttachments").mockImplementation(async () =>
    attachments
      ? {
          resolved: {
            config: { attachments },
            origin: "project",
            path: `${ROOT}/.daintree/config.json`,
          },
          attachments,
        }
      : null
  );
  vi.spyOn(lifecycle, "isConfigApproved").mockImplementation(async () => approved);
  vi.spyOn(lifecycle, "runCommands").mockImplementation(async (commands, opts) => {
    let result: RunCommandsResult = { success: true, output: "" };
    for (const command of commands) {
      ran.push({ command, cwd: opts.cwd, env: opts.env });
      result = { success: true, output: "", ...script(command, opts) };
      if (!result.success) break;
    }
    return result;
  });

  const store = new MemoryStore(options.stored);
  const service = new AttachmentService(
    {
      getProjectRootPath: () => ROOT,
      getMonitor: (id) => monitors.get(id) as unknown as WorktreeMonitor | undefined,
      getMonitors: () => [...monitors.values()] as unknown as WorktreeMonitor[],
      getProjectEnvVars: () => ({}),
      emitUpdate: (monitor) => emitted.push(monitor.id),
      lifecycleService: lifecycle,
    },
    store
  );
  await service.load(ROOT);
  return {
    service,
    store,
    monitors,
    ran,
    emitted,
    setScript: (next) => (script = next),
    setApproved: (next) => (approved = next),
    setAttachments: (next) => (attachments = next),
  };
}

function tunnelOn(h: Harness, id: string): WorktreeAttachment | undefined {
  return h.monitors.get(id)!.attachments?.find((a) => a.name === "tunnel");
}

describe("AttachmentService", () => {
  it("offers every declared attachment on every worktree before anything holds it", async () => {
    const h = await createHarness();
    for (const id of ["/wt/a", "/wt/b"]) {
      expect(tunnelOn(h, id)).toEqual({ name: "tunnel", heldHere: false, hasStatusCommand: true });
    }
  });

  it("attaches against the target worktree with its path and branch, then checks status", async () => {
    const h = await createHarness();
    const result = await h.service.run("/wt/a", "tunnel", "attach");

    expect(result).toEqual({ success: true });
    expect(h.ran.map((r) => [r.command, r.cwd])).toEqual([
      ["tunnel up 'feature/a'", "/wt/a"],
      ["tunnel status", "/wt/a"],
    ]);
    expect(h.ran[0]!.env.DAINTREE_WORKTREE_PATH).toBe("/wt/a");
    expect(h.ran[0]!.env.DAINTREE_BRANCH).toBe("feature/a");
    expect(h.ran[0]!.env.DAINTREE_ATTACHMENT_NAME).toBe("tunnel");
    expect(tunnelOn(h, "/wt/a")).toMatchObject({
      heldHere: true,
      holderWorktreeId: "/wt/a",
      lastResult: { action: "attach", state: "success" },
      status: { action: "status", state: "success" },
    });
    expect(tunnelOn(h, "/wt/b")).toMatchObject({ heldHere: false, holderWorktreeId: "/wt/a" });
    expect(h.store.saved.tunnel?.holderWorktreeId).toBe("/wt/a");
  });

  it("moves by detaching from the old holder before attaching to the new one", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.ran.length = 0;

    expect(await h.service.run("/wt/b", "tunnel", "attach")).toEqual({ success: true });
    expect(h.ran.map((r) => [r.command, r.cwd])).toEqual([
      ["tunnel down", "/wt/a"],
      ["tunnel up 'feature/b'", "/wt/b"],
      ["tunnel status", "/wt/b"],
    ]);
    expect(tunnelOn(h, "/wt/a")?.heldHere).toBe(false);
    expect(tunnelOn(h, "/wt/b")?.heldHere).toBe(true);
  });

  it("leaves it on the old holder, failed, when the detach fails — and never attaches", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.ran.length = 0;
    h.setScript((command) =>
      command === "tunnel down" ? { success: false, error: "device busy", output: "busy" } : {}
    );

    const result = await h.service.run("/wt/b", "tunnel", "attach");

    expect(result).toEqual({ success: false, error: "device busy" });
    expect(h.ran.map((r) => r.command)).toEqual(["tunnel down"]);
    expect(tunnelOn(h, "/wt/a")).toMatchObject({
      heldHere: true,
      lastResult: { action: "detach", state: "failed", error: "device busy", output: "busy" },
    });
    expect(tunnelOn(h, "/wt/b")).toMatchObject({ heldHere: false, holderWorktreeId: "/wt/a" });
    expect(tunnelOn(h, "/wt/b")?.lastResult).toBeUndefined();
  });

  it("ends unattached with the failure on the target when attach fails after a detach", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.setScript((command) =>
      command.startsWith("tunnel up") ? { success: false, error: "no device", timedOut: true } : {}
    );

    const result = await h.service.run("/wt/b", "tunnel", "attach");

    expect(result.success).toBe(false);
    const onA = tunnelOn(h, "/wt/a")!;
    const onB = tunnelOn(h, "/wt/b")!;
    expect(onA.heldHere).toBe(false);
    expect(onB.heldHere).toBe(false);
    expect(onB.holderWorktreeId).toBeUndefined();
    expect(onB.lastResult).toMatchObject({
      action: "attach",
      state: "timed-out",
      error: "no device",
    });
    expect(h.store.saved.tunnel?.holderWorktreeId).toBeNull();
  });

  it("runs nothing from an unapproved repository config and flags the card for review", async () => {
    const h = await createHarness();
    h.setApproved(false);

    const result = await h.service.run("/wt/a", "tunnel", "attach");

    expect(result).toEqual({ success: false, error: LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR });
    expect(h.ran).toEqual([]);
    expect(h.monitors.get("/wt/a")!.lifecycleCommandsNeedApproval).toBe(true);
    expect(tunnelOn(h, "/wt/a")?.heldHere).toBe(false);
  });

  it("does not attach when approval is withdrawn while the old holder detaches", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.ran.length = 0;
    h.setScript((command) => {
      if (command === "tunnel down") h.setApproved(false);
      return {};
    });

    const result = await h.service.run("/wt/b", "tunnel", "attach");

    expect(result.error).toBe(LIFECYCLE_COMMANDS_NEED_APPROVAL_ERROR);
    expect(h.ran.map((r) => r.command)).toEqual(["tunnel down"]);
    expect(tunnelOn(h, "/wt/a")?.heldHere).toBe(false);
    expect(tunnelOn(h, "/wt/b")?.heldHere).toBe(false);
  });

  it("serializes two moves so their commands never interleave", async () => {
    const h = await createHarness();
    await Promise.all([
      h.service.run("/wt/a", "tunnel", "attach"),
      h.service.run("/wt/b", "tunnel", "attach"),
    ]);
    expect(h.ran.map((r) => `${r.command}@${r.cwd}`)).toEqual([
      "tunnel up 'feature/a'@/wt/a",
      "tunnel status@/wt/a",
      "tunnel down@/wt/a",
      "tunnel up 'feature/b'@/wt/b",
      "tunnel status@/wt/b",
    ]);
  });

  it("records a failed status check against the holder without moving it", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.setScript(() => ({ success: false, error: "exit 3", output: "offline" }));

    const result = await h.service.run("/wt/a", "tunnel", "status");

    expect(result.success).toBe(false);
    expect(tunnelOn(h, "/wt/a")).toMatchObject({
      heldHere: true,
      status: { action: "status", state: "failed", output: "offline" },
    });
  });

  it("refuses status and detach on a worktree that does not hold it", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.ran.length = 0;
    expect((await h.service.run("/wt/b", "tunnel", "status")).success).toBe(false);
    expect((await h.service.run("/wt/b", "tunnel", "detach")).success).toBe(false);
    expect(h.ran).toEqual([]);
  });

  it("detaches on request and releases only once the detach succeeded", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.setScript(() => ({ success: false, error: "nope" }));
    expect((await h.service.run("/wt/a", "tunnel", "detach")).success).toBe(false);
    expect(tunnelOn(h, "/wt/a")?.heldHere).toBe(true);

    h.setScript(() => ({}));
    expect(await h.service.run("/wt/a", "tunnel", "detach")).toEqual({ success: true });
    expect(tunnelOn(h, "/wt/a")).toMatchObject({
      heldHere: false,
      lastResult: { action: "detach", state: "success" },
    });
    expect(tunnelOn(h, "/wt/a")?.holderWorktreeId).toBeUndefined();
  });

  it("detaches ahead of a delete and releases it once the detach succeeded", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.ran.length = 0;

    await h.service.detachForDelete("/wt/a");

    expect(h.ran.map((r) => [r.command, r.cwd])).toEqual([["tunnel down", "/wt/a"]]);
    expect(h.store.saved.tunnel).toMatchObject({
      holderWorktreeId: null,
      lastResult: { action: "detach", state: "success", worktreeId: "/wt/a" },
    });
  });

  it("keeps a failed delete-detach on its holder until the worktree is actually removed", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.setScript(() => ({ success: false, error: "gone wrong" }));

    await h.service.detachForDelete("/wt/a");
    // The delete can still fail and leave the worktree — and the resource — in place.
    expect(h.store.saved.tunnel).toMatchObject({
      holderWorktreeId: "/wt/a",
      lastResult: { action: "detach", state: "failed", worktreeId: "/wt/a" },
    });

    h.monitors.delete("/wt/a");
    h.service.handleWorktreeRemoved("/wt/a");
    // Released, with the failed detach still the account of what happened.
    expect(h.store.saved.tunnel).toMatchObject({
      holderWorktreeId: null,
      lastResult: { action: "detach", state: "failed", error: "gone wrong" },
    });
  });

  it("skips an unapproved detach on delete and records that it did", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.ran.length = 0;
    h.setApproved(false);

    await h.service.detachForDelete("/wt/a");

    expect(h.ran).toEqual([]);
    expect(h.store.saved.tunnel).toMatchObject({
      holderWorktreeId: "/wt/a",
      lastResult: { action: "detach", state: "needs-approval" },
    });
  });

  it("refuses to attach to a worktree whose delete has started", async () => {
    const h = await createHarness();
    const deleting = h.service.detachForDelete("/wt/b");
    const attach = h.service.run("/wt/b", "tunnel", "attach", null);
    await deleting;

    expect((await attach).success).toBe(false);
    expect(h.ran).toEqual([]);

    // A delete that failed leaves the worktree, which may then attach again.
    h.service.endDelete("/wt/b");
    expect((await h.service.run("/wt/b", "tunnel", "attach", null)).success).toBe(true);
  });

  it("refuses a move when the holder changed since the user asked", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach", null);
    h.ran.length = 0;

    // The user saw nobody holding it; a move now would detach /wt/a unconfirmed.
    const result = await h.service.run("/wt/b", "tunnel", "attach", null);

    expect(result.success).toBe(false);
    expect(h.ran).toEqual([]);
    expect(tunnelOn(h, "/wt/a")?.heldHere).toBe(true);
    expect((await h.service.run("/wt/b", "tunnel", "attach", "/wt/a")).success).toBe(true);
  });

  it("does not attach to a target removed while the old holder detaches", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.ran.length = 0;
    h.setScript((command) => {
      if (command === "tunnel down") h.monitors.delete("/wt/b");
      return {};
    });

    const result = await h.service.run("/wt/b", "tunnel", "attach");

    expect(result.success).toBe(false);
    expect(h.ran.map((r) => r.command)).toEqual(["tunnel down"]);
    expect(h.store.saved.tunnel?.holderWorktreeId).toBeNull();
  });

  it("marks the attachment busy on every card while a request is outstanding", async () => {
    const h = await createHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(h.service["ctx"].lifecycleService.runCommands).mockImplementationOnce(async () => {
      await gate;
      return { success: true, output: "" };
    });

    const pending = h.service.run("/wt/a", "tunnel", "attach");
    // Busy from the moment it is asked for, before anything runs.
    expect(tunnelOn(h, "/wt/b")?.busy).toBe(true);
    await vi.waitFor(() => expect(tunnelOn(h, "/wt/a")?.running).toBe("attach"));
    expect(tunnelOn(h, "/wt/a")?.busy).toBe(true);
    expect(tunnelOn(h, "/wt/b")?.running).toBeUndefined();

    release();
    await pending;
    expect(tunnelOn(h, "/wt/b")?.busy).toBeUndefined();
  });

  it("settles a queued request when the project is switched away under it", async () => {
    const h = await createHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(h.service["ctx"].lifecycleService.runCommands).mockImplementationOnce(async () => {
      await gate;
      return { success: false, output: "", aborted: true, error: "Aborted" };
    });

    const first = h.service.run("/wt/a", "tunnel", "attach");
    const queued = h.service.run("/wt/b", "tunnel", "status");
    await vi.waitFor(() => expect(tunnelOn(h, "/wt/a")?.running).toBe("attach"));
    await h.service.load("/other-repo");
    release();

    await expect(first).resolves.toMatchObject({ success: false });
    await expect(queued).resolves.toMatchObject({ success: false });
  });

  it("previews the substituted detach a delete would run", async () => {
    const h = await createHarness({
      attachments: { tunnel: { ...TUNNEL, detach: ["tunnel down {branch}"] } },
    });
    await h.service.run("/wt/a", "tunnel", "attach");

    const phases = await h.service.previewDetachForDelete(
      h.monitors.get("/wt/a") as unknown as WorktreeMonitor
    );
    expect(phases).toEqual([
      {
        phase: "attachment-detach",
        attachment: "tunnel",
        commands: ["tunnel down 'feature/a'"],
        approved: true,
      },
    ]);
    expect(
      await h.service.previewDetachForDelete(h.monitors.get("/wt/b") as unknown as WorktreeMonitor)
    ).toEqual([]);
  });

  it("releases a holder removed outside Daintree without running anything", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.ran.length = 0;
    h.monitors.delete("/wt/a");

    h.service.handleWorktreeRemoved("/wt/a");

    expect(h.ran).toEqual([]);
    expect(h.store.saved.tunnel).toMatchObject({
      holderWorktreeId: null,
      lastResult: {
        action: "removed",
        worktreeId: "/wt/a",
        error: ATTACHMENT_HOLDER_REMOVED_ERROR,
      },
    });
    expect(tunnelOn(h, "/wt/b")).toMatchObject({ heldHere: false });
    expect(tunnelOn(h, "/wt/b")?.holderWorktreeId).toBeUndefined();
  });

  it("restores the holder from disk and releases one that no longer exists", async () => {
    const h = await createHarness({
      stored: {
        tunnel: { holderWorktreeId: "/wt/b" },
        device: { holderWorktreeId: "/wt/gone" },
      },
      attachments: { tunnel: TUNNEL, device: TUNNEL },
    });

    expect(h.ran).toEqual([]);
    expect(tunnelOn(h, "/wt/b")?.heldHere).toBe(true);

    h.service.reconcile(new Set(["/wt/a", "/wt/b"]));
    expect(h.store.saved.device?.holderWorktreeId).toBeNull();
    expect(h.store.saved.tunnel?.holderWorktreeId).toBe("/wt/b");
  });

  it("keeps showing a held attachment whose declaration was removed", async () => {
    const h = await createHarness({ stored: { tunnel: { holderWorktreeId: "/wt/a" } } });
    h.setAttachments(null);
    await h.service.refreshDeclarations();

    expect(tunnelOn(h, "/wt/a")).toMatchObject({ heldHere: true, hasStatusCommand: false });
  });

  it("does not drop holders or abort work on a repeat load of the same project", async () => {
    const h = await createHarness();
    await h.service.run("/wt/a", "tunnel", "attach");
    h.store.saved = {};
    await h.service.load(ROOT);
    expect(tunnelOn(h, "/wt/a")?.heldHere).toBe(true);
  });
});

describe("FileProjectAttachmentStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "attachments-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists holders per project across store instances", async () => {
    await new FileProjectAttachmentStore(dir).save("/repo/one", {
      tunnel: {
        holderWorktreeId: "/wt/a",
        lastResult: { action: "attach", worktreeId: "/wt/a", state: "success", at: 1 },
      },
    });
    const reread = new FileProjectAttachmentStore(dir);
    expect(await reread.load("/repo/one")).toEqual({
      tunnel: {
        holderWorktreeId: "/wt/a",
        lastResult: { action: "attach", worktreeId: "/wt/a", state: "success", at: 1 },
        status: undefined,
      },
    });
    expect(await reread.load("/repo/two")).toEqual({});
  });

  it("reads a corrupt or foreign file as no state", async () => {
    const store = new FileProjectAttachmentStore(dir);
    await store.save("/repo", { tunnel: { holderWorktreeId: "/wt/a" } });
    const files = await readdir(dir);
    await writeFile(join(dir, files[0]!), "{not json");
    expect(await store.load("/repo")).toEqual({});
    await writeFile(join(dir, files[0]!), JSON.stringify({ version: 99, attachments: {} }));
    expect(await store.load("/repo")).toEqual({});
  });

  it("drops observations that are not well formed", async () => {
    const store = new FileProjectAttachmentStore(dir);
    await store.save("/repo", { tunnel: { holderWorktreeId: null } });
    const files = await readdir(dir);
    const file = join(dir, files[0]!);
    const raw = JSON.parse(await readFile(file, "utf-8"));
    raw.attachments.tunnel.lastResult = {
      action: "explode",
      worktreeId: "/wt/a",
      state: "success",
      at: 1,
    };
    raw.attachments.tunnel.holderWorktreeId = 42;
    await writeFile(file, JSON.stringify(raw));
    expect(await store.load("/repo")).toEqual({
      tunnel: { holderWorktreeId: null, lastResult: undefined, status: undefined },
    });
  });

  it("has no directory for a missing or relative userData path", () => {
    expect(resolveProjectAttachmentsDir(undefined)).toBeNull();
    expect(resolveProjectAttachmentsDir("relative")).toBeNull();
    expect(resolveProjectAttachmentsDir("/data")).toBe(join("/data", "project-attachments"));
  });
});
