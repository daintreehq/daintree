import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../persistence/schema.js";

const CREATE_TABLES_SQL = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    last_opened INTEGER NOT NULL,
    color TEXT,
    status TEXT,
    daintree_config_present INTEGER,
    in_repo_settings INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    frecency_score REAL NOT NULL DEFAULT 3.0,
    last_accessed_at INTEGER NOT NULL DEFAULT 0,
    last_completion_seen_at INTEGER,
    auto_parked_at INTEGER,
    resumable_agent_count INTEGER,
    stats_commit_count INTEGER,
    stats_issue_count INTEGER,
    stats_pr_count INTEGER,
    stats_provider_id TEXT,
    stats_last_updated INTEGER,
    git_backed INTEGER,
    archived_at INTEGER,
    group_id TEXT
  );
  CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

let db: ReturnType<typeof drizzle<typeof schema>>;

vi.mock("../persistence/db.js", () => ({ getSharedDb: () => db }));

// The group store only needs the project row's filing fields, so the real
// ProjectStore (and its electron/git dependencies) stays out of this suite.
vi.mock("../ProjectStore.js", () => {
  const read = (id: string) => {
    const row = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      ...(row.groupId ? { groupId: row.groupId } : {}),
      ...(typeof row.archivedAt === "number" ? { archivedAt: row.archivedAt } : {}),
    };
  };
  return {
    projectStore: {
      getProjectById: read,
      updateProject: (
        id: string,
        updates: { groupId?: string | null; archivedAt?: number | null }
      ) => {
        db.update(schema.projects).set(updates).where(eq(schema.projects.id, id)).run();
        const project = read(id);
        if (!project) throw new Error(`Project not found: ${id}`);
        return project;
      },
    },
  };
});

const { ProjectGroupStore } = await import("../ProjectGroupStore.js");

function addProject(id: string, groupId: string | null = null): void {
  db.insert(schema.projects)
    .values({ id, path: `/p/${id}`, name: id, emoji: "🌲", lastOpened: 0, groupId })
    .run();
}

describe("ProjectGroupStore", () => {
  let store: InstanceType<typeof ProjectGroupStore>;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.exec(CREATE_TABLES_SQL);
    db = drizzle(sqlite, { schema });
    store = new ProjectGroupStore();
  });

  it("starts empty and appends groups in creation order", () => {
    expect(store.list()).toEqual([]);
    store.create("Daintree");
    store.create("Crisp Vector");
    expect(store.list().map((g) => [g.name, g.position, g.sortMode])).toEqual([
      ["Daintree", 0, "mostUsed"],
      ["Crisp Vector", 1, "mostUsed"],
    ]);
  });

  it("trims names and refuses empty, overlong and case-insensitive duplicates", () => {
    expect(store.create("  Games  ").group.name).toBe("Games");
    expect(() => store.create("   ")).toThrow("Give the group a name");
    expect(() => store.create("x".repeat(41))).toThrow("up to 40 characters");
    expect(() => store.create("games")).toThrow('A group called "games" already exists');
  });

  it("renames, but not onto another group's name", () => {
    const { group: a } = store.create("A");
    store.create("B");
    expect(store.rename(a.id, "Alpha").map((g) => g.name)).toEqual(["Alpha", "B"]);
    expect(() => store.rename(a.id, "b")).toThrow("already exists");
    // Renaming to its own name in another case is allowed: it is the same group.
    expect(store.rename(a.id, "ALPHA")[0]!.name).toBe("ALPHA");
  });

  it("reorders to exactly the given permutation and rejects anything else", () => {
    const a = store.create("A").group;
    const b = store.create("B").group;
    const c = store.create("C").group;
    expect(store.reorder([c.id, a.id, b.id]).map((g) => [g.name, g.position])).toEqual([
      ["C", 0],
      ["A", 1],
      ["B", 2],
    ]);
    expect(() => store.reorder([a.id, b.id])).toThrow("changed");
    expect(() => store.reorder([a.id, a.id, b.id])).toThrow("changed");
  });

  it("sets a group's sort mode and refuses unknown modes", () => {
    const { group } = store.create("A");
    expect(store.setSortMode(group.id, "alphabetical")[0]!.sortMode).toBe("alphabetical");
    expect(() => store.setSortMode(group.id, "loudest")).toThrow("Unknown sort order");
  });

  it("deletes a group, releases its members and renumbers the rest", () => {
    const a = store.create("A").group;
    const b = store.create("B").group;
    addProject("p1", a.id);
    addProject("p2", a.id);
    addProject("p3", b.id);

    const { groups, releasedProjects } = store.delete(a.id);

    expect(groups.map((g) => [g.name, g.position])).toEqual([["B", 0]]);
    expect(releasedProjects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
    expect(releasedProjects.every((p) => p.groupId === undefined)).toBe(true);
    const p3 = db.select().from(schema.projects).where(eq(schema.projects.id, "p3")).get();
    expect(p3?.groupId).toBe(b.id);
  });

  it("files a project under an existing group only", () => {
    const { group } = store.create("A");
    addProject("p1");
    expect(store.setMembership("p1", group.id).groupId).toBe(group.id);
    expect(store.setMembership("p1", null).groupId).toBeUndefined();
    expect(() => store.setMembership("p1", "nope")).toThrow("no longer exists");
  });

  it("keeps the original archive time when archiving twice", () => {
    addProject("p1");
    const first = store.setArchived("p1", true);
    expect(typeof first.archivedAt).toBe("number");
    const again = store.setArchived("p1", true);
    expect(again.archivedAt).toBe(first.archivedAt);
    expect(store.setArchived("p1", false).archivedAt).toBeUndefined();
  });

  it("drops a malformed stored group instead of losing the whole list", () => {
    db.insert(schema.appState)
      .values({
        key: "projectGroups",
        value: JSON.stringify({
          version: 1,
          groups: [
            { id: "g1", name: "Good", position: 0, sortMode: "recent", createdAt: 1 },
            { id: "g2", name: "", position: 1, sortMode: "recent", createdAt: 2 },
            { id: "g3", name: "Bad mode", position: 2, sortMode: "nope", createdAt: 3 },
          ],
        }),
      })
      .run();
    expect(store.list().map((g) => g.id)).toEqual(["g1"]);
  });

  it("reads a duplicated id once and closes gaps, so a new group lands last", () => {
    db.insert(schema.appState)
      .values({
        key: "projectGroups",
        value: JSON.stringify({
          version: 1,
          groups: [
            { id: "g1", name: "First", position: 0, sortMode: "recent", createdAt: 5 },
            { id: "g1", name: "Copy", position: 1, sortMode: "recent", createdAt: 6 },
            {
              id: "g3",
              name: "Third",
              position: 4,
              sortMode: "recent",
              createdAt: 9_999_999_999_999,
            },
          ],
        }),
      })
      .run();
    expect(store.list().map((g) => [g.id, g.name, g.position])).toEqual([
      ["g1", "First", 0],
      ["g3", "Third", 1],
    ]);
    const { groups } = store.create("Fourth");
    expect(groups.map((g) => g.name)).toEqual(["First", "Third", "Fourth"]);
  });
});
