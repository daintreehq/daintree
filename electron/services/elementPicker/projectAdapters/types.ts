import type {
  ProjectAdapterId,
  ProjectContext,
} from "../../../../shared/elementPicker/projectContext.js";
import type { SourceRoots } from "../sourceAccess.js";
import type { ProjectFileReader } from "./fs.js";

export interface ProjectContextRequest {
  /** What every file the context names is a `SourceFileRef` in. */
  workspaceId: string;
  /** The app is `roots.appRoot`: an adapter describes the app it is given and never looks for another. */
  roots: SourceRoots;
  /** The preview URL's path. An adapter never sees the host, and never fetches anything. */
  pathname: string;
  /** Contained to the workspace and bound to `signal`. */
  reader: ProjectFileReader;
  /** Aborted by the deadline, the caller, or the workspace closing. */
  signal: AbortSignal;
}

/** Reads one meta-framework's project layout. Loaded only for an app its registration detected. */
export interface ProjectAdapter {
  describe(request: ProjectContextRequest): Promise<ProjectContext>;
}

/**
 * What the host knows about an adapter before loading it: cheap enough to ask
 * of every app, so an adapter's own code, a route parser among it, is only
 * evaluated for an app it applies to.
 */
export interface ProjectAdapterRegistration {
  readonly id: ProjectAdapterId;
  /** Read off the app's own `package.json`, already parsed. */
  detects(manifest: Readonly<Record<string, unknown>>): boolean;
  load(): Promise<ProjectAdapter>;
}
