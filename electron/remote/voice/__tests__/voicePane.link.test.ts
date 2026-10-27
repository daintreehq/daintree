// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PaneCorrectionContext,
  PaneScope,
  PaneStartContext,
} from "../../../services/voice/paneContext.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { LINK_HEADROOM_MS, VoicePaneHostsClient } from "../client.js";
import { installVoicePaneHostWith, type VoicePaneHostDeps } from "../host.js";
import { MAX_PANE_TERMS, VoicePaneLinkMethod } from "../linkMethods.js";

const HOST = "studio-03";
const SCOPE: PaneScope = { projectId: "proj-1", terminalId: "term-1" };

const START: PaneStartContext = {
  projectName: "daintree",
  vocabulary: [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }],
  names: { hosts: [], projects: [], worktrees: ["feature-voice"] },
  keyterms: {
    repoNames: ["@daintree/plugin-kit"],
    branchName: "feature/voice-hosts",
    terminalTerms: ["PtyClient", "hostPaneOf"],
  },
  commandTarget: {
    agentId: "claude",
    agentName: "Claude",
    isAssistant: false,
    vocabulary: {
      entries: [
        {
          token: "/review",
          prefix: "/",
          spokenName: "review",
          key: "review",
          scope: "built-in",
          description: "Review the changes",
        },
      ],
      prefixes: [{ prefix: "/", spoken: [["slash"]] }],
    },
  },
};

const CORRECTION: PaneCorrectionContext = {
  project: { name: "daintree", path: "/home/greg/daintree" },
  vocabulary: START.vocabulary,
  commandTarget: START.commandTarget,
  terminalOutput: "$ npm test\nAll green",
};

let dir: string;
let pairs: Array<{ host: LinkSession; client: LinkSession }>;
let sessions: { host: LinkSession; client: LinkSession };
let deps: { [K in keyof VoicePaneHostDeps]: ReturnType<typeof vi.fn> };
let uninstall: (() => void) | null;
let sessionByHost: Map<string, LinkSession>;
let client: VoicePaneHostsClient;

function serve(session: LinkSession): () => void {
  return installVoicePaneHostWith(
    { sessions: [{ session }], onSession: () => () => {} },
    deps as unknown as VoicePaneHostDeps
  );
}

beforeEach(async () => {
  dir = await makeTempDir();
  sessions = await openSessionPair(dir);
  pairs = [sessions];
  deps = {
    readStart: vi.fn(async () => START),
    readCorrection: vi.fn(async () => CORRECTION),
    findFileCandidates: vi.fn(async (_scope: PaneScope, descriptions: readonly string[]) =>
      descriptions.map((description) => [`src/${description.replace(/\s+/g, "")}.ts`])
    ),
    readProject: vi.fn(() => CORRECTION.project),
  };
  uninstall = serve(sessions.host);
  sessionByHost = new Map([[HOST, sessions.client]]);
  client = new VoicePaneHostsClient({ sessionFor: (hostId) => sessionByHost.get(hostId) ?? null });
});

afterEach(async () => {
  uninstall?.();
  for (const { host, client: shell } of pairs) {
    host.close("test");
    shell.close("test");
  }
  await removeTempDir(dir);
});

describe("dictating into a host's pane reads the pane from that host", () => {
  it("reads the start context the host read, asking within the Shell's wait", async () => {
    const read = await client.readStart(HOST, SCOPE, { timeoutMs: 500 });
    expect(read).toEqual(START);
    expect(deps.readStart).toHaveBeenCalledWith(SCOPE, 500 - LINK_HEADROOM_MS);
  });

  it("reads the cleanup context, the recent output included", async () => {
    const read = await client.readCorrection(HOST, SCOPE, { timeoutMs: 1500 });
    expect(read).toEqual(CORRECTION);
    expect(deps.readCorrection).toHaveBeenCalledWith(SCOPE, 1500 - LINK_HEADROOM_MS);
  });

  it("gets one candidate list per spoken reference, in order", async () => {
    const read = await client.findFileCandidates(HOST, SCOPE, ["voice input", "pane context"], {
      timeoutMs: 6000,
    });
    expect(read).toEqual([["src/voiceinput.ts"], ["src/panecontext.ts"]]);
  });

  it("reads the project's name and folder for a rewrite", async () => {
    await expect(client.readProject(HOST, "proj-1", { timeoutMs: 500 })).resolves.toEqual(
      CORRECTION.project
    );
    expect(deps.readProject).toHaveBeenCalledWith("proj-1");
  });

  it("cuts what the host sends to what the Shell accepts", async () => {
    const many = Array.from({ length: MAX_PANE_TERMS + 40 }, (_, i) => `termName${i}`);
    deps.readStart.mockResolvedValueOnce({
      ...START,
      keyterms: { ...START.keyterms, terminalTerms: many },
    });
    const read = await client.readStart(HOST, SCOPE, { timeoutMs: 500 });
    expect(read?.keyterms.terminalTerms).toEqual(many.slice(0, MAX_PANE_TERMS));
  });

  it("re-reads the vocabulary as a dictionary, dropping entries that aren't one", async () => {
    deps.readStart.mockResolvedValueOnce({
      ...START,
      vocabulary: [...START.vocabulary, { heardAs: ["no term"] }, 42],
    });
    const read = await client.readStart(HOST, SCOPE, { timeoutMs: 500 });
    expect(read?.vocabulary.map((entry) => entry.term)).toEqual(["Zustand"]);
  });
});

describe("a host that can't give the pane's context gives none", () => {
  it("never dials a host with no session", async () => {
    await expect(client.readStart("studio-04", SCOPE, { timeoutMs: 500 })).resolves.toBeNull();
  });

  it("reads nothing from a host too old to know the methods", async () => {
    uninstall?.();
    uninstall = null;
    await expect(client.readStart(HOST, SCOPE, { timeoutMs: 500 })).resolves.toBeNull();
    await expect(client.readCorrection(HOST, SCOPE, { timeoutMs: 500 })).resolves.toBeNull();
  });

  it("stops waiting for a host that doesn't answer in time", async () => {
    deps.readStart.mockImplementationOnce(() => new Promise(() => {}));
    const startedAt = performance.now();
    await expect(client.readStart(HOST, SCOPE, { timeoutMs: 150 })).resolves.toBeNull();
    const waited = performance.now() - startedAt;
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(1_000);
  });

  it("stops waiting once the dictation that asked is gone", async () => {
    deps.readStart.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const read = client.readStart(HOST, SCOPE, { timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    await expect(read).resolves.toBeNull();
  });

  it("trusts no answer out of shape", async () => {
    deps.readCorrection.mockResolvedValueOnce({ ...CORRECTION, terminalOutput: 42 });
    await expect(client.readCorrection(HOST, SCOPE, { timeoutMs: 500 })).resolves.toBeNull();
  });

  it("trusts no candidate lists that don't line up with the references asked", async () => {
    deps.findFileCandidates.mockResolvedValueOnce([["src/one.ts"]]);
    await expect(
      client.findFileCandidates(HOST, SCOPE, ["one", "two"], { timeoutMs: 500 })
    ).resolves.toBeNull();
  });

  it("refuses a request naming no project", async () => {
    const answer = sessions.client.call(VoicePaneLinkMethod.START, {
      projectId: "",
      terminalId: null,
      budgetMs: 400,
    });
    await expect(answer).rejects.toMatchObject({ code: "VALIDATION" });
    expect(deps.readStart).not.toHaveBeenCalled();
  });

  it("stops answering once uninstalled", async () => {
    uninstall?.();
    uninstall = null;
    await expect(client.readProject(HOST, "proj-1", { timeoutMs: 500 })).resolves.toBeNull();
    expect(deps.readProject).not.toHaveBeenCalled();
  });
});
