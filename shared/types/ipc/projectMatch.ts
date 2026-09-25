export interface FindProjectMatchPayload {
  remoteUrls: string[];
  committedProjectId: string | null;
}

export interface ProjectMatchCandidate {
  projectId: string | null;
  path: string;
  name: string;
  remotes: Array<{ name: string; url: string }>;
  /** "registered" is a Daintree project; "on-disk" is an unregistered clone found by scanning. */
  source: "registered" | "on-disk";
  matchedBy: "remote-url" | "committed-id";
  lastOpenedAt: number | null;
}
