import { ShieldAlert } from "lucide-react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import type { ProjectPluginTrustDecision } from "@shared/types/plugin";

/**
 * The one consent gate for a project's own `.daintree/plugins/` folder.
 *
 * It opens on `plugin:project-trust-prompt` and on nothing else. Main emits
 * that push only when the folder holds at least one valid manifest and no
 * decision is on record, so this dialog cannot appear for a project the user
 * has already answered for — not on a branch switch, not on a pull, not when an
 * agent rewrites a plugin's source. Contents changing is not consent changing.
 *
 * Three answers, and the safe one is the visually primary button: the fill here
 * marks the default answer rather than a recommended one, because the thing
 * being offered is running unreviewed code from a folder agents can write to.
 * Escape and the close button record nothing at all — no decision means nothing
 * runs, and main is free to ask again next time.
 *
 * **Deliberately no per-capability choices.** There is no sandbox behind them:
 * offering to deny filesystem access would claim an enforcement Daintree does
 * not have. Capabilities are disclosed in the plugin manager instead, which is
 * the commitment `docs/plugins/trust-model.md` already makes.
 */
export function ProjectPluginTrustDialog() {
  const prompt = useProjectPluginStore((s) => s.prompt);
  const deciding = useProjectPluginStore((s) => s.deciding);
  const decide = useProjectPluginStore((s) => s.decide);
  const dismissPrompt = useProjectPluginStore((s) => s.dismissPrompt);

  const resetKey = prompt?.projectId ?? "null";
  const plugins = prompt?.plugins ?? [];
  const busy = deciding !== null;

  const answer = (decision: ProjectPluginTrustDecision) => {
    void decide(decision);
  };

  return (
    <ErrorBoundary
      variant="component"
      componentName="ProjectPluginTrustDialog"
      resetKeys={[resetKey]}
    >
      <AppDialog
        isOpen={prompt !== null}
        onClose={dismissPrompt}
        size="lg"
        // A list of the actual plugins, not a count — so this is a `dialog`.
        // APG reserves `alertdialog` for a brief message read out whole.
        hasPreview={true}
        // A decision already on the wire owns the gate until it settles: a
        // dismissal there would clear the dialog for a call that can still fail,
        // leaving nothing running and nothing recorded but the user believing
        // they had answered. The store refuses it too — this only stops the
        // backdrop and Escape from trying.
        dismissible={!busy}
        initialFocus="confirm"
        data-testid="project-plugin-trust-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<ShieldAlert className="w-4 h-4 text-text-secondary" />}>
            Run this project&apos;s plugins?
          </AppDialog.Title>
          <AppDialog.CloseButton aria-label="Decide later" />
        </AppDialog.Header>

        <AppDialog.Body resetScrollKey={resetKey}>
          <div className="space-y-4">
            <AppDialog.Description>
              This project ships {plugins.length === 1 ? "a Daintree plugin" : "Daintree plugins"}{" "}
              in its own <code className="font-mono text-2xs">.daintree/plugins</code> folder.
            </AppDialog.Description>

            <ul className="space-y-1.5">
              {plugins.map((plugin) => (
                <li
                  key={plugin.id}
                  className="flex items-baseline gap-2 rounded-[var(--radius-md)] bg-overlay-subtle px-2.5 py-1.5"
                >
                  <span className="text-sm text-text-primary truncate">{plugin.displayName}</span>
                  <span className="font-mono text-2xs text-text-secondary truncate">
                    {plugin.id}
                  </span>
                </li>
              ))}
            </ul>

            {/* The substance of the gate. It says plainly that the code is
                unsandboxed and names agents, because an agent with write access
                to this folder is the threat the gate exists for — a human
                reviewing a diff is not. */}
            <p className="text-sm text-text-secondary leading-relaxed">
              Plugin code runs with your account. It can read and change files, use the network, and
              start processes, and Daintree doesn&apos;t sandbox it. Enable it only if you trust
              everyone who can write to this folder, including the agents you run here.
            </p>

            {/* Reassurance belongs in the body, not the footer hint: three
                buttons already fill the action row, and a hint beside them
                would crop to nothing. Saying the choice is reversible is what
                stops a security prompt being answered under pressure. */}
            <p className="text-2xs text-text-secondary">
              Applies to this project only. You can change it later in the plugin manager.
            </p>
          </div>
        </AppDialog.Body>

        <AppDialog.Footer>
          {/* `loading`, never the native `disabled` attribute: a decision is a
              one-shot and the store already refuses a second one while the
              first is in flight, but disabling the button the user just
              pressed would drop focus to `document.body` mid-dialog. */}
          <div className="flex shrink-0 items-center gap-3">
            <Button
              variant="ghost"
              onClick={() => answer("session")}
              loading={busy && deciding === "session"}
            >
              Enable for this session
            </Button>
            <Button
              variant="outline"
              onClick={() => answer("enabled")}
              loading={busy && deciding === "enabled"}
            >
              Always enable
            </Button>
            <Button
              variant="contrast"
              data-confirm-role="confirm"
              onClick={() => answer("disabled")}
              loading={busy && deciding === "disabled"}
            >
              Keep disabled
            </Button>
          </div>
        </AppDialog.Footer>
      </AppDialog>
    </ErrorBoundary>
  );
}
