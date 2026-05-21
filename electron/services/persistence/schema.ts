import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
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
});

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
