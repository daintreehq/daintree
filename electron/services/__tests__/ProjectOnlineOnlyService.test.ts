import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEndpoint } from "../../ipc/endpoint.js";
import type { OnlineOnlyPass, OnlineOnlyRootShape } from "../../utils/onlineOnlyScan.js";
import type {
  OnlineOnlyFilesSide,
  ProjectOnlineOnlyFiles,
} from "../../../shared/types/onlineOnlyFiles.js";
import { ProjectOnlineOnlyService, type OnlineOnlyScanner } from "../ProjectOnlineOnlyService.js";

interface FakePass<T> extends OnlineOnlyPass<T> {
  kind: string;
  root: string;
  answer(value: T): void;
  /** Settles the result while the child stays alive, as a killed find in a kernel wait does. */
  answerButStayAlive(value: T): void;
  exit(): void;
  cancel: ReturnType<typeof vi.fn<() => void>>;
}

function side(files: number, directories = 0, complete = true): OnlineOnlyFilesSide {
  return { files, directories, complete };
}

class FakeScanner implements OnlineOnlyScanner {
  passes: FakePass<never>[] = [];
  /** A killed find can stay alive in a kernel wait: cancelling settles the result, nothing more. */
  cancelLeavesChildAlive = false;
  /** Kinds answered as soon as they start, for tests about what happens between walks. */
  auto: {
    probe?: OnlineOnlyRootShape;
    git?: OnlineOnlyFilesSide;
    workingTree?: OnlineOnlyFilesSide;
  } = {};

  private add<T>(kind: string, root: string, whenCancelled: T): OnlineOnlyPass<T> {
    let resolveResult!: (value: T) => void;
    let resolveExited!: () => void;
    const pass = {
      kind,
      root,
      result: new Promise<T>((resolve) => (resolveResult = resolve)),
      exited: new Promise<void>((resolve) => (resolveExited = resolve)),
      // The real pass settles on cancel too, which is what frees the walk slot.
      cancel: vi.fn(() => {
        resolveResult(whenCancelled);
        if (!this.cancelLeavesChildAlive) resolveExited();
      }),
      answer(value: T) {
        resolveResult(value);
        resolveExited();
      },
      answerButStayAlive(value: T) {
        resolveResult(value);
      },
      exit() {
        resolveExited();
      },
    };
    this.passes.push(pass as unknown as FakePass<never>);
    const auto = this.auto[kind as keyof FakeScanner["auto"]];
    if (auto !== undefined) pass.answer(auto as T);
    return pass;
  }

  probe = (root: string): OnlineOnlyPass<OnlineOnlyRootShape> =>
    this.add<OnlineOnlyRootShape>("probe", root, "unknown");
  scan = (root: string, which: string): OnlineOnlyPass<OnlineOnlyFilesSide> =>
    this.add(which, root, side(0, 0, false));

  /** The newest unanswered pass of a kind. */
  pass<T>(kind: string, root?: string): FakePass<T> {
    const found = this.passes.filter((p) => p.kind === kind && (!root || p.root === root)).at(-1);
    if (!found) throw new Error(`no ${kind} pass started`);
    return found as unknown as FakePass<T>;
  }

  count(kind: string): number {
    return this.passes.filter((p) => p.kind === kind).length;
  }
}

function fakeEndpoint(id = "view-1") {
  const closeListeners = new Set<() => void>();
  const pushes: ProjectOnlineOnlyFiles[] = [];
  const frames: unknown[] = [];
  const endpoint = {
    endpointId: id,
    send: vi.fn((frame: { args: unknown[] }) => {
      frames.push(frame);
      pushes.push(frame.args[0] as ProjectOnlineOnlyFiles);
    }),
    onClose(cb: () => void) {
      closeListeners.add(cb);
      return { dispose: () => closeListeners.delete(cb) };
    },
  };
  return {
    endpoint: endpoint as unknown as ClientEndpoint,
    send: endpoint.send,
    pushes,
    frames,
    closeListeners,
    close: () => [...closeListeners].forEach((cb) => cb()),
  };
}

const project = (id = "p1", path = `/cloud/${id}`) => ({ id, path, service: "Dropbox" as const });
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("ProjectOnlineOnlyService", () => {
  let scanner: FakeScanner;
  let service: ProjectOnlineOnlyService;
  let nobodyLooking: boolean;

  /** Runs the walk slot through both sides' first answers. */
  async function answerFirstRound(
    git: OnlineOnlyFilesSide,
    workingTree: OnlineOnlyFilesSide
  ): Promise<void> {
    await tick();
    scanner.pass<OnlineOnlyRootShape>("probe").answer("git-directory");
    await tick();
    scanner.pass<OnlineOnlyFilesSide>("workingTree").answer(workingTree);
    await tick();
    scanner.pass<OnlineOnlyFilesSide>("git").answer(git);
    await tick();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    scanner = new FakeScanner();
    nobodyLooking = false;
    service = new ProjectOnlineOnlyService(scanner, () => nobodyLooking);
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  it("does nothing until a view watches", async () => {
    await vi.advanceTimersByTimeAsync(600_000);

    expect(scanner.passes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers a watch at once, before anything has been seen", () => {
    const snapshot = service.watch(project(), fakeEndpoint().endpoint);

    expect(snapshot).toMatchObject({
      projectId: "p1",
      service: "Dropbox",
      git: null,
      workingTree: null,
    });
  });

  it("pushes each side as it's seen, split between .git and the working tree", async () => {
    const view = fakeEndpoint();
    service.watch(project(), view.endpoint);
    await tick();
    scanner.pass<OnlineOnlyRootShape>("probe").answer("git-directory");
    await tick();

    scanner.pass<OnlineOnlyFilesSide>("workingTree").answer(side(206));
    await tick();
    expect(view.pushes.at(-1)).toMatchObject({ git: null, workingTree: side(206) });

    scanner.pass<OnlineOnlyFilesSide>("git").answer(side(479));
    await tick();
    expect(view.pushes.at(-1)).toMatchObject({ git: side(479), workingTree: side(206) });
  });

  it("pushes on the channel the renderer listens to", async () => {
    const view = fakeEndpoint();
    scanner.auto = { probe: "no-git", workingTree: side(1) };
    service.watch(project(), view.endpoint);
    await tick();

    expect(view.frames.at(-1)).toEqual({
      type: "event",
      channel: "online-only-files:changed",
      args: [view.pushes.at(-1)],
    });
  });

  it("pushes when only the folders or only the completeness moved", async () => {
    const view = fakeEndpoint();
    scanner.auto = { probe: "no-git", workingTree: side(1) };
    service.watch(project(), view.endpoint);
    await tick();
    const revisions = () => view.pushes.map((p) => p.revision);
    const before = revisions().length;

    scanner.auto.workingTree = side(1, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.pushes.at(-1)?.workingTree).toEqual(side(1, 1));
    expect(revisions().length).toBe(before + 1);

    scanner.auto.workingTree = side(1, 1, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.pushes.at(-1)?.workingTree).toEqual(side(1, 1, false));
    expect(revisions().length).toBe(before + 2);
    expect(revisions()).toEqual([...revisions()].sort((a, b) => a - b));
  });

  it("pushes the move to zero on both sides", async () => {
    const view = fakeEndpoint();
    scanner.auto = { probe: "git-directory", git: side(2), workingTree: side(1) };
    service.watch(project(), view.endpoint);
    await tick();
    expect(view.pushes.at(-1)).toMatchObject({ git: side(2), workingTree: side(1) });

    scanner.auto = { probe: "git-directory", git: side(0), workingTree: side(0) };
    await vi.advanceTimersByTimeAsync(10_000);

    expect(view.pushes.at(-1)).toMatchObject({ git: side(0), workingTree: side(0) });
  });

  it("raises the revision with every push and stays quiet when nothing moved", async () => {
    const view = fakeEndpoint();
    scanner.auto = { probe: "git-directory", git: side(2), workingTree: side(1) };
    service.watch(project(), view.endpoint);
    await tick();
    expect(view.pushes).toHaveLength(2);
    expect(view.pushes[1]!.revision).toBeGreaterThan(view.pushes[0]!.revision);
    const walks = scanner.passes.length;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(scanner.passes.length).toBeGreaterThan(walks);
    expect(view.pushes).toHaveLength(2);
  });

  it("looks again soon while files are outstanding, and not yet where it read zero", async () => {
    scanner.auto = { probe: "git-directory", git: side(0), workingTree: side(5) };
    service.watch(project(), fakeEndpoint().endpoint);
    await tick();
    const trees = scanner.count("workingTree");
    const probes = scanner.count("probe");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(scanner.count("workingTree")).toBeGreaterThan(trees);
    expect(scanner.count("probe")).toBe(probes);
  });

  it("still looks at a zero, because a provider can evict files again", async () => {
    scanner.auto = { probe: "git-directory", git: side(0), workingTree: side(0) };
    service.watch(project(), fakeEndpoint().endpoint);
    await tick();
    const probes = scanner.count("probe");

    await vi.advanceTimersByTimeAsync(120_000);

    expect(scanner.count("probe")).toBeGreaterThan(probes);
  });

  it("paces the sides apart, so .git keeps moving past a slow working tree", async () => {
    scanner.auto = { probe: "git-directory", git: side(3) };
    service.watch(project(), fakeEndpoint().endpoint);
    await tick();
    const slowTree = scanner.pass<OnlineOnlyFilesSide>("workingTree");
    const probesBefore = scanner.count("probe");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.count("probe")).toBeGreaterThan(probesBefore);

    slowTree.answer(side(5));
    await tick();
    scanner.auto.workingTree = side(5);
    const trees = scanner.count("workingTree");
    const probes = scanner.count("probe");

    // The tree rests in proportion to its own walk, and .git keeps its own pace.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scanner.count("workingTree")).toBe(trees);
    expect(scanner.count("probe")).toBeGreaterThan(probes);

    await vi.advanceTimersByTimeAsync(80_000);
    expect(scanner.count("workingTree")).toBeGreaterThan(trees);
  });

  it("doesn't count time queued behind another project as walking", async () => {
    const first = fakeEndpoint("a");
    service.watch(project("a"), first.endpoint);
    await tick();
    scanner.auto.probe = "no-git";
    scanner.pass<OnlineOnlyRootShape>("probe", "/cloud/a").answer("no-git");
    await tick();

    service.watch(project("b"), fakeEndpoint("b").endpoint);
    await tick();
    const treeOfA = scanner.pass<OnlineOnlyFilesSide>("workingTree", "/cloud/a");
    await vi.advanceTimersByTimeAsync(20_000);
    treeOfA.answer(side(0));
    await tick();

    const treeOfB = scanner.pass<OnlineOnlyFilesSide>("workingTree", "/cloud/b");
    treeOfB.answer(side(5));
    await tick();
    const walksOfB = () =>
      scanner.passes.filter((p) => p.kind === "workingTree" && p.root === "/cloud/b").length;

    // B walked for no time at all, so it comes back on the short rest, not 4 x its 20s in the queue.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(walksOfB()).toBe(2);
  });

  it("rests longer when nobody can see the app", async () => {
    nobodyLooking = true;
    scanner.auto = { probe: "git-directory", git: side(0), workingTree: side(5) };
    service.watch(project(), fakeEndpoint().endpoint);
    await tick();
    const trees = scanner.count("workingTree");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(scanner.count("workingTree")).toBe(trees);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(scanner.count("workingTree")).toBeGreaterThan(trees);
  });

  describe("what .git can claim", () => {
    async function gitAfterProbe(
      shape: OnlineOnlyRootShape
    ): Promise<OnlineOnlyFilesSide | null | undefined> {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe").answer(shape);
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("workingTree").answer(side(0));
      await tick();
      return view.pushes.at(-1)?.git;
    }

    it("claims a real zero when the project has no .git to wait on", async () => {
      expect(await gitAfterProbe("no-git")).toEqual(side(0));
      expect(scanner.count("git")).toBe(0);
    });

    it("doesn't answer zero for a .git it couldn't reach behind a dataless root", async () => {
      expect(await gitAfterProbe("root-online-only")).toEqual({
        ...side(0, 0, false),
        rootOnlineOnly: true,
      });
      expect(scanner.count("git")).toBe(0);
    });

    it("keeps checking a dataless root as often as outstanding files", async () => {
      await gitAfterProbe("root-online-only");
      const probes = scanner.count("probe");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(scanner.count("probe")).toBe(probes + 1);
    });

    it("doesn't answer zero when the probe learned nothing", async () => {
      const git = await gitAfterProbe("unknown");
      expect(git).toEqual(side(0, 0, false));
      expect(git?.rootOnlineOnly).toBeUndefined();
      expect(scanner.count("git")).toBe(0);
    });

    it("reports a pointer's own flag but leaves the side unfinished", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe").answer("git-pointer");
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("workingTree").answer(side(0));
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("git").answer(side(1));
      await tick();

      expect(view.pushes.at(-1)?.git).toEqual(side(1, 0, false));
    });

    it("keeps an interrupted walk's count without calling it finished", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await answerFirstRound(side(40, 1, false), side(0));

      expect(view.pushes.at(-1)?.git).toEqual(side(40, 1, false));
    });
  });

  describe("sharing the machine", () => {
    it("runs one walk per side at a time, across projects", async () => {
      service.watch(project("a"), fakeEndpoint("a").endpoint);
      service.watch(project("b"), fakeEndpoint("b").endpoint);
      await tick();
      expect(scanner.passes.map((p) => [p.kind, p.root])).toEqual([
        ["probe", "/cloud/a"],
        ["workingTree", "/cloud/a"],
      ]);

      scanner.pass<OnlineOnlyFilesSide>("workingTree", "/cloud/a").answer(side(0));
      await tick();
      expect(scanner.pass("workingTree", "/cloud/b")).toBeDefined();
      expect(() => scanner.pass("probe", "/cloud/b")).toThrow();

      scanner.pass<OnlineOnlyRootShape>("probe", "/cloud/a").answer("no-git");
      await tick();
      expect(scanner.pass("probe", "/cloud/b")).toBeDefined();
    });

    it("starts no second child beside one that outlived its holders", async () => {
      scanner.cancelLeavesChildAlive = true;
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await tick();
      expect(scanner.count("workingTree")).toBe(1);
      const firstTree = scanner.pass("workingTree");

      for (let round = 0; round < 3; round++) {
        service.release(view.endpoint);
        service.watch(project(), view.endpoint);
        await tick();
      }
      expect(scanner.count("workingTree")).toBe(1);

      firstTree.exit();
      await tick();
      expect(scanner.count("workingTree")).toBe(2);
    });

    it("lets a walk of .git run while another project's tree is walking", async () => {
      service.watch(project("a"), fakeEndpoint("a").endpoint);
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe", "/cloud/a").answer("no-git");
      await tick();

      service.watch(project("b"), fakeEndpoint("b").endpoint);
      await tick();

      expect(scanner.pass("probe", "/cloud/b")).toBeDefined();
      expect(() => scanner.pass("workingTree", "/cloud/b")).toThrow();
    });

    it("lets other projects walk past a child that won't die, and starts no more on its side", async () => {
      scanner.auto = { probe: "no-git" };
      service.watch(project("a"), fakeEndpoint("a").endpoint);
      await tick();
      const stuck = scanner.pass<OnlineOnlyFilesSide>("workingTree", "/cloud/a");
      stuck.answerButStayAlive(side(5, 0, false));
      await tick();
      scanner.auto.workingTree = side(0);
      const walksOf = (root: string) =>
        scanner.passes.filter((p) => p.kind === "workingTree" && p.root === root).length;

      service.watch(project("b"), fakeEndpoint("b").endpoint);
      await tick();
      expect(walksOf("/cloud/b")).toBe(1);

      await vi.advanceTimersByTimeAsync(600_000);
      expect(walksOf("/cloud/a")).toBe(1);
      expect(walksOf("/cloud/b")).toBeGreaterThan(1);

      stuck.exit();
      await tick();
      expect(walksOf("/cloud/a")).toBe(2);
    });
  });

  describe("who is holding", () => {
    it("shares one walk between views of a project and stops only with the last", async () => {
      const first = fakeEndpoint("one");
      const second = fakeEndpoint("two");
      service.watch(project(), first.endpoint);
      service.watch(project(), second.endpoint);
      await tick();
      expect(scanner.count("probe")).toBe(1);
      expect(scanner.count("workingTree")).toBe(1);

      service.release(first.endpoint);
      for (const pass of scanner.passes) expect(pass.cancel).not.toHaveBeenCalled();

      service.release(second.endpoint);
      for (const pass of scanner.passes) expect(pass.cancel).toHaveBeenCalled();
    });

    it("leaves no timer or walk behind when released", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await answerFirstRound(side(1), side(1));
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const walks = scanner.passes.length;

      service.release(view.endpoint);

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(scanner.passes).toHaveLength(walks);
      expect(view.closeListeners.size).toBe(0);
    });

    it("lets go when the view goes away without saying so", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await tick();

      view.close();

      expect(scanner.passes.length).toBeGreaterThan(1);
      for (const pass of scanner.passes) expect(pass.cancel).toHaveBeenCalled();
    });

    it("doesn't restart the walk when a view watches the same project again", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await answerFirstRound(side(3), side(1));
      const walks = scanner.passes.length;

      const again = service.watch(project(), view.endpoint);

      expect(again.git).toEqual(side(3));
      expect(scanner.passes).toHaveLength(walks);
      expect(view.closeListeners.size).toBe(1);
    });

    it("moves a view to the project it now shows", async () => {
      const view = fakeEndpoint();
      service.watch(project("old"), view.endpoint);
      await tick();
      const oldProbe = scanner.pass("probe", "/cloud/old");

      service.watch(project("new"), view.endpoint);
      await tick();

      expect(oldProbe.cancel).toHaveBeenCalled();
      expect(view.closeListeners.size).toBe(1);
    });

    it("starts again from the new path when a project moves", async () => {
      const view = fakeEndpoint();
      service.watch(project("p", "/cloud/before"), view.endpoint);
      await tick();
      const before = scanner.pass("probe", "/cloud/before");

      const snapshot = service.watch(project("p", "/cloud/after"), view.endpoint);
      await tick();

      expect(before.cancel).toHaveBeenCalled();
      expect(snapshot.git).toBeNull();
      expect(scanner.pass("probe", "/cloud/after")).toBeDefined();
    });

    it("keeps the other views of a project that moved", async () => {
      const noticed = fakeEndpoint("noticed");
      const other = fakeEndpoint("other");
      service.watch(project("p", "/cloud/before"), noticed.endpoint);
      service.watch(project("p", "/cloud/before"), other.endpoint);
      await tick();

      service.watch(project("p", "/cloud/after"), noticed.endpoint);
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe", "/cloud/after").answer("no-git");
      await tick();

      expect(other.pushes.at(-1)?.git).toEqual(side(0));

      service.release(noticed.endpoint);
      const after = scanner.pass("workingTree", "/cloud/after");
      expect(after.cancel).not.toHaveBeenCalled();
      service.release(other.endpoint);
      expect(after.cancel).toHaveBeenCalled();
    });

    it("never goes back on a revision when a project is watched afresh", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await answerFirstRound(side(1), side(1));
      const last = view.pushes.at(-1)!.revision;
      service.release(view.endpoint);

      const fresh = service.watch(project(), view.endpoint);

      expect(fresh.revision).toBeGreaterThan(last);
    });

    it("survives a view whose send throws", async () => {
      const broken = fakeEndpoint("broken");
      broken.send.mockImplementation(() => {
        throw new Error("closing");
      });
      const healthy = fakeEndpoint("healthy");
      service.watch(project(), broken.endpoint);
      service.watch(project(), healthy.endpoint);

      await answerFirstRound(side(1), side(1));

      expect(healthy.pushes.at(-1)?.git).toEqual(side(1));
    });

    it("stops everything on dispose", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await tick();

      service.dispose();

      expect(scanner.passes.length).toBeGreaterThan(1);
      for (const pass of scanner.passes) expect(pass.cancel).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(view.closeListeners.size).toBe(0);
    });
  });
  describe("a find that won't die", () => {
    it("stops standing behind the last count, so a hold can't outlive the files", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe").answer("git-directory");
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("workingTree").answer(side(0));
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("git").answerButStayAlive(side(479));
      await tick();
      expect(view.pushes.at(-1)?.git).toEqual(side(479));

      // The next walk is due at 5s and can't start beside the stuck child.
      await vi.advanceTimersByTimeAsync(34_000);
      expect(view.pushes.at(-1)?.git).toEqual(side(479));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(view.pushes.at(-1)?.git).toEqual(side(0, 0, false));
    });

    it("looks again, with real counts, once the child finally goes", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe").answer("git-directory");
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("workingTree").answer(side(0));
      await tick();
      const stuck = scanner.pass<OnlineOnlyFilesSide>("git");
      stuck.answerButStayAlive(side(479));
      await vi.advanceTimersByTimeAsync(40_000);
      const probes = scanner.count("probe");

      stuck.exit();
      await tick();
      expect(scanner.count("probe")).toBe(probes + 1);
      scanner.pass<OnlineOnlyRootShape>("probe").answer("git-directory");
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("git").answer(side(3));
      await tick();

      expect(view.pushes.at(-1)?.git).toEqual(side(3));
    });

    it("answers a re-watched project's first walk, so nothing waits on it for good", async () => {
      scanner.cancelLeavesChildAlive = true;
      const first = fakeEndpoint("first");
      service.watch(project(), first.endpoint);
      await tick();
      service.release(first.endpoint);
      await tick();

      const second = fakeEndpoint("second");
      expect(service.watch(project(), second.endpoint).git).toBeNull();
      await vi.advanceTimersByTimeAsync(31_000);

      expect(second.pushes.at(-1)?.git).toEqual(side(0, 0, false));
    });

    it("keeps a real answer when the child goes before the deadline", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe").answer("git-directory");
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("workingTree").answer(side(0));
      await tick();
      const stuck = scanner.pass<OnlineOnlyFilesSide>("git");
      stuck.answerButStayAlive(side(479));
      // Past the 5s rest, so the next walk is waiting on this child.
      await vi.advanceTimersByTimeAsync(10_000);

      stuck.exit();
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe").answer("git-directory");
      await tick();
      scanner.pass<OnlineOnlyFilesSide>("git").answer(side(3));
      await tick();
      await vi.advanceTimersByTimeAsync(31_000);

      expect(view.pushes.map((pushed) => pushed.git)).not.toContainEqual(side(0, 0, false));
    });

    it("records nothing for a project stopped while its child was stuck", async () => {
      scanner.cancelLeavesChildAlive = true;
      const first = fakeEndpoint("first");
      service.watch(project(), first.endpoint);
      await tick();
      service.release(first.endpoint);
      await tick();
      const second = fakeEndpoint("second");
      service.watch(project(), second.endpoint);
      await tick();
      service.release(second.endpoint);
      const record = vi.spyOn(service as never, "record");

      await vi.advanceTimersByTimeAsync(60_000);

      expect(record).not.toHaveBeenCalled();
    });
  });

  describe("observe", () => {
    it("shares a view's walk rather than starting a second", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      const heard: ProjectOnlineOnlyFiles[] = [];
      const { files } = service.observe(project(), (next) => heard.push(next));
      expect(files.projectId).toBe("p1");

      await answerFirstRound(side(4), side(2));

      expect(scanner.count("probe")).toBe(1);
      expect(heard.at(-1)?.git).toEqual(side(4));
      expect(view.pushes.at(-1)?.git).toEqual(side(4));
    });

    it("hands a late observer what's already been seen", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      await answerFirstRound(side(4), side(2));

      expect(service.observe(project(), () => {}).files.git).toEqual(side(4));
    });

    it("keeps the walk going for an observer after the last view leaves", async () => {
      const view = fakeEndpoint();
      service.watch(project(), view.endpoint);
      const { release } = service.observe(project(), () => {});
      await answerFirstRound(side(4), side(2));

      service.release(view.endpoint);
      const probes = scanner.count("probe");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(scanner.count("probe")).toBeGreaterThan(probes);

      release();
      await tick();
      const afterRelease = scanner.count("probe");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(scanner.count("probe")).toBe(afterRelease);
    });

    it("moves an observer with the project", async () => {
      const heard: ProjectOnlineOnlyFiles[] = [];
      service.observe(project(), (next) => heard.push(next));
      const view = fakeEndpoint();
      service.watch(project("p1", "/cloud/moved"), view.endpoint);
      await tick();
      scanner.pass<OnlineOnlyRootShape>("probe", "/cloud/moved").answer("no-git");
      await tick();

      expect(heard.at(-1)?.git).toEqual(side(0));
    });

    it("doesn't let a throwing observer stop the views hearing", async () => {
      const view = fakeEndpoint();
      service.observe(project(), () => {
        throw new Error("gone");
      });
      service.watch(project(), view.endpoint);
      await answerFirstRound(side(4), side(2));

      expect(view.pushes.at(-1)?.git).toEqual(side(4));
    });
  });
});
