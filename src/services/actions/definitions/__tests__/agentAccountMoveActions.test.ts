import { afterEach, describe, expect, it } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { AgentSettings } from "@shared/types";
import type { ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import { registerAgentAccountMoveActions } from "../agentAccountMoveActions";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useMoveTerminalsDialogStore } from "@/store/moveTerminalsDialogStore";

function definitions(): Map<string, AnyActionDefinition> {
  const registry: ActionRegistry = new Map();
  registerAgentAccountMoveActions(registry);
  return new Map([...registry].map(([id, factory]) => [id, factory()]));
}

function claudeMove(): AnyActionDefinition {
  const definition = definitions().get("agent.moveTerminalsToAccount.claude");
  if (!definition) throw new Error("no move action for claude");
  return definition;
}

function saveAccounts(accounts: { id: string; name: string }[]): void {
  useAgentSettingsStore.setState({
    settings: {
      agents: {
        claude: {
          accounts: accounts.map((account) => ({
            ...account,
            configDir: `/Users/me/.claude-${account.id}`,
          })),
        },
      },
    } satisfies AgentSettings,
  });
}

const ctx = {} as ActionContext;

afterEach(() => {
  useMoveTerminalsDialogStore.getState().close();
  useAgentSettingsStore.setState({ settings: null });
});

describe("agent.moveTerminalsToAccount.<agent> (#17089)", () => {
  it("exists for each agent that signs in through a config folder", () => {
    expect([...definitions().keys()].sort()).toEqual([
      "agent.moveTerminalsToAccount.claude",
      "agent.moveTerminalsToAccount.codex",
      "agent.moveTerminalsToAccount.interpreter",
      "agent.moveTerminalsToAccount.kimi",
    ]);
  });

  it("is listed only once the agent has a saved account", () => {
    const move = claudeMove();
    expect(move.isVisible?.(ctx)).toBe(false);
    saveAccounts([{ id: "company", name: "Company" }]);
    expect(move.isVisible?.(ctx)).toBe(true);
  });

  it("opens the dialog on the account named, or the default login for null", async () => {
    saveAccounts([{ id: "company", name: "Company" }]);
    const move = claudeMove();

    await move.run({ accountId: "company" }, ctx);
    expect(useMoveTerminalsDialogStore.getState().opening).toMatchObject({
      agentId: "claude",
      account: { id: "company", name: "Company" },
    });

    await move.run({ accountId: null }, ctx);
    expect(useMoveTerminalsDialogStore.getState().opening).toMatchObject({
      agentId: "claude",
      account: { id: null, name: "Default login" },
    });
  });

  it("names the default login as the user named it (#17080)", async () => {
    saveAccounts([{ id: "company", name: "Company" }]);
    const settings = useAgentSettingsStore.getState().settings!;
    useAgentSettingsStore.setState({
      settings: {
        ...settings,
        agents: { claude: { ...settings.agents.claude, defaultLoginName: "Home" } },
      },
    });

    await claudeMove().run({ accountId: null }, ctx);
    expect(useMoveTerminalsDialogStore.getState().opening).toMatchObject({
      account: { id: null, name: "Home · default login" },
    });
  });

  it("leaves the account to the dialog when the palette names none", async () => {
    await claudeMove().run({}, ctx);
    const opening = useMoveTerminalsDialogStore.getState().opening;
    expect(opening?.agentId).toBe("claude");
    expect(opening && "account" in opening).toBe(false);
  });

  it("opens nothing for an account that isn't saved", async () => {
    saveAccounts([{ id: "company", name: "Company" }]);
    await expect(claudeMove().run({ accountId: "gone" }, ctx)).rejects.toThrow(/gone/);
    expect(useMoveTerminalsDialogStore.getState().opening).toBeNull();
  });

  it("is a palette command that runs with no arguments, and refuses unknown ones", async () => {
    saveAccounts([{ id: "company", name: "Company" }]);
    const { ActionService } = await import("@/services/ActionService");
    const service = new ActionService();
    for (const definition of definitions().values()) service.register(definition);

    const entry = service.list({}).find((e) => e.id === "agent.moveTerminalsToAccount.claude");
    expect(entry).toMatchObject({ enabled: true, requiresArgs: false });
    expect(entry?.paletteHidden).toBeUndefined();
    expect(entry?.paletteRedirectTo).toBeUndefined();

    for (const args of [undefined, {}]) {
      useMoveTerminalsDialogStore.getState().close();
      const result = await service.dispatch("agent.moveTerminalsToAccount.claude", args, {
        source: "user",
      });
      expect(result.ok).toBe(true);
      expect(useMoveTerminalsDialogStore.getState().opening?.agentId).toBe("claude");
    }

    useMoveTerminalsDialogStore.getState().close();
    const refused = await service.dispatch(
      "agent.moveTerminalsToAccount.claude",
      { accountId: "company", worktreeId: "wt-1" },
      { source: "user" }
    );
    expect(refused).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    expect(useMoveTerminalsDialogStore.getState().opening).toBeNull();
  });

  it("gives every opening its own id, so a second starts afresh", async () => {
    const move = claudeMove();
    await move.run({}, ctx);
    const first = useMoveTerminalsDialogStore.getState().opening?.id;
    await move.run({}, ctx);
    expect(useMoveTerminalsDialogStore.getState().opening?.id).not.toBe(first);
  });
});
