import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    emoji: text("emoji").notNull(),
    lastOpened: integer("last_opened").notNull(),
    color: text("color"),
    status: text("status"),
    daintreeConfigPresent: integer("daintree_config_present", { mode: "boolean" }),
    inRepoSettings: integer("in_repo_settings", { mode: "boolean" }),
    pinned: integer("pinned").notNull().default(0),
    frecencyScore: real("frecency_score").notNull().default(3.0),
    lastAccessedAt: integer("last_accessed_at").notNull().default(0),
    // Epoch ms up to which the user has seen this project's completed agents:
    // stamped after the project has been current in a focused window for a
    // 2s dwell. Completions with a later lastStateChange are "unacknowledged"
    // and hold the project in the switcher's Needs attention band — there is
    // deliberately no time-based expiry, so work finished while the user was
    // away stays surfaced until actually seen. Null = nothing ever seen.
    lastCompletionSeenAt: integer("last_completion_seen_at"),
    // Timestamp (ms) the background-idle auto-close swept this project to `closed`.
    // Null for projects closed manually or still open; drives the distinct
    // "Suspended to free memory" label in the project switcher. Cleared when the
    // project is reopened (`setCurrentProject`).
    autoParkedAt: integer("auto_parked_at"),
    // False for a folder adopted without git (issue #11405). Null for every
    // legacy row and every repository-backed project — absence means
    // git-backed, so no backfill is needed.
    gitBacked: integer("git_backed", { mode: "boolean" }),
    // Last-known repository counts (issue #11078), so switch-back can seed the
    // toolbar pills from real numbers instead of em-dashes that resize once a
    // poll lands. All nullable: absent until the project's first clean stats
    // poll. `statsCommitCount` is local-git and survives on its own, so a
    // project with no forge provider still holds its commit pill;
    // `statsProviderId` scopes the forge counts to the provider that reported
    // them, and `statsLastUpdated` records when they last changed.
    statsCommitCount: integer("stats_commit_count"),
    statsIssueCount: integer("stats_issue_count"),
    statsPrCount: integer("stats_pr_count"),
    statsProviderId: text("stats_provider_id"),
    statsLastUpdated: integer("stats_last_updated"),
  },
  (table) => [
    // Equality lookup for getProjectByPath().
    index("projects_path_idx").on(table.path),
    // Ordering index for getAllProjects()'s `ORDER BY frecency_score DESC,
    // last_opened DESC`. Declared ASC/ASC: SQLite reverse-scans it to satisfy a
    // DESC/DESC order-by (both terms same direction), skipping the sort as the
    // projects list grows.
    index("projects_frecency_last_opened_idx").on(table.frecencyScore, table.lastOpened),
  ]
);

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const scratches = sqliteTable("scratches", {
  id: text("id").primaryKey(),
  path: text("path").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  lastOpened: integer("last_opened").notNull(),
  // Millisecond timestamp set when the auto-cleanup sweep tombstones a stale
  // scratch. The DB row is retained as crash-safe state: the directory is only
  // physically reaped on a later sweep once this timestamp is older than the
  // grace window (SCRATCH_CLEANUP_GRACE_MS), which also covers re-attempting a
  // partially-deleted directory. Rows with `deletedAt` set are filtered out of
  // all renderer-facing queries.
  deletedAt: integer("deleted_at"),
});

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsertRow = typeof projects.$inferInsert;

export type ScratchRow = typeof scratches.$inferSelect;
export type ScratchInsertRow = typeof scratches.$inferInsert;
