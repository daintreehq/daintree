/**
 * Worker half of the Surface Tour — the file Daintree's utility process imports.
 *
 * Hand-written ESM, committed as-is: a project plugin's `dist/` IS the load
 * contract, and the host never compiles anything. `.mjs` rather than `.js`
 * because Node resolves module type from the nearest `package.json`, which for
 * an installed copy is the HOST PROJECT's — a bare `.js` entry is ambiguous in
 * exactly the repositories this is meant to be dropped into.
 */

/**
 * `host.dispatch` does NOT throw when an action fails — it resolves
 * `{ ok: false, error }`. Returning it raw is how a plugin ends up with a
 * button that silently does nothing: the promise resolves, the view sees a
 * truthy object, and the failure is never surfaced.
 */
async function dispatchOrThrow(host, actionId, args) {
  const result = await host.dispatch(actionId, args);
  if (!result?.ok) {
    throw new Error(`${actionId} failed: ${result?.error?.message ?? "unknown error"}`);
  }
  return result.result;
}

/**
 * Runtime ids a project plugin has to build for itself, and the single thing
 * agents most reliably get wrong on a first attempt.
 *
 * The plugin's own runtime id is an INSTANCE KEY, `project__{projectId}__{manifestId}`
 * — not the manifest id — because two projects can each ship `acme.tour` and
 * they must not collide. Its panel kinds are qualified differently again, as
 * `project:{projectId}/{manifestId}/{kindId}`, and that qualified form is what
 * `panel.openPluginPanel` requires. Passing the bare `tour` or `acme.tour.tour`
 * gets a kind that resolves to nothing.
 */
const MANIFEST_ID = "acme.tour";

function panelKindId(projectId) {
  return `project:${projectId}/${MANIFEST_ID}/tour`;
}

export async function activate(host) {
  // Per-activation, NOT module scope. A worker is reloaded by unloading and
  // re-importing this module, and module-level state would then be shared with
  // — or left over from — a previous activation. Anything that should outlive
  // an activation belongs in `host.storage`, not in a module binding.
  const mountedPanels = new Set();

  // `(ctx, ...args)` — the context is ALWAYS first and the view's payload is
  // second. Declaring `(args) => …` binds the context to `args` and drops the
  // payload with no error anywhere: argument-less channels keep working, so the
  // panel looks healthy while every channel that takes one silently fails.
  // This is the single most expensive mistake on this surface (#12215).
  await host.registerHandler("describe-file", async (ctx, args) => {
    const { path: filePath } = args ?? {};
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("describe-file requires a path");
    }

    // `host.fs.readFile` resolves to a UTF-8 STRING. There is no binary mode:
    // anything that isn't text — an image, an mp3 — is fetched by the view over
    // `daintree-file://` instead. See dist/panel.js.
    //
    // The manifest declares BOTH `${project}` and `${worktree}` for this to
    // work. `${project}` expands to the MAIN worktree only, so declaring it
    // alone fails PATH_NOT_ALLOWED for every path the moment the user is on a
    // linked worktree — and passes in a single-worktree checkout, which is
    // where it gets tested.
    const text = await host.fs.readFile(filePath);
    return {
      path: filePath,
      lines: text.split("\n").length,
      characters: text.length,
      // Handed back so the view can qualify its own panel kind without a second
      // round trip; `ctx.projectId` is null only for a plugin with no project.
      projectId: ctx.projectId,
    };
  });

  // Opens a SECOND instance of this plugin's own panel. `reuseExisting: false`
  // is what makes it a second one rather than a focus of the first.
  await host.registerHandler("open-another", async (ctx) => {
    if (!ctx.projectId) throw new Error("open-another needs a project");
    return await dispatchOrThrow(host, "panel.openPluginPanel", {
      kind: panelKindId(ctx.projectId),
      initialArgs: { openedBy: "tour" },
      reuseExisting: false,
    });
  });

  // Hands a path off to Daintree's own file viewer. A built-in action, so it
  // needs no capability of its own — `host.actions` lists what `dispatch`
  // accepts and the arg shape each id wants.
  await host.registerHandler("reveal", async (_ctx, args) => {
    const { path: filePath, rootPath } = args ?? {};
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("reveal requires a path");
    }
    return await dispatchOrThrow(host, "file.openPanel", { path: filePath, rootPath });
  });

  // A push is NOT buffered: one sent during activate() is gone before any view
  // mounts. Tracking the lifecycle is what makes a push land — the view pulls
  // its initial state on mount (the channels above), and only then does this
  // have somewhere to send updates to. Awaited like every `register*` call, or
  // activation can resolve before the subscription lands and the first mount
  // goes unobserved.
  //
  // `mounted` is the ONLY phase with a live view on the other end. `hidden` and
  // `backgrounded` tear the React subtree down while the panel record lives on
  // — a sibling pane was maximized, a dock tab left, a project view cached — so
  // a plugin that only removes on `removed` keeps pushing at panels that
  // stopped listening, and shows a count that is never right again.
  const unsubscribe = await host.onDidChangePanelLifecycle((event) => {
    if (event.phase === "mounted") {
      mountedPanels.add(event.panelId);
    } else {
      mountedPanels.delete(event.panelId);
    }

    // Fanned out to EVERY mounted panel, not just the one that changed — a
    // second panel opening changes the first one's count too, and a push that
    // only reaches the newcomer leaves every other panel stale.
    for (const panelId of mountedPanels) {
      // Targeted at one panelId, so each instance gets its own message.
      // `postToPanel` with no panelId broadcasts instead — and a broadcast
      // reaches `plugin.on` subscribers, never `plugin.onPanel`.
      void host.postToPanel("tour-state", { panels: mountedPanels.size }, panelId);
      void host.setPanelBadge(panelId, {
        kind: "label",
        text: String(mountedPanels.size),
        color: "default",
        tooltip: "Panels open in this tour",
      });
    }
  });

  // Declared in `contributes.commands` AND registered here: the manifest entry
  // is what puts it in the palette and triggers activation, this call is what
  // gives it a handler. An action handler takes `(args)` only — no context.
  await host.registerAction(
    {
      // The id must match the `contributes.commands` entry, because that entry
      // is what makes the command reachable. The host does not diff the rest —
      // this descriptor REPLACES the manifest one at registration — but it does
      // enforce that `requires` is a subset of the manifest's `capabilities`,
      // so an action can never claim authority the user was not asked for.
      // Keeping the two in step is convention, not a load rule.
      id: "open-tour",
      title: "Open Surface Tour",
      description: "Open the Surface Tour panel for this project.",
      category: "Surface Tour",
      kind: "command",
      danger: "safe",
      requires: [],
    },
    async () => {
      const worktree = await host.getActiveWorktree();
      await host.showToast({ message: "Surface Tour is open", type: "info" });
      return { worktree: worktree?.path ?? null };
    }
  );

  return () => {
    unsubscribe();
    mountedPanels.clear();
  };
}
