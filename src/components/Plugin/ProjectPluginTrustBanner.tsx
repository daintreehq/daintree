import { ShieldAlert } from "lucide-react";
import { InlineStatusBanner, type BannerAction } from "@/components/Terminal/InlineStatusBanner";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import type { ProjectPluginTrustDecision } from "@shared/types/plugin";

/**
 * The one consent gate for a project's own `.daintree/plugins/` folder.
 *
 * It appears on `plugin:project-trust-prompt` and on nothing else. Main emits
 * that push only when the folder holds at least one valid manifest and no
 * decision is on record, so this cannot appear for a project the user has
 * already answered for — not on a branch switch, not on a pull, not when an
 * agent rewrites a plugin's source. Contents changing is not consent changing.
 *
 * **A banner, not a modal.** This used to be a dialog, which meant a security
 * question stole focus from the terminal an agent was mid-keystroke in, and
 * re-stole it on every switch back into a project that was still undecided
 * (#12212). VS Code answers the same question with a Restricted Mode banner
 * plus a persistent status badge, and that split is what makes dismissal safe
 * here too: closing this records nothing, and `ProjectPluginIndicator` keeps
 * carrying the offer in the sidebar for as long as the plugins stay off.
 *
 * The three answers are unchanged. **Deliberately no per-capability choices:**
 * there is no sandbox behind them, so offering to deny filesystem access would
 * claim an enforcement Daintree does not have. Capabilities are disclosed in
 * the plugin manager instead, which is the commitment `docs/plugins/trust-model.md`
 * already makes.
 */
export function ProjectPluginTrustBanner() {
  const prompt = useProjectPluginStore((s) => s.prompt);
  const deciding = useProjectPluginStore((s) => s.deciding);
  const decide = useProjectPluginStore((s) => s.decide);
  const dismissPrompt = useProjectPluginStore((s) => s.dismissPrompt);

  if (prompt === null) return null;

  const plugins = prompt.plugins;
  const names = plugins.map((p) => p.displayName).join(", ");
  const answer = (decision: ProjectPluginTrustDecision) => () => {
    void decide(decision);
  };

  // A decision already on the wire owns the gate until it settles. `loading`
  // rather than `disabled` for the pressed button, so focus is not dropped to
  // `document.body` mid-answer.
  //
  // The fill sits on `Keep disabled`, exactly as it did on the dialog: it marks
  // the DEFAULT answer, not a recommended one, because the thing being offered
  // is running unreviewed code from a folder agents can write to. `primary`
  // here is the neutral filled treatment, not an accent — the warning tint is
  // already the one load-bearing signal on this surface.
  const busy = deciding !== null;
  const actions: BannerAction[] = [
    {
      id: "session",
      label: "Enable for this session",
      variant: "dismiss",
      onClick: answer("session"),
      loading: busy && deciding === "session",
    },
    {
      id: "enabled",
      label: "Always enable",
      variant: "dismiss",
      onClick: answer("enabled"),
      loading: busy && deciding === "enabled",
    },
    {
      id: "disabled",
      label: "Keep disabled",
      variant: "primary",
      onClick: answer("disabled"),
      loading: busy && deciding === "disabled",
    },
  ];

  return (
    <InlineStatusBanner
      icon={ShieldAlert}
      title={
        plugins.length === 1
          ? "This project ships a Daintree plugin"
          : `This project ships ${plugins.length} Daintree plugins`
      }
      // Names the plugins and says plainly that the code is unsandboxed, because
      // an agent with write access to `.daintree/plugins/` is the threat the
      // gate exists for — a human reviewing a diff is not.
      description={`${names} — plugin code runs with your account and isn't sandboxed. Enable it only if you trust everyone who can write to this project, including the agents you run here.`}
      severity="warning"
      role="status"
      onClose={busy ? undefined : dismissPrompt}
      closeAriaLabel="Decide later"
      actions={actions}
    />
  );
}
