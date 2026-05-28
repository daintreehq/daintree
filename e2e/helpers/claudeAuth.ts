import type { Page } from "@playwright/test";

export function hasClaudeApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function configureClaudeAuthEnv(page: Page): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Claude online E2E");
  }

  await page.evaluate(async (anthropicApiKey) => {
    const currentGlobalEnv = await window.electron.globalEnv.get();
    await window.electron.globalEnv.set({
      ...currentGlobalEnv,
      ANTHROPIC_API_KEY: anthropicApiKey,
      ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
      // CLAUDE_CODE_SIMPLE=1 is the env-var equivalent of `claude --bare`:
      // it skips marketplace OAuth, plugin sync, auto-memory, CLAUDE.md
      // discovery, and keychain reads. Anthropic auth becomes strictly
      // ANTHROPIC_API_KEY, so the "Not logged in - Run /login" marketplace
      // nag never appears in marketing screenshots. (Strings dump of the
      // claude-code binary confirms this is the right toggle.)
      CLAUDE_CODE_SIMPLE: "1",
    });

    const current = await window.electron.agentSettings.get();
    const currentEnv = (current.agents?.claude?.globalEnv ?? {}) as Record<string, string>;

    await window.electron.agentSettings.set("claude", {
      globalEnv: {
        ...currentEnv,
        ANTHROPIC_API_KEY: anthropicApiKey,
        ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
        CLAUDE_CODE_SIMPLE: "1",
      },
    });
  }, apiKey);
}
