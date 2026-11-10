import { getAgentDisplayTitle } from "@shared/config/agentRegistry";
import { getAgentInlineSupport } from "@/lib/agentInlineMode";
import { InlineStatusBanner } from "./InlineStatusBanner";

const WHAT_IT_MEANS = "Daintree's scrollback and search don't apply to this terminal";

export interface AgentAltScreenBannerProps {
  agentId: string;
  onDismiss: () => void;
}

/**
 * The T2 notice for an agent pane that is on the alternate screen (#16357):
 * what was seen and what it means for this pane, nothing about why.
 *
 * An agent with a main-screen mode also hears that it has one. A full-screen
 * only agent gets no second sentence, because there is nothing the user could
 * do with one. Info severity on the `inline` layout: an advisory the user can
 * read once and close, with no action to take.
 */
export function AgentAltScreenBanner({ agentId, onDismiss }: AgentAltScreenBannerProps) {
  const name = getAgentDisplayTitle(agentId);
  const { supported, command } = getAgentInlineSupport(agentId);

  return (
    <InlineStatusBanner
      severity="info"
      layout="inline"
      title={`${name} is running full-screen`}
      description={
        supported ? (
          <>
            {`${WHAT_IT_MEANS}. ${name} supports inline mode`}
            {command && (
              <>
                {" with "}
                <code className="font-mono">{command}</code>
              </>
            )}
            {"."}
          </>
        ) : (
          WHAT_IT_MEANS
        )
      }
      role="status"
      ariaLive="polite"
      onClose={onDismiss}
      closeAriaLabel="Dismiss full-screen notice"
    />
  );
}
