/**
 * A link saved with one project and offered only with that project (#17091).
 * Kept in the project's local settings, never in the committed settings file,
 * so a cloned repository can't seed it.
 */
export interface ProjectLink {
  id: string;
  title: string;
  url: string;
  /** Set while the link is as the Assistant left it. A change made by hand clears it. */
  addedByAssistant?: true;
}

/** A manifest at the project's root that can name the project's addresses (#17252, #17254). */
export type DeclaredProjectLinkSource =
  "package.json" | "pyproject.toml" | "Cargo.toml" | "catalog-info.yaml";

/**
 * A link one of the project's own manifests declares. Read from the file each
 * time and never saved, so it can't be edited or removed from Daintree.
 */
export interface DeclaredProjectLink {
  source: DeclaredProjectLinkSource;
  title: string;
  url: string;
}

/** Who is changing a project's links: the Assistant is held to its own links and a narrower URL rule. */
export type ProjectLinkActor = "user" | "assistant";

export type ProjectLinkChange =
  | { op: "add"; title: string; url: string }
  | { op: "update"; id: string; title?: string; url?: string }
  /** `onlyIfAddedByAssistant` is an Undo of the Assistant's add: a link someone has since taken over stays. */
  | { op: "remove"; id: string; onlyIfAddedByAssistant?: boolean };

export interface ProjectLinksChangePayload {
  projectId: string;
  actor: ProjectLinkActor;
  change: ProjectLinkChange;
}

export type ProjectLinkRefusal =
  "invalid-title" | "invalid-url" | "limit" | "not-found" | "not-added-by-assistant";

/** `saved` rather than `ok`: an IPC handler's result can't carry the envelope's own keys. */
export type ProjectLinksChangeResult =
  | {
      saved: true;
      /** The project's links as saved. */
      links: ProjectLink[];
      /** The link added or updated, or the one removed. */
      link: ProjectLink;
    }
  | { saved: false; code: ProjectLinkRefusal; message: string };
