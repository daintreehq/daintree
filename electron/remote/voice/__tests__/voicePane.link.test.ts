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
import { MAX_PANE_TERMS, MAX_PANE_VOCABULARY, VoicePaneLinkMethod } from "../linkMethods.js";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  it("keeps an answer whole when one of its strings is longer than the Shell takes", async () => {
    const commandTarget = START.commandTarget!;
    const [review] = commandTarget.vocabulary.entries;
    deps.readStart.mockResolvedValueOnce({
      ...START,
      keyterms: { ...START.keyterms, terminalTerms: ["x".repeat(10_000), "hostPaneOf"] },
      commandTarget: {
        ...commandTarget,
        vocabulary: {
          ...commandTarget.vocabulary,
          entries: [{ ...review!, description: "d".repeat(10_000) }],
        },
      },
    });
    const read = await client.readStart(HOST, SCOPE, { timeoutMs: 500 });
    expect(read?.keyterms.terminalTerms).toEqual(["hostPaneOf"]);
    expect(read?.commandTarget?.vocabulary.entries[0]?.token).toBe("/review");
    expect(read?.names).toEqual(START.names);
  });

  it("leaves out a command whose name runs past the limits, keeping the rest", async () => {
    const commandTarget = START.commandTarget!;
    const [review] = commandTarget.vocabulary.entries;
    const long = "deep:".repeat(80);
    deps.readStart.mockResolvedValueOnce({
      ...START,
      commandTarget: {
        ...commandTarget,
        vocabulary: {
          ...commandTarget.vocabulary,
          entries: [{ ...review!, token: `/${long}`, key: long }, review!],
        },
      },
    });
    const read = await client.readStart(HOST, SCOPE, { timeoutMs: 500 });
    expect(read?.commandTarget?.vocabulary.entries.map((entry) => entry.token)).toEqual([
      "/review",
    ]);
  });

  it("keeps the newest of a vocabulary too long to send whole", async () => {
    const vocabulary = Array.from({ length: MAX_PANE_VOCABULARY + 5 }, (_, i) => ({
      term: `term${i}`,
      heardAs: [],
      source: "manual" as const,
      addedAt: i,
    }));
    deps.readStart.mockResolvedValueOnce({ ...START, vocabulary });
    const read = await client.readStart(HOST, SCOPE, { timeoutMs: 500 });
    expect(read?.vocabulary).toHaveLength(MAX_PANE_VOCABULARY);
    expect(read?.vocabulary.at(-1)?.term).toBe(`term${MAX_PANE_VOCABULARY + 4}`);
    expect(read?.vocabulary.some((entry) => entry.term === "term0")).toBe(false);
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

describe("each host's pane stays its own", () => {
  it("reads two hosts' panes of the same ids from each host, whatever order they answer in", async () => {
    const other = await openSessionPair(dir);
    pairs.push(other);
    const first = deferred<PaneStartContext>();
    const second = deferred<PaneStartContext>();
    deps.readStart.mockReturnValueOnce(first.promise);
    const otherDeps = {
      ...deps,
      readStart: vi.fn(() => second.promise),
      readCorrection: vi.fn(async () => ({ ...CORRECTION, terminalOutput: "other host" })),
    };
    const uninstallOther = installVoicePaneHostWith(
      { sessions: [{ session: other.host }], onSession: () => () => {} },
      otherDeps as unknown as VoicePaneHostDeps
    );
    sessionByHost.set("studio-04", other.client);
    try {
      const fromFirst = client.readStart(HOST, SCOPE, { timeoutMs: 2_000 });
      const fromSecond = client.readStart("studio-04", SCOPE, { timeoutMs: 2_000 });
      await vi.waitFor(() => expect(otherDeps.readStart).toHaveBeenCalled());
      second.resolve({ ...START, projectName: "other host" });
      first.resolve(START);
      await expect(fromFirst).resolves.toMatchObject({ projectName: "daintree" });
      await expect(fromSecond).resolves.toMatchObject({ projectName: "other host" });
      await expect(
        client.readCorrection("studio-04", SCOPE, { timeoutMs: 2_000 })
      ).resolves.toMatchObject({ terminalOutput: "other host" });
      expect(deps.readCorrection).not.toHaveBeenCalled();
    } finally {
      uninstallOther();
    }
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
    expect(waited).toBeLessThan(5_000);
  });

  it("stops waiting once the dictation that asked is gone", async () => {
    deps.readStart.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    // Far past the test's own limit: only the abort can settle it in time.
    const read = client.readStart(HOST, SCOPE, { timeoutMs: 600_000, signal: controller.signal });
    await vi.waitFor(() => expect(deps.readStart).toHaveBeenCalled());
    controller.abort();
    await expect(read).resolves.toBeNull();
  });

  it("asks nothing of a session that has closed", async () => {
    sessions.client.close("test");
    await expect(client.readStart(HOST, SCOPE, { timeoutMs: 500 })).resolves.toBeNull();
    expect(deps.readStart).not.toHaveBeenCalled();
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
