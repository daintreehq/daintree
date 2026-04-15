import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    priority: integer("priority").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    queuedAt: integer("queued_at"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    dependencies: text("dependencies").notNull().default("[]"),
    worktreeId: text("worktree_id"),
    assignedAgentId: text("assigned_agent_id"),
    runId: text("run_id"),
    metadata: text("metadata"),
    result: text("result"),
    routingHints: text("routing_hints"),
  },
  (t) => [
    index("tasks_project_idx").on(t.projectId),
    index("tasks_project_status_idx").on(t.projectId, t.status),
  ]
);

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

export type TaskRow = typeof tasks.$inferInsert;

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsertRow = typeof projects.$inferInsert;
