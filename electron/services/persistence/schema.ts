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
    // Timestamp (ms) the background-idle auto-close swept this project to `closed`.
    // Null for projects closed manually or still open; drives the distinct
    // "Suspended to free memory" label in the project switcher. Cleared when the
    // project is reopened (`setCurrentProject`).
    autoParkedAt: integer("auto_parked_at"),
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
  // Set when the auto-cleanup sweep tombstones a stale scratch. The DB row is
  // retained as crash-safe state so a partially-deleted directory can be
  // re-attempted on the next startup; rows with `deletedAt` set are filtered
  // out of all renderer-facing queries.
  deletedAt: integer("deleted_at"),
});

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsertRow = typeof projects.$inferInsert;

export type ScratchRow = typeof scratches.$inferSelect;
export type ScratchInsertRow = typeof scratches.$inferInsert;
