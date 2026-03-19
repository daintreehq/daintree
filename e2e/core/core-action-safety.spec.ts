import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { T_MEDIUM } from "../helpers/timeouts";

let ctx: AppContext;

test.describe.serial("Core: Action dispatch safety", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();

    // Wait for action registry to be populated and dispatch hook to be available
    await expect
      .poll(
        async () => {
          return ctx.window.evaluate(() => {
            const dispatch = (window as any).__canopyDispatchAction;
            if (typeof dispatch !== "function") return "no-hook";
            return "ready";
          });
        },
        { timeout: T_MEDIUM, message: "Action dispatch hook not available" }
      )
      .toBe("ready");

    // Wait for actions to be registered by dispatching a safe introspection action
    await expect
      .poll(
        async () => {
          const result = await ctx.window.evaluate(() => {
            return (window as any).__canopyDispatchAction("actions.getContext");
          });
          return (result as any)?.ok;
        },
        { timeout: T_MEDIUM, message: "Action registry not populated" }
      )
      .toBe(true);

    // Ensure EventBuffer is recording by dispatching an action and verifying it appears
    await ctx.window.evaluate(() => (window as any).electron.eventInspector.clear());
    await ctx.window.evaluate(() => (window as any).__canopyDispatchAction("actions.getContext"));
    await expect
      .poll(
        async () => {
          const events = await ctx.window.evaluate(() =>
            (window as any).electron.eventInspector.getFiltered({
              types: ["action:dispatched"],
            })
          );
          return (events as any[])?.length > 0;
        },
        { timeout: T_MEDIUM, message: "EventBuffer not recording" }
      )
      .toBe(true);
    await ctx.window.evaluate(() => (window as any).electron.eventInspector.clear());
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("agent dispatch of confirm-level action without confirmation returns CONFIRMATION_REQUIRED", async () => {
    const result = await ctx.window.evaluate(() =>
      (window as any).__canopyDispatchAction("terminal.kill", {}, { source: "agent" })
    );

    expect((result as any).ok).toBe(false);
    expect((result as any).error.code).toBe("CONFIRMATION_REQUIRED");
    expect((result as any).error.message).toContain("requires explicit confirmation");
  });

  test("agent dispatch of confirm-level action with confirmed: true succeeds", async () => {
    const result = await ctx.window.evaluate(() =>
      (window as any).__canopyDispatchAction(
        "terminal.kill",
        {},
        { source: "agent", confirmed: true }
      )
    );

    expect((result as any).ok).toBe(true);
  });

  test("sensitive args are redacted in event payloads", async () => {
    await ctx.window.evaluate(() => (window as any).electron.eventInspector.clear());

    await ctx.window.evaluate(() =>
      (window as any).__canopyDispatchAction(
        "logs.getAll",
        { token: "secret-token-value", password: "hunter2", normalField: "visible" },
        { source: "user" }
      )
    );

    // Poll until the action:dispatched event for logs.getAll appears
    let matchingEvents: any[] = [];
    await expect
      .poll(
        async () => {
          const all = (await ctx.window.evaluate(() =>
            (window as any).electron.eventInspector.getFiltered({
              types: ["action:dispatched"],
            })
          )) as any[];
          matchingEvents = all?.filter((e: any) => e.payload?.actionId === "logs.getAll") ?? [];
          return matchingEvents.length;
        },
        { timeout: T_MEDIUM, message: "No action:dispatched event for logs.getAll" }
      )
      .toBeGreaterThan(0);

    const payload = matchingEvents[0].payload;
    expect(payload.args.token).toBe("[REDACTED]");
    expect(payload.args.password).toBe("[REDACTED]");
    expect(payload.args.normalField).toBe("visible");
  });

  test("disabled action returns DISABLED with reason", async () => {
    const result = await ctx.window.evaluate(() =>
      (window as any).__canopyDispatchAction("worktree.inject", {}, { source: "agent" })
    );

    expect((result as any).ok).toBe(false);
    expect((result as any).error.code).toBe("DISABLED");
    expect((result as any).error.message).toContain("No focused terminal");
  });
});
