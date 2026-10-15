// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigBundlePreviewSection,
  ConfigBundleSectionId,
  ConfigImportReport,
} from "../../../../shared/types/configBundle.js";
import type { CapturedSection } from "../../../services/ConfigBundleService.js";
import type { LinkSession } from "../../link/session.js";
import type { LastCopyRecord } from "../LastCopyStore.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import { ClientSettingsCopy } from "../ClientSettingsCopy.js";
import { HostSettingsCopy } from "../HostSettingsCopy.js";
import { SettingsCopyLinkMethod } from "../linkMethods.js";

const HOST = "studio-01";

type Sections = Partial<Record<ConfigBundleSectionId, unknown>>;

/** A host whose settings are one mutable record per section, with real revisions over it. */
function fakeHostService() {
  const settings: Record<string, unknown> = {
    agentSettings: { claude: { customFlags: "--old" } },
    worktreeConfig: { pathPattern: "{parent-dir}/{base-folder}-worktrees/{branch-slug}" },
  };
  const previewed: Sections[] = [];
  const applied: Sections[] = [];
  return {
    settings,
    previewed,
    applied,
    service: {
      preview: vi.fn(async (incoming: Sections): Promise<ConfigBundlePreviewSection[]> => {
        previewed.push(incoming);
        return Object.keys(incoming).map((id) => ({
          section: id as ConfigBundleSectionId,
          add: 0,
          update: 1,
          unchanged: 0,
          changes: [{ key: id, label: id, kind: "update" as const }],
        }));
      }),
      revision: vi.fn(async (ids: readonly string[]) =>
        JSON.stringify(ids.map((id) => [id, settings[id]]))
      ),
      apply: vi.fn(
        async (
          incoming: Sections,
          options: { capture?: CapturedSection[] } = {}
        ): Promise<ConfigImportReport> => {
          applied.push(incoming);
          for (const [id, payload] of Object.entries(incoming)) {
            options.capture?.push({
              section: id as ConfigBundleSectionId,
              leaves: [{ key: id, before: settings[id], after: payload }],
            });
            settings[id] = payload;
          }
          return {
            outcome: "applied",
            sections: Object.keys(incoming).map((id) => ({
              section: id as ConfigBundleSectionId,
              present: true,
              applied: 1,
              unchanged: 0,
              skipped: 0,
              failed: 0,
              leaves: [{ key: id, status: "applied" as const }],
              errors: [],
            })),
            errors: [],
            rolledBack: false,
          };
        }
      ),
      undo: vi.fn(async (sections: readonly CapturedSection[]) =>
        sections.map(({ section, leaves }) => ({
          section,
          leaves: leaves.map((leaf) => {
            if (JSON.stringify(settings[leaf.key]) !== JSON.stringify(leaf.after)) {
              return { key: leaf.key, status: "edited" as const };
            }
            settings[leaf.key] = leaf.before;
            return { key: leaf.key, status: "restored" as const };
          }),
        }))
      ),
    },
  };
}

function memoryRecords() {
  const box: { record: LastCopyRecord | null } = { record: null };
  return {
    box,
    read: vi.fn(async () => structuredClone(box.record)),
    write: vi.fn(async (record: LastCopyRecord) => {
      box.record = structuredClone(record);
      return record;
    }),
  };
}

let dir: string;
let sessions: { host: LinkSession; client: LinkSession };
let hostSide: ReturnType<typeof fakeHostService>;
let reconcile: ReturnType<typeof vi.fn<() => Promise<void>>>;
let records: ReturnType<typeof memoryRecords>;
let host: HostSettingsCopy;
let client: ClientSettingsCopy;
let local: Sections;
let now: number;

beforeEach(async () => {
  dir = await makeTempDir();
  sessions = await openSessionPair(dir);
  hostSide = fakeHostService();
  reconcile = vi.fn(async () => {});
  records = memoryRecords();
  now = 1_000;
  host = new HostSettingsCopy({
    service: async () => hostSide.service,
    runWrite: (write) => write(),
    reconcile,
    records,
    platform: "linux",
    now: () => now,
    ticketTtlMs: 60_000,
  });
  host.attach(sessions.host, "Laptop");
  local = {
    agentSettings: {
      claude: {
        customFlags: "--new",
        globalEnv: { EDITOR: "vim", GITHUB_TOKEN: "an ordinary looking value" },
      },
    },
    worktreeConfig: { pathPattern: "~/wt/{branch-slug}" },
    globalEnvironment: {
      LANG: "en_US.UTF-8",
      NPM_TOKEN: "abc",
      ODD: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    },
  };
  client = new ClientSettingsCopy({
    sessionFor: (hostId) => (hostId === HOST ? sessions.client : null),
    isKnownHost: (hostId) => hostId === HOST,
    hostLabel: () => HOST,
    collect: async (ids) =>
      Object.fromEntries(ids.filter((id) => id in local).map((id) => [id, local[id]])),
  });
});

afterEach(async () => {
  sessions.host.close("test");
  sessions.client.close("test");
  await removeTempDir(dir);
});

describe("settings copy over a link", () => {
  it("previews on the host only the categories asked for, with the host's platform", async () => {
    const preview = await client.preview({ hostId: HOST, categories: ["agentSettings"] });
    expect(Object.keys(hostSide.previewed[0])).toEqual(["agentSettings"]);
    expect(preview.hostPlatform).toBe("linux");
    expect(preview.sections.map((s) => s.section)).toEqual(["agentSettings"]);
    expect(preview.ticket).toMatch(/^[0-9a-f]{32}$/);
  });

  it("withholds secrets by name and by value before anything leaves this machine", async () => {
    const preview = await client.preview({
      hostId: HOST,
      categories: ["agentSettings", "globalEnvironment"],
    });
    const sent = hostSide.previewed[0];
    expect(sent.agentSettings).toEqual({
      claude: { customFlags: "--new", globalEnv: { EDITOR: "vim" } },
    });
    expect(sent.globalEnvironment).toEqual({ LANG: "en_US.UTF-8" });
    expect(preview.withheld).toEqual(
      expect.arrayContaining([
        { section: "agentSettings", name: "GITHUB_TOKEN" },
        { section: "globalEnvironment", name: "NPM_TOKEN" },
        { section: "globalEnvironment", name: "ODD" },
      ])
    );
  });

  it("applies exactly what was previewed, even if this machine changed since", async () => {
    const preview = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    local.worktreeConfig = { pathPattern: "~/changed-after-preview/{branch-slug}" };
    const report = await client.apply({ hostId: HOST, ticket: preview.ticket });
    expect(report.outcome).toBe("applied");
    expect(hostSide.applied).toEqual([{ worktreeConfig: { pathPattern: "~/wt/{branch-slug}" } }]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("refuses to apply when the host's settings changed since the preview", async () => {
    const preview = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    hostSide.settings.worktreeConfig = { pathPattern: "edited on the host meanwhile" };
    await expect(client.apply({ hostId: HOST, ticket: preview.ticket })).rejects.toMatchObject({
      code: "SETTINGS_PREVIEW_STALE",
    });
    expect(hostSide.service.apply).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("uses a preview once, and not after it expires", async () => {
    const first = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: first.ticket });
    await expect(client.apply({ hostId: HOST, ticket: first.ticket })).rejects.toMatchObject({
      code: "SETTINGS_PREVIEW_STALE",
    });

    const second = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    now += 61_000;
    await expect(client.apply({ hostId: HOST, ticket: second.ticket })).rejects.toMatchObject({
      code: "SETTINGS_PREVIEW_STALE",
    });
  });

  it("never writes what the preview skipped, and reports it with the result", async () => {
    hostSide.service.preview.mockImplementationOnce(async (incoming: Sections) => [
      {
        section: "agentSettings" as ConfigBundleSectionId,
        add: 0,
        update: 1,
        unchanged: 0,
        changes: [{ key: "claude", label: "Claude", kind: "update" as const }],
        skipped: [{ key: "codex", label: "Codex", reason: "Its CLI isn't installed" }],
      },
      ...Object.keys(incoming)
        .filter((id) => id !== "agentSettings")
        .map((id) => ({
          section: id as ConfigBundleSectionId,
          add: 0,
          update: 0,
          unchanged: 0,
          changes: [],
        })),
    ]);
    local.agentSettings = { claude: { customFlags: "--a" }, codex: { customFlags: "--b" } };
    const preview = await client.preview({ hostId: HOST, categories: ["agentSettings"] });
    const report = await client.apply({ hostId: HOST, ticket: preview.ticket });
    expect(hostSide.applied[0]).toEqual({ agentSettings: { claude: { customFlags: "--a" } } });
    const section = report.sections.find((s) => s.section === "agentSettings");
    expect(section?.skipped).toBe(1);
    expect(section?.leaves).toContainEqual({
      key: "codex",
      status: "skipped",
      reason: "Its CLI isn't installed",
    });
  });

  it("reports sections the host's build doesn't know instead of failing", async () => {
    const raw = (await sessions.client.call(SettingsCopyLinkMethod.PREVIEW, {
      sections: { worktreeConfig: { pathPattern: "x/{branch-slug}" }, fromTheFuture: { a: 1 } },
    })) as { unknownSections: string[]; sections: Array<{ section: string }> };
    expect(raw.unknownSections).toEqual(["fromTheFuture"]);
    expect(raw.sections.map((s) => s.section)).toEqual(["worktreeConfig"]);
  });

  it("tells the person the host is too old when it has no settings copy", async () => {
    host.dispose();
    const bare = await openSessionPair(dir);
    const old = new ClientSettingsCopy({
      sessionFor: () => bare.client,
      isKnownHost: () => true,
      hostLabel: () => HOST,
      collect: async () => ({ worktreeConfig: { pathPattern: "x/{branch-slug}" } }),
    });
    try {
      await expect(
        old.preview({ hostId: HOST, categories: ["worktreePath"] })
      ).rejects.toMatchObject({
        code: "UNSUPPORTED",
        userMessage: expect.stringContaining("too old"),
      });
    } finally {
      bare.host.close("test");
      bare.client.close("test");
    }
  });

  it("refuses an empty choice and an unknown host before calling the host", async () => {
    await expect(client.preview({ hostId: HOST, categories: [] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      client.preview({ hostId: "studio-99", categories: ["worktreePath"] })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(hostSide.service.preview).not.toHaveBeenCalled();
  });

  it("says when the host isn't connected", async () => {
    const offline = new ClientSettingsCopy({
      sessionFor: () => null,
      isKnownHost: () => true,
      hostLabel: () => HOST,
      collect: async () => ({}),
    });
    await expect(
      offline.preview({ hostId: HOST, categories: ["worktreePath"] })
    ).rejects.toMatchObject({ code: "HOST_DISCONNECTED" });
  });
});

describe("an apply whose answer never arrives", () => {
  it("is an unknown outcome, not a failure, and still releases the host", async () => {
    const release = vi.fn();
    const timedOut = new ClientSettingsCopy({
      sessionFor: () => ({
        isOpen: true,
        call: async () => {
          throw Object.assign(new Error("Request timed out"), { code: "OUTCOME_UNKNOWN" });
        },
      }),
      holdHost: () => release,
      isKnownHost: () => true,
      hostLabel: () => HOST,
      collect: async () => ({}),
    });
    await expect(
      timedOut.apply({ hostId: HOST, ticket: "0123456789abcdef0123456789abcdef" })
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      userMessage: expect.stringContaining("Preview again"),
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("what a copy would change, and undoing the last one (#13347)", () => {
  it("compares everything copyable, by category, without minting a ticket", async () => {
    hostSide.service.preview.mockImplementationOnce(async (incoming: Sections) =>
      Object.keys(incoming).map((id) => ({
        section: id as ConfigBundleSectionId,
        add: 0,
        update: id === "worktreeConfig" ? 1 : 0,
        unchanged: 1,
        changes: [],
      }))
    );
    const status = await client.status({ hostId: HOST });
    expect(Object.keys(hostSide.service.preview.mock.calls[0][0]).sort()).toEqual(
      ["agentSettings", "globalEnvironment", "worktreeConfig"].sort()
    );
    expect(hostSide.service.revision).not.toHaveBeenCalled();
    expect(status).toEqual({ supported: true, changes: ["worktreePath"], lastCopy: null });
  });

  it("records who copied, when and what, and shows it without any value", async () => {
    now = 5_000;
    const preview = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: preview.ticket });

    const { lastCopy } = await client.status({ hostId: HOST });
    expect(lastCopy).toMatchObject({
      source: "Laptop",
      at: 5_000,
      sections: [{ section: "worktreeConfig", applied: 1, skipped: 0 }],
      undo: "available",
      changed: [{ section: "worktreeConfig", key: "worktreeConfig", label: "worktreeConfig" }],
    });
    // The record keeps the earlier value; nothing a Shell sees carries it.
    expect(JSON.stringify(records.box.record)).toContain("{parent-dir}");
    expect(JSON.stringify(lastCopy)).not.toContain("{parent-dir}");
  });

  it("undoes the last copy once, and refuses a copy that has since been replaced", async () => {
    const first = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: first.ticket });
    const firstId = (await client.status({ hostId: HOST })).lastCopy!.id;

    local.worktreeConfig = { pathPattern: "~/second/{branch-slug}" };
    const second = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: second.ticket });
    await expect(client.undo({ hostId: HOST, copyId: firstId })).rejects.toMatchObject({
      code: "SETTINGS_COPY_UNDO_STALE",
    });

    const latest = (await client.status({ hostId: HOST })).lastCopy!;
    reconcile.mockClear();
    const result = await client.undo({ hostId: HOST, copyId: latest.id });
    expect(result.undone.leaves).toEqual([
      {
        section: "worktreeConfig",
        key: "worktreeConfig",
        label: "worktreeConfig",
        status: "restored",
      },
    ]);
    expect(result.lastCopy.undo).toBe("done");
    expect(hostSide.settings.worktreeConfig).toEqual({ pathPattern: "~/wt/{branch-slug}" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    // The earlier values went with the undo.
    expect(records.box.record?.leaves).toBeUndefined();
    await expect(client.undo({ hostId: HOST, copyId: latest.id })).rejects.toMatchObject({
      code: "SETTINGS_COPY_UNDO_STALE",
    });
  });

  it("offers no older undo when the latest copy's record couldn't be saved", async () => {
    const first = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: first.ticket });
    const firstId = records.box.record!.copy.id;

    records.write.mockImplementation(async (record: LastCopyRecord) => {
      // Retiring the old undo lands; saving the new copy's record doesn't.
      if (record.copy.id !== firstId) throw new Error("disk full");
      records.box.record = structuredClone(record);
      return record;
    });
    local.worktreeConfig = { pathPattern: "~/second/{branch-slug}" };
    const second = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    const report = await client.apply({ hostId: HOST, ticket: second.ticket });

    expect(report.outcome).toBe("applied");
    expect((await client.status({ hostId: HOST })).lastCopy).toMatchObject({
      id: firstId,
      undo: "unavailable",
    });
    await expect(client.undo({ hostId: HOST, copyId: firstId })).rejects.toMatchObject({
      code: "SETTINGS_COPY_UNDO_STALE",
    });
  });

  it("copies nothing when it can't retire the previous undo", async () => {
    const first = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: first.ticket });
    records.write.mockRejectedValue(new Error("read-only disk"));
    hostSide.service.apply.mockClear();

    local.worktreeConfig = { pathPattern: "~/second/{branch-slug}" };
    const second = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await expect(client.apply({ hostId: HOST, ticket: second.ticket })).rejects.toBeTruthy();
    expect(hostSide.service.apply).not.toHaveBeenCalled();
  });

  it("spends the undo before writing, so one that can't be recorded can't run twice", async () => {
    const first = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: first.ticket });
    const copyId = records.box.record!.copy.id;
    records.write.mockImplementation(async (record: LastCopyRecord) => {
      if (record.copy.undone) throw new Error("disk full");
      records.box.record = structuredClone(record);
      return record;
    });

    await client.undo({ hostId: HOST, copyId });
    await expect(client.undo({ hostId: HOST, copyId })).rejects.toMatchObject({
      code: "SETTINGS_COPY_UNDO_STALE",
    });
    expect(hostSide.service.undo).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous record when a copy rolls back", async () => {
    const first = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: first.ticket });
    const before = records.box.record;
    hostSide.service.apply.mockResolvedValueOnce({
      outcome: "rolled-back",
      sections: [],
      errors: ["nope"],
      rolledBack: true,
    });
    const second = await client.preview({ hostId: HOST, categories: ["worktreePath"] });
    await client.apply({ hostId: HOST, ticket: second.ticket });
    expect(records.box.record).toEqual(before);
  });

  it("says nothing is known, rather than failing, on a host too old to answer", async () => {
    host.dispose();
    const bare = await openSessionPair(dir);
    const old = new ClientSettingsCopy({
      sessionFor: () => bare.client,
      isKnownHost: () => true,
      hostLabel: () => HOST,
      collect: async () => ({}),
    });
    try {
      await expect(old.status({ hostId: HOST })).resolves.toEqual({
        supported: false,
        changes: [],
        lastCopy: null,
      });
    } finally {
      bare.host.close("test");
      bare.client.close("test");
    }
  });
});
