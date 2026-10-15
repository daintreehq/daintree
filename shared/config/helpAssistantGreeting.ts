/**
 * The opening turn `help.launchAgent` sends on the user's behalf. A transcript
 * holding nothing but this is a launch, not a conversation, so the past-session
 * picker leaves it out (#13206).
 */
export const HELP_ASSISTANT_GREETING =
  "I need help with Daintree, an IDE for orchestrating AI coding agents. Please briefly tell me how you can help.";

/**
 * The opening turn for an assistant a hub on another machine started (#13392).
 * Nobody is here to answer the usual greeting's question, and a pane whose
 * last turn ended on one holds every wake line as a question for the person,
 * so this one states the role and asks for an answer that isn't a question.
 */
export const HUB_STARTED_ASSISTANT_GREETING =
  "Daintree started you for the hub assistant on another machine, to carry out its requests on this machine. Nothing to do yet: reply with one short sentence saying you're ready.";

/** Every opening turn a launch sends on its own; a transcript holding only one is no conversation. */
export const LAUNCH_GREETINGS: ReadonlySet<string> = new Set([
  HELP_ASSISTANT_GREETING,
  HUB_STARTED_ASSISTANT_GREETING,
]);
