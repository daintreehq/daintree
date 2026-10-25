import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_LIST_PROJECT_BYTES_MAX,
  HOST_LIST_PROJECTS_MAX,
  HostListResultSchema,
  type HostListArgs,
  type HostListEntry,
} from "../../../../shared/types/hostControl.js";
import type { HostProjectSummary } from "../../../../shared/types/ipc/remoteHosts.js";
import { MAX_LISTED_PROJECTS } from "../../host/linkMethods.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import { decodeProjectCursor, encodeProjectCursor } from "../hostProjectInventory.js";

const RUN_A: OpenRun = {
  projectId: "own",
  slot: 0,
  sessionId: "a",
  terminalId: "t-a",
  launchGeneration: 1,
};

function connected(hostId: string): ObservedHost {
  return {
    hostId,
    name: `${hostId}-01`,
    connection: { status: "connected", rttMs: 12, handshake: {} as never },
    lastSeenAt: 900,
    summary: null,
  };
}

function numbered(count: number, prefix = "p", name = (index: number) => `Project ${index}`) {
  return Array.from({ length: count }, (_, index): HostProjectSummary => ({
    id: `${prefix}-${index}`,
    name: name(index),
    path: `/repos/${prefix}/${index}`,
  }));
}

describe("HostCallRuntime project inventory (#14457)", () => {
  let localProjects: HostProjectSummary[] | Error;
  let remote: Map<string, HostProjectSummary[] | Error>;
  let hosts: ObservedHost[];
  let eligible: boolean;
  let listHostProjects: ReturnType<typeof vi.fn>;
  let runtime: HostCallRuntime;

  beforeEach(() => {
    localProjects = [];
    remote = new Map();
    hosts = [];
    eligible = true;
    listHostProjects = vi.fn(async (hostId: string) => {
      const answer = remote.get(hostId) ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    });
    runtime = new HostCallRuntime({
      getSessionLane: () => (eligible ? { projectId: "own", slot: 0 } : null),
      callerRun: () => (eligible ? RUN_A : null),
      client: () => null,
      hosts: () => hosts,
      inLocalView: () => true,
      controlEnabled: () => true,
      listHostProjects,
      local: {
        name: () => "greg-mbp",
        projects: async () => {
          if (localProjects instanceof Error) throw localProjects;
          return localProjects;
        },
        relayCall: vi.fn(),
      },
      now: () => 1000,
    });
  });

  afterEach(() => runtime.dispose());

  async function list(args: HostListArgs = {}): Promise<HostListEntry[]> {
    const listed = await runtime.list("a", args);
    if (!listed.ok) throw new Error(`refused: ${listed.code}`);
    expect(HostListResultSchema.parse(listed.value)).toEqual(listed.value);
    return listed.value.hosts;
  }

  async function localEntry(args: HostListArgs = {}): Promise<HostListEntry> {
    const entry = (await list(args)).find((host) => host.hostId === "local");
    if (!entry) throw new Error("no local entry");
    return entry;
  }

  /** Follows one host's cursors to the end, as a caller would. */
  async function drain(first: HostListEntry): Promise<string[]> {
    const ids = (first.projects ?? []).map((project) => project.projectId);
    let cursor = first.projectInventory?.nextCursor ?? null;
    while (cursor !== null) {
      const hostsListed = await list({ projectCursor: cursor });
      expect(hostsListed).toHaveLength(1);
      const page = hostsListed[0]!;
      expect(page.hostId).toBe(first.hostId);
      expect(page.projectInventory?.listChanged).toBe(false);
      expect(page.projectInventory?.offset).toBe(ids.length);
      ids.push(...(page.projects ?? []).map((project) => project.projectId));
      cursor = page.projectInventory?.nextCursor ?? null;
    }
    return ids;
  }

  it.each([
    [0, true, null],
    [49, true, null],
    [50, true, null],
    [51, false, 1],
  ])("says how much of %i projects one answer names", async (count, complete, omitted) => {
    // The caller's own project is never counted: host.call doesn't reach it under local.
    localProjects = [...numbered(count), { id: "own", name: "mine", path: "/repos/own" }];
    const entry = await localEntry();

    expect(entry.projects).toHaveLength(Math.min(count, HOST_LIST_PROJECTS_MAX));
    expect(entry.projectInventory).toMatchObject({
      complete,
      total: count,
      offset: 0,
      omitted: omitted ?? 0,
      listChanged: false,
    });
    expect(entry.projectInventory?.nextCursor === null).toBe(complete);
    expect(entry.projects?.some((project) => project.projectId === "own")).toBe(false);
  });

  it("pages through every project once each, in order, with a cursor scoped to its host", async () => {
    localProjects = numbered(120);
    hosts = [connected("studio")];
    remote.set("studio", numbered(3, "s"));
    const first = await localEntry();
    listHostProjects.mockClear();

    const ids = await drain(first);

    expect(ids).toEqual(numbered(120).map((project) => project.id));
    // Continuing local's pages neither lists nor reads any other host.
    expect(listHostProjects).not.toHaveBeenCalled();
    const last = await list({ projectCursor: first.projectInventory!.nextCursor! });
    expect(last[0]?.projectInventory).toMatchObject({ complete: false, total: 120, omitted: 70 });
  });

  it("pages a remote host's projects the same way", async () => {
    hosts = [connected("studio"), connected("laptop")];
    remote.set("studio", numbered(51, "s"));
    remote.set("laptop", numbered(2, "l"));
    const studio = (await list()).find((host) => host.hostId === "studio")!;
    expect(studio.projectInventory).toMatchObject({ complete: false, total: 51, omitted: 1 });
    listHostProjects.mockClear();

    expect(await drain(studio)).toEqual(numbered(51, "s").map((project) => project.id));
    expect(listHostProjects.mock.calls.every(([hostId]) => hostId === "studio")).toBe(true);
  });

  it("lists one host when asked, and finds projects by name past the first page", async () => {
    localProjects = numbered(200);
    hosts = [connected("studio")];
    expect((await list({ hostId: "local" })).map((host) => host.hostId)).toEqual(["local"]);
    expect((await list({ hostId: "studio" })).map((host) => host.hostId)).toEqual(["studio"]);

    const found = await localEntry({ projectQuery: "PROJECT 19" });
    expect(found.projects?.map((project) => project.projectId)).toEqual([
      "p-19",
      ...Array.from({ length: 10 }, (_, index) => `p-${190 + index}`),
    ]);
    expect(found.projectInventory).toMatchObject({ complete: true, total: 11, omitted: 0 });

    const many = await localEntry({ projectQuery: "1" });
    const matching = numbered(200).filter((project) => project.name.includes("1"));
    expect(many.projectInventory?.total).toBe(matching.length);
    // The query rides in the cursor, so the next page stays filtered.
    expect(await drain(many)).toEqual(matching.map((project) => project.id));
  });

  it("starts again from the first page when the list changed between pages", async () => {
    localProjects = numbered(60);
    const first = await localEntry();
    localProjects = [{ id: "new", name: "fresh", path: "/repos/new" }, ...numbered(60)];

    const again = await localEntry({ projectCursor: first.projectInventory!.nextCursor! });

    expect(again.projectInventory).toMatchObject({ listChanged: true, offset: 0, total: 61 });
    expect(again.projects?.[0]?.projectId).toBe("new");
    // Its cursor is of the new list, so the walk goes on from there.
    const next = await localEntry({ projectCursor: again.projectInventory!.nextCursor! });
    expect(next.projectInventory).toMatchObject({ listChanged: false, offset: 50 });
    expect(next.projects?.map((project) => project.projectId)).toEqual(
      numbered(60)
        .slice(49)
        .map((project) => project.id)
    );
  });

  it("tells a failed read from no projects", async () => {
    hosts = [connected("studio"), connected("gone")];
    remote.set("studio", []);
    remote.set("gone", new Error("link dropped"));
    localProjects = new Error("database closed");

    const listed = await list();

    expect(listed.find((host) => host.hostId === "local")).toMatchObject({
      projects: null,
      projectInventory: null,
    });
    expect(listed.find((host) => host.hostId === "gone")).toMatchObject({
      projects: null,
      projectInventory: null,
    });
    expect(listed.find((host) => host.hostId === "studio")).toMatchObject({
      projects: [],
      projectInventory: { complete: true, total: 0, omitted: 0, nextCursor: null },
    });
  });

  it("never claims a count past a host's own list limit", async () => {
    hosts = [connected("studio")];
    remote.set("studio", numbered(MAX_LISTED_PROJECTS, "s"));

    const studio = (await list({ hostId: "studio" }))[0]!;

    expect(studio.projectInventory).toMatchObject({ complete: false, total: null, omitted: null });
    expect(studio.projectInventory?.nextCursor).not.toBeNull();
  });

  it("keeps every host's projects within one answer's budget, and pages on past a cut", async () => {
    const long = (index: number) => `${"n".repeat(1000)} ${index}`;
    localProjects = numbered(50, "p", long);
    hosts = ["a", "b", "c"].map(connected);
    for (const hostId of ["a", "b", "c"]) remote.set(hostId, numbered(50, hostId, long));

    const listed = await list();

    const bytes = new TextEncoder().encode(
      JSON.stringify(listed.flatMap((host) => host.projects ?? []))
    ).length;
    expect(bytes).toBeLessThanOrEqual(HOST_LIST_PROJECT_BYTES_MAX);
    for (const host of listed) {
      // No host is crowded out by another's long names.
      expect(host.projects!.length).toBeGreaterThan(0);
      expect(host.projectInventory).toMatchObject({
        complete: false,
        omitted: 50 - host.projects!.length,
      });
      expect(await drain(host)).toEqual(
        numbered(50, host.hostId === "local" ? "p" : host.hostId).map((project) => project.id)
      );
    }
  });

  it("refuses a cursor it didn't give, or one at odds with the call", async () => {
    localProjects = numbered(60);
    const cursor = (await localEntry()).projectInventory!.nextCursor!;
    const refusals = await Promise.all(
      [
        { projectCursor: "not-a-cursor" },
        { projectCursor: Buffer.from('{"v":2}').toString("base64url") },
        { projectCursor: cursor, hostId: "studio" },
        { projectCursor: cursor, projectQuery: "other" },
      ].map((args) => runtime.list("a", args))
    );
    for (const refusal of refusals)
      expect(refusal).toMatchObject({ ok: false, code: "INVALID_ARGS" });
    expect(await runtime.list("a", { projectCursor: cursor, hostId: "local" })).toMatchObject({
      ok: true,
    });
  });

  it("gives a cursor no standing: an ineligible caller is refused as before", async () => {
    localProjects = numbered(60);
    const cursor = (await localEntry()).projectInventory!.nextCursor!;
    eligible = false;
    expect(await runtime.list("a", { projectCursor: cursor })).toMatchObject({
      ok: false,
      code: "NOT_ELIGIBLE",
    });
  });

  it("round-trips a cursor and rejects a tampered one", () => {
    const cursor = { hostId: "studio", query: null, offset: 50, revision: "0123456789abcdef" };
    expect(decodeProjectCursor(encodeProjectCursor(cursor))).toEqual(cursor);
    expect(decodeProjectCursor(encodeProjectCursor({ ...cursor, offset: -1 }))).toBeNull();
    expect(decodeProjectCursor(encodeProjectCursor({ ...cursor, revision: "x" }))).toBeNull();
    expect(decodeProjectCursor(encodeProjectCursor({ ...cursor, hostId: "" }))).toBeNull();
  });
});
