/**
 * GitLab REST v4 response shapes — the subset of fields the plugin reads.
 * Responses are treated defensively (fields may be absent on older
 * self-managed instances), so every field is optional unless GitLab has
 * carried it since API v4 was frozen. Full payloads ride through to the
 * contract shapes as `rawData`.
 */

export interface GitLabUser {
  id?: number;
  username?: string;
  name?: string;
  avatar_url?: string | null;
  web_url?: string;
}

/** Labels arrive as plain names on issue/MR payloads (`labels: string[]`). */
export interface GitLabIssue {
  id?: number;
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  web_url?: string;
  author?: GitLabUser | null;
  assignees?: GitLabUser[] | null;
  labels?: string[] | null;
  user_notes_count?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

export interface GitLabMergeRequest {
  id?: number;
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  web_url?: string;
  author?: GitLabUser | null;
  assignees?: GitLabUser[] | null;
  labels?: string[] | null;
  source_branch?: string;
  target_branch?: string;
  user_notes_count?: number;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  head_pipeline?: GitLabPipeline | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  merged_at?: string | null;
}

export interface GitLabPipeline {
  id?: number;
  status?: string;
  web_url?: string;
}

export interface GitLabProject {
  id?: number;
  path_with_namespace?: string;
  default_branch?: string;
  visibility?: string;
  archived?: boolean;
  description?: string | null;
  topics?: string[] | null;
  forked_from_project?: unknown;
  license?: { name?: string | null; nickname?: string | null } | null;
  open_issues_count?: number;
}

export interface GitLabRelease {
  name?: string;
  tag_name?: string;
  description?: string | null;
  released_at?: string | null;
  created_at?: string;
  upcoming_release?: boolean;
  _links?: { self?: string } | null;
}

export interface GitLabNote {
  id?: number;
  body?: string;
  author?: GitLabUser | null;
  created_at?: string;
}

/** `GET /personal_access_tokens/self` — PAT introspection (404s for OAuth tokens). */
export interface GitLabTokenIntrospection {
  scopes?: string[] | null;
  expires_at?: string | null;
  active?: boolean;
}

/** Renderer↔main config projection for the settings tab. */
export interface GitLabTokenValidation {
  valid: boolean;
  username?: string;
  avatarUrl?: string;
  scopes?: string[];
  error?: string;
}
