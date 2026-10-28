import type { FixtureRepo } from "../../../helpers/fixtures";
import { createFixtureProject } from "../fixtureProject";

/**
 * A framework's fixture site: the same page in each — a heading, a line of
 * copy and three cards drawn by a child component — so every spec picks the
 * same things and only what the framework exposes differs.
 */
export interface FixtureSite {
  /** Names the throwaway repo. */
  name: string;
  /** The project's name in the app. */
  title: string;
  files: Readonly<Record<string, string>>;
  /** False for a site with nothing to install. */
  install?: boolean;
  installTimeoutMs?: number;
}

export function createSiteProject(site: FixtureSite): FixtureRepo {
  return createFixtureProject(site.name, site.files, {
    install: site.install,
    installTimeoutMs: site.installTimeoutMs,
  });
}

/** The cards every fixture draws, as a JavaScript literal. */
export const FEATURES_LITERAL = `[
  { title: "Select", body: "Click anything on the page." },
  { title: "Ask", body: "Describe the change you want." },
  { title: "Ship", body: "Your agent edits the source." },
]`;

/** A Vite dev or preview server on the port the spec chose, refusing any other. */
export function viteCommand(script: string, port: number): string {
  return `npm run ${script} -- --host 127.0.0.1 --port ${port} --strictPort`;
}
