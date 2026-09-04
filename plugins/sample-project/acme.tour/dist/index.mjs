/**
 * Worker half of the Surface Tour — the file Daintree's utility process imports.
 *
 * Hand-written ESM, committed as-is: a project plugin's `dist/` IS the load
 * contract, and the host never compiles anything. `.mjs` rather than `.js`
 * because Node resolves module type from the nearest `package.json`, which for
 * an installed copy is the HOST PROJECT's — a bare `.js` entry is ambiguous in
 * exactly the repositories this is meant to be dropped into.
 */

/** Panels currently mounted, so pushes only go where something is listening. */
const mountedPanels = new Set();

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
    return await host.dispatch("panel.openPluginPanel", {
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
    return await host.dispatch("file.openPanel", { path: filePath, rootPath });
  });

  // A push is NOT buffered: one sent during activate() is gone before any view
  // mounts. Tracking the lifecycle is what makes a push land — the view pulls
  // its initial state on mount (the channels above), and only then does this
  // have somewhere to send updates to.
  // Awaited, like every `register*` call: activation can otherwise resolve
  // before the subscription lands, and the first mount goes unobserved.
  const unsubscribe = await host.onDidChangePanelLifecycle((event) => {
    if (event.phase === "mounted") {
      mountedPanels.add(event.panelId);
      // Targeted at one panelId, so a second instance doesn't get the first
      // one's badge count. `postToPanel` with no panelId broadcasts instead —
      // and a broadcast reaches `plugin.on` subscribers, never `plugin.onPanel`.
      void host.postToPanel("tour-state", { panels: mountedPanels.size }, event.panelId);
      void host.setPanelBadge(event.panelId, {
        kind: "label",
        text: String(mountedPanels.size),
        color: "default",
        tooltip: "Panels open in this tour",
      });
    } else if (event.phase === "removed") {
      mountedPanels.delete(event.panelId);
    }
  });

  // Declared in `contributes.commands` AND registered here: the manifest entry
  // is what puts it in the palette and triggers activation, this call is what
  // gives it a handler. An action handler takes `(args)` only — no context.
  await host.registerAction(
    {
      // Must match the `contributes.commands` entry field for field — the host
      // rejects a registration that claims authority the manifest never asked
      // the user for.
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
