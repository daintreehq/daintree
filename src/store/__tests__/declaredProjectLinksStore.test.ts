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

const { refreshDeclaredProjectLinks, useDeclaredProjectLinksStore, _resetDeclaredProjectLinksForTests } =
  await import("../declaredProjectLinksStore");

const HOMEPAGE: DeclaredProjectLink = {
  field: "homepage",
  title: "Homepage",
  url: "https://widget.example.dev/",
};
const REPOSITORY: DeclaredProjectLink = {
  field: "repository",
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

    expect(useDeclaredProjectLinksStore.getState()).toEqual({ projectId: "b", links: [REPOSITORY] });
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
