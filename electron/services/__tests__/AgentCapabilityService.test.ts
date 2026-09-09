import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as registry from "../../../shared/config/agentRegistry.js";
import { AgentCapabilityService } from "../AgentCapabilityService.js";
import { CompletionDiscoveryEngine } from "../completions/CompletionDiscoveryEngine.js";
import { COMPLETION_PARSERS } from "../completions/completionParsers.js";
import {
  CapabilityGetResultSchema,
  CapabilitySearchResultSchema,
} from "../../../shared/types/agentCapabilities.js";

let root: string;
let service: AgentCapabilityService;
async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-capability-test-"));
  await fs.mkdir(path.join(root, ".git"));
  const configs = {
    codex: registry.getAgentConfig("codex")!,
    claude: registry.getAgentConfig("claude")!,
  };
  vi.spyOn(registry, "getEffectiveAgentConfig").mockImplementation((id) => {
    if (id !== "codex" && id !== "claude") return undefined;
    return {
      ...configs[id],
      completionSources: [
        {
          id: "skills",
          trigger: id === "codex" ? "$" : "/",
          sourcePrecedence: 0,
          discovery: {
            method: "directory",
            parser: "skill-dir",
            derive: {
              labelPrefix: id === "codex" ? "$" : "/",
              kind: "skill",
              fallbackDescription: "Skill",
            },
            locations: [
              {
                id: "project",
                scope: "project",
                base: { type: "projectRoot" },
                segments: ["skills"],
                locationPrecedence: 0,
              },
            ],
          },
        },
      ],
    };
  });
  service = new AgentCapabilityService();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("agent capability discovery", () => {
  it("preserves Codex dollar skill syntax and loads argument hints only on demand", async () => {
    await write(
      path.join(root, "skills", "different-folder", "SKILL.md"),
      '---\nname: work-issue\ndescription: |\n  Work on a GitHub issue\nargument-hint: "<issue-number>"\n---\nPRIVATE_USAGE_NONCE\n'
    );
    const found = CapabilitySearchResultSchema.parse(
      await service.search({ agentId: "codex", worktreePath: root, query: "GitHub issue" })
    );
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({
      insertText: "$work-issue",
      trigger: "$",
      kind: "skill",
    });
    expect(JSON.stringify(found)).not.toContain("PRIVATE_USAGE_NONCE");
    const detail = CapabilityGetResultSchema.parse(
      await service.get({
        agentId: "codex",
        worktreePath: root,
        id: found.items[0]!.id,
        catalogRevision: found.catalogRevision,
      })
    );
    expect(detail.invocation).toMatchObject({
      token: "$work-issue",
      channel: "prompt-reference",
      argumentHint: "<issue-number>",
      startupSupport: "unverified",
    });
    expect(detail.instructions).toContain("PRIVATE_USAGE_NONCE");
    const claude = await service.search({
      agentId: "claude",
      worktreePath: root,
      query: "work-issue",
    });
    expect(claude.items[0]!.insertText).toBe("/work-issue");
    expect(claude.items[0]!.id).not.toBe(found.items[0]!.id);
  });

  it("pages a large catalog without bodies and rejects a cursor from another query", async () => {
    for (let i = 0; i < 65; i++)
      await write(
        path.join(root, "skills", `task-${i}`, "SKILL.md"),
        "---\ndescription: Process tickets\n---\nBODY_ONLY"
      );
    const request = { agentId: "codex", worktreePath: root, query: "tickets", limit: 7 };
    let page = await service.search(request);
    const ids = page.items.map((item) => item.id);
    expect(page.total).toBe(65);
    expect(JSON.stringify(page)).not.toContain("BODY_ONLY");
    await expect(
      service.search({ ...request, query: "other", cursor: page.nextCursor })
    ).rejects.toThrow("query changed");
    while (page.nextCursor) {
      page = await service.search({ ...request, cursor: page.nextCursor });
      ids.push(...page.items.map((item) => item.id));
    }
    expect(new Set(ids).size).toBe(65);
  });

  it("does not read a selected skill from another worktree or after its definition changes", async () => {
    const file = path.join(root, "skills", "work", "SKILL.md");
    await write(file, "---\ndescription: First definition\n---\nFirst body");
    const found = await service.search({ agentId: "codex", worktreePath: root, query: "work" });
    const request = {
      agentId: "codex",
      worktreePath: root,
      id: found.items[0]!.id,
      catalogRevision: found.catalogRevision,
    };
    const other = path.join(root, "other");
    await fs.mkdir(path.join(other, ".git"), { recursive: true });
    await expect(
      service.get({ ...request, worktreePath: other, catalogRevision: undefined })
    ).rejects.toThrow("unavailable");
    await write(file, "---\ndescription: Changed definition\n---\nDifferent body now");
    await expect(service.get(request)).rejects.toThrow("Catalog changed");
    await expect(
      service.get({ ...request, id: "/etc/passwd", catalogRevision: undefined })
    ).rejects.toThrow("unavailable");
  });

  it("revalidates paged source content and reports an incomplete bounded read", async () => {
    const file = path.join(root, "skills", "long", "SKILL.md");
    await write(file, "---\ndescription: Long instructions\n---\n" + "a".repeat(270000));
    const found = await service.search({ agentId: "codex", worktreePath: root, query: "long" });
    const request = { agentId: "codex", worktreePath: root, id: found.items[0]!.id };
    const first = await service.get(request);
    expect(first.truncated).toBe(true);
    expect(first.instructions.length).toBeLessThan(10000);
    expect(first.warnings.join(" ")).toContain("incomplete");
    await expect(service.get({ ...request, offset: first.nextOffset })).rejects.toThrow(
      "sourceRevision"
    );
    await write(file, "changed");
    await expect(
      service.get({ ...request, offset: first.nextOffset, sourceRevision: first.sourceRevision })
    ).rejects.toThrow("Source changed");
  });

  it("refreshes cached discovery and distinguishes unsupported agents from no matches", async () => {
    const request = { agentId: "codex", worktreePath: root, query: "added" };
    expect((await service.search(request)).items).toEqual([]);
    await write(
      path.join(root, "skills", "added", "SKILL.md"),
      "---\ndescription: Added skill\n---\nUse me"
    );
    expect((await service.search({ ...request, refresh: true })).items).toHaveLength(1);
    expect(await service.search({ ...request, agentId: "custom-agent" })).toMatchObject({
      coverage: "unsupported",
      items: [],
    });
    await expect(service.search({ ...request, worktreePath: "relative" })).rejects.toThrow(
      "absolute"
    );
  });

  it("uses the canonical insertion token when the display label differs", async () => {
    const engine = new CompletionDiscoveryEngine();
    vi.spyOn(engine, "discover").mockResolvedValue({
      commands: [
        {
          id: "skill",
          agentId: "codex",
          label: "Work issue",
          insertText: "$work-issue",
          aliases: ["ticket"],
          description: "Process",
          scope: "user",
          kind: "skill",
          trigger: "$",
        },
      ],
      warnings: [],
    });
    const catalog = new AgentCapabilityService(engine);
    const found = await catalog.search({ agentId: "codex", worktreePath: root, query: "ticket" });
    const detail = await catalog.get({
      agentId: "codex",
      worktreePath: root,
      id: found.items[0]!.id,
    });
    expect(detail.invocation.token).toBe("$work-issue");
  });

  it("discovers symlinked skills and hides non-invocable definitions", async () => {
    await write(path.join(root, "real", "SKILL.md"), "---\ndescription: Shared skill\n---\nBody");
    await fs.mkdir(path.join(root, "skills"));
    await fs.symlink(path.join(root, "real"), path.join(root, "skills", "linked"), "junction");
    await write(
      path.join(root, "skills", "hidden", "SKILL.md"),
      "---\ndescription: Hidden\nuser-invocable: false\n---\nBody"
    );
    const found = await service.search({ agentId: "codex", worktreePath: root, query: "" });
    expect(found.items.map((item) => item.insertText)).toEqual(["$linked"]);
  });

  it("surfaces parser failures as partial discovery", async () => {
    await write(
      path.join(root, "skills", "broken", "SKILL.md"),
      "---\ndescription: [invalid YAML\n---\nBody"
    );
    const found = await service.search({ agentId: "codex", worktreePath: root, query: "" });
    expect(found.items).toEqual([]);
    expect(found.coverage).toBe("partial");
    expect(found.warnings.join(" ")).toContain("Could not fully read");
  });

  it("discovers namespaced skills only from enabled plugins and the current version", async () => {
    await write(
      path.join(root, "config.toml"),
      '[plugins."github@test-market"]\nenabled = true\n[plugins."disabled@test-market"]\nenabled = false\n'
    );
    for (const name of ["github", "disabled"])
      for (const version of ["0.1.9", "0.1.10"]) {
        const dir = path.join(root, "plugins", "cache", "test-market", name, version);
        await write(
          path.join(dir, ".codex-plugin", "plugin.json"),
          JSON.stringify({ name, skills: "./skills" })
        );
        await write(
          path.join(dir, "skills", "fix-ci", "SKILL.md"),
          `---\ndescription: ${version}\n---\nBody`
        );
      }
    const skills = await COMPLETION_PARSERS["codex-plugin-skills"](root);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ nameParts: ["github", "fix-ci"], description: "0.1.10" });
  });
});
