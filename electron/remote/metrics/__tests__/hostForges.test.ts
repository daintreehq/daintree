import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  credentials: {} as Record<string, string>,
  providers: [] as Array<{
    pluginId: string;
    contribution: { id: string; name: string; kind?: string };
  }>,
  getCurrentUser: vi.fn(async (): Promise<{ login: string } | null> => ({ login: "greg" })),
  bound: true,
}));

vi.mock("../../../store.js", () => ({
  store: { get: (key: string) => (key === "forgeCredentials" ? state.credentials : undefined) },
}));
vi.mock("../../../services/forgeProviderRegistry.js", () => ({
  getRegisteredForgeProviders: () => state.providers,
  getForgeProviderImpl: () =>
    state.bound ? { identity: { getCurrentUser: state.getCurrentUser } } : undefined,
}));

import { createForgeObserver } from "../hostForges.js";

const GITHUB = { pluginId: "daintree.github", contribution: { id: "github", name: "GitHub" } };
const GITLAB = { pluginId: "daintree.gitlab", contribution: { id: "gitlab", name: "GitLab" } };

beforeEach(() => {
  state.credentials = {};
  state.providers = [GITHUB, GITLAB];
  state.getCurrentUser.mockReset();
  state.getCurrentUser.mockResolvedValue({ login: "greg" });
  state.bound = true;
});

describe("the host's forge observations", () => {
  it("reports each provider, with the account only where a credential is saved", async () => {
    state.credentials = { "daintree.github.github": JSON.stringify({ token: "ghp_secret" }) };
    const observe = createForgeObserver(() => 0);
    const observed = await observe();
    expect(observed).toEqual([
      {
        providerId: "daintree.github.github",
        name: "GitHub",
        hasCredential: true,
        account: "greg",
      },
      { providerId: "daintree.gitlab.gitlab", name: "GitLab", hasCredential: false, account: null },
    ]);
    expect(JSON.stringify(observed)).not.toContain("ghp_secret");
    expect(state.getCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("asks for the account again only after a while, or when the credential changes", async () => {
    let now = 0;
    state.credentials = { "daintree.github.github": JSON.stringify({ token: "a" }) };
    const observe = createForgeObserver(() => now);
    await observe();
    now = 60_000;
    await observe();
    expect(state.getCurrentUser).toHaveBeenCalledTimes(1);
    state.credentials = { "daintree.github.github": JSON.stringify({ token: "b" }) };
    await observe();
    expect(state.getCurrentUser).toHaveBeenCalledTimes(2);
    now = 60_000 + 10 * 60_000;
    await observe();
    expect(state.getCurrentUser).toHaveBeenCalledTimes(3);
  });

  it("says a credential is saved without inventing an account the provider didn't report", async () => {
    state.credentials = { "daintree.github.github": JSON.stringify({ token: "a" }) };
    state.getCurrentUser.mockRejectedValue(new Error("offline"));
    await expect(createForgeObserver(() => 0)()).resolves.toContainEqual({
      providerId: "daintree.github.github",
      name: "GitHub",
      hasCredential: true,
      account: null,
    });
    state.bound = false;
    await expect(createForgeObserver(() => 0)()).resolves.toContainEqual(
      expect.objectContaining({ hasCredential: true, account: null })
    );
  });

  it("leaves out providers that need no sign-in, and treats an empty record as none", async () => {
    state.providers = [
      GITHUB,
      { pluginId: "acme.local", contribution: { id: "files", name: "Files", kind: "local" } },
    ];
    state.credentials = { "daintree.github.github": JSON.stringify({ token: "  " }) };
    await expect(createForgeObserver(() => 0)()).resolves.toEqual([
      { providerId: "daintree.github.github", name: "GitHub", hasCredential: false, account: null },
    ]);
    expect(state.getCurrentUser).not.toHaveBeenCalled();
  });
});
