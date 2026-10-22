import type { ProjectThemeChoice } from "../../theme/types.js";

/** A project's own theme changed (#13833); main sends it to every view of that project. */
export interface ProjectThemeChange {
  projectId: string;
  /** Null when the project follows the global theme and has answered no suggestion. */
  choice: ProjectThemeChoice | null;
}

/** The project's choice, plus the theme its `.daintree/project.json` suggests. */
export interface ProjectThemeSnapshot extends ProjectThemeChange {
  /** A built-in or plugin theme id, as the repository names it; null when it suggests none. */
  suggestedSchemeId: string | null;
}
