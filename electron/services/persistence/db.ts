import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import path from "path";
import * as schema from "./schema.js";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    queued_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    dependencies TEXT NOT NULL DEFAULT '[]',
    worktree_id TEXT,
    assigned_agent_id TEXT,
    run_id TEXT,
    metadata TEXT,
    result TEXT,
    routing_hints TEXT
  );

  CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project_id, status);

  CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_version TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    definition TEXT NOT NULL,
    node_states TEXT NOT NULL DEFAULT '{}',
    task_mapping TEXT NOT NULL DEFAULT '{}',
    scheduled_nodes TEXT NOT NULL DEFAULT '[]',
    evaluated_conditions TEXT NOT NULL DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS workflow_runs_project_idx ON workflow_runs(project_id);
  CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx ON workflow_runs(project_id, status);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    last_opened INTEGER NOT NULL,
    color TEXT,
    status TEXT,
    canopy_config_present INTEGER,
    in_repo_settings INTEGER
  );

  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

let sharedInstance: { sqlite: Database.Database; db: AppDb } | null = null;

export function getSharedDb(): AppDb {
  if (!sharedInstance) {
    const dbPath = path.join(app.getPath("userData"), "canopy.db");
    sharedInstance = openDb(dbPath);
  }
  return sharedInstance.db;
}

export function openDb(dbPath: string): { sqlite: Database.Database; db: AppDb } {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 3000");
  sqlite.exec(CREATE_TABLES_SQL);

  // Migrate: add pinned column to projects table if it doesn't exist
  const cols = sqlite.pragma("table_info(projects)") as { name: string }[];
  if (!cols.some((c) => c.name === "pinned")) {
    sqlite.prepare("ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0").run();
  }

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

export function closeSharedDb(): void {
  if (sharedInstance) {
    sharedInstance.sqlite.close();
    sharedInstance = null;
  }
}
