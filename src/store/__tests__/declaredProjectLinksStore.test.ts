import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeclaredProjectLink } from "@shared/types";

const h = vi.hoisted(() => ({
  pending: [] as Array<{
    projectId: string;
    resolve: (links: DeclaredProjectLink[]) => void;
    reject: (error: unknown) => void;
  }>,
}));

vi.mock("@/clients/projectClient", () => ({
  projectClient: {
    getDeclaredLinks: (projectId: string) =>
      new Promise<DeclaredProjectLink[]>((resolve, reject) => {
        h.pending.push({ projectId, resolve, reject });
      }),
  },
}));

const {
  refreshDeclaredProjectLinks,
  useDeclaredProjectLinksStore,
  _resetDeclaredProjectLinksForTests,
} = await import("../declaredProjectLinksStore");

const HOMEPAGE: DeclaredProjectLink = {
  source: "package.json",
  title: "Homepage",
  url: "https://widget.example.dev/",
};
const REPOSITORY: DeclaredProjectLink = {
  source: "package.json",
  title: "Repository",
  url: "https://github.com/acme/widget",
};

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  h.pending.length = 0;
  _resetDeclaredProjectLinksForTests();
});

describe("refreshDeclaredProjectLinks (#17252)", () => {
  it("keeps the links read for the project", async () => {
    const done = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await done;
    expect(useDeclaredProjectLinksStore.getState()).toEqual({ projectId: "p1", links: [HOMEPAGE] });
  });

  it("folds requests made while a read is out into one more read after it", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    void refreshDeclaredProjectLinks("p1");
    void refreshDeclaredProjectLinks("p1");
    expect(h.pending).toHaveLength(1);

    h.pending[0]!.resolve([HOMEPAGE]);
    await settle();
    expect(h.pending).toHaveLength(2);
    h.pending[1]!.resolve([HOMEPAGE, REPOSITORY]);
    await first;

    expect(h.pending).toHaveLength(2);
    expect(useDeclaredProjectLinksStore.getState().links).toEqual([HOMEPAGE, REPOSITORY]);
  });

  it("drops a project's answer that lands after the view moved to another project", async () => {
    const forA = refreshDeclaredProjectLinks("a");
    const forB = refreshDeclaredProjectLinks("b");
    expect(h.pending.map((read) => read.projectId)).toEqual(["a", "b"]);

    h.pending[1]!.resolve([REPOSITORY]);
    await forB;
    h.pending[0]!.resolve([HOMEPAGE]);
    await forA;

    expect(useDeclaredProjectLinksStore.getState()).toEqual({
      projectId: "b",
      links: [REPOSITORY],
    });
  });

  it("keeps what it showed when a read fails, and reads again when asked", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await first;

    const failed = refreshDeclaredProjectLinks("p1");
    h.pending[1]!.reject(new Error("PROJECT_IO_STALLED"));
    await failed;
    expect(useDeclaredProjectLinksStore.getState()).toEqual({ projectId: "p1", links: [HOMEPAGE] });

    const again = refreshDeclaredProjectLinks("p1");
    h.pending[2]!.resolve([]);
    await again;
    expect(useDeclaredProjectLinksStore.getState()).toEqual({ projectId: "p1", links: [] });
  });

  it("still runs a read asked for while one that fails is out", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    void refreshDeclaredProjectLinks("p1");
    h.pending[0]!.reject(new Error("EIO"));
    await settle();
    expect(h.pending).toHaveLength(2);
    h.pending[1]!.resolve([HOMEPAGE]);
    await first;
    expect(useDeclaredProjectLinksStore.getState()).toEqual({ projectId: "p1", links: [HOMEPAGE] });
  });

  it("keeps a project's newer read when its older one lands after a switch away and back", async () => {
    const a1 = refreshDeclaredProjectLinks("a");
    const b = refreshDeclaredProjectLinks("b");
    const a2 = refreshDeclaredProjectLinks("a");
    expect(h.pending.map((read) => read.projectId)).toEqual(["a", "b", "a"]);

    h.pending[0]!.resolve([HOMEPAGE]);
    await a1;
    h.pending[1]!.resolve([]);
    await b;
    expect(useDeclaredProjectLinksStore.getState().projectId).toBeNull();

    // The newer read for `a` is still the one out: asking again queues behind it.
    void refreshDeclaredProjectLinks("a");
    expect(h.pending).toHaveLength(3);
    h.pending[2]!.resolve([REPOSITORY]);
    await settle();
    expect(useDeclaredProjectLinksStore.getState()).toEqual({
      projectId: "a",
      links: [REPOSITORY],
    });
    expect(h.pending).toHaveLength(4);
    h.pending[3]!.resolve([REPOSITORY]);
    await a2;
  });

  it("shows an address that changed in the file", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await first;
    const moved = { ...HOMEPAGE, url: "https://widget.example.org/" };
    const second = refreshDeclaredProjectLinks("p1");
    h.pending[1]!.resolve([moved]);
    await second;
    expect(useDeclaredProjectLinksStore.getState().links).toEqual([moved]);
  });

  it("shows a link the file renamed, at the same address (#17254)", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await first;
    const renamed: DeclaredProjectLink = { ...HOMEPAGE, title: "Website" };
    const second = refreshDeclaredProjectLinks("p1");
    h.pending[1]!.resolve([renamed]);
    await second;
    expect(useDeclaredProjectLinksStore.getState().links).toEqual([renamed]);
  });

  it("shows a link that now comes from another manifest (#17254)", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await first;
    // package.json dropped its homepage, and pyproject.toml names the same one.
    const fromPyproject: DeclaredProjectLink = { ...HOMEPAGE, source: "pyproject.toml" };
    const second = refreshDeclaredProjectLinks("p1");
    h.pending[1]!.resolve([fromPyproject]);
    await second;
    expect(useDeclaredProjectLinksStore.getState().links).toEqual([fromPyproject]);
  });

  it("holds the list through an empty read while a newer read is queued behind it", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await first;
    const held = useDeclaredProjectLinksStore.getState().links;

    const midSave = refreshDeclaredProjectLinks("p1");
    void refreshDeclaredProjectLinks("p1");
    h.pending[1]!.resolve([]);
    await settle();
    expect(useDeclaredProjectLinksStore.getState().links).toBe(held);

    h.pending[2]!.resolve([HOMEPAGE, REPOSITORY]);
    await midSave;
    expect(useDeclaredProjectLinksStore.getState().links).toEqual([HOMEPAGE, REPOSITORY]);
  });

  it("clears the list it held back when the read queued behind the empty one fails", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await first;

    const midSave = refreshDeclaredProjectLinks("p1");
    void refreshDeclaredProjectLinks("p1");
    h.pending[1]!.resolve([]);
    await settle();
    expect(useDeclaredProjectLinksStore.getState().links).toEqual([HOMEPAGE]);

    h.pending[2]!.reject(new Error("EIO"));
    await midSave;
    expect(useDeclaredProjectLinksStore.getState()).toEqual({ projectId: "p1", links: [] });
  });

  it("clears the list when the last read says the file declares nothing", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await first;
    const cleared = refreshDeclaredProjectLinks("p1");
    h.pending[1]!.resolve([]);
    await cleared;
    expect(useDeclaredProjectLinksStore.getState()).toEqual({ projectId: "p1", links: [] });
  });

  it("leaves the list it holds in place when the file says the same again", async () => {
    const first = refreshDeclaredProjectLinks("p1");
    h.pending[0]!.resolve([HOMEPAGE]);
    await first;
    const held = useDeclaredProjectLinksStore.getState().links;

    const second = refreshDeclaredProjectLinks("p1");
    h.pending[1]!.resolve([{ ...HOMEPAGE }]);
    await second;
    expect(useDeclaredProjectLinksStore.getState().links).toBe(held);
  });
});
