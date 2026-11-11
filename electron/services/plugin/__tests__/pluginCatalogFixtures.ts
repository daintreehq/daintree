/** Catalog documents shared by the schema and service suites. */

export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "0123456789abcdef".repeat(4);
export const DIGEST_C = "c".repeat(64);

export function catalogEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "daintreehq.continue-session",
    repo: "https://github.com/daintreehq/plugin-continue-session",
    version: "0.1.1",
    url: "https://github.com/daintreehq/plugin-continue-session/releases/download/v0.1.1/daintreehq.continue-session-0.1.1.dntr",
    sha256: DIGEST_B,
    capabilities: ["fs:user-data-read", "mcp:expose"],
    ...overrides,
  };
}

/** Two releases of one plugin plus a second plugin: every reviewed release stays listed. */
export const VALID_CATALOG = {
  entries: [
    catalogEntry({
      version: "0.1.0",
      url: "https://github.com/daintreehq/plugin-continue-session/releases/download/v0.1.0/daintreehq.continue-session-0.1.0.dntr",
      sha256: DIGEST_A,
    }),
    catalogEntry(),
    {
      id: "acme.linear-context",
      repo: "https://github.com/acme/linear-context",
      version: "2.0.0-rc.1+build.7",
      url: "https://github.com/acme/linear-context/releases/download/acme.linear-context%402.0.0-rc.1/acme.linear-context-2.0.0-rc.1.dntr",
      sha256: DIGEST_C,
      capabilities: [],
    },
  ],
};

/** One good entry beside one whose url is a `latest/download` redirect. */
export const CATALOG_WITH_MALFORMED_ENTRY = {
  entries: [
    catalogEntry(),
    catalogEntry({
      id: "acme.drifting",
      repo: "https://github.com/acme/drifting",
      url: "https://github.com/acme/drifting/releases/latest/download/acme.drifting.dntr",
    }),
  ],
};
