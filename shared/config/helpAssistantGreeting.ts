/**
 * The opening turn `help.launchAgent` sends on the user's behalf. A transcript
 * holding nothing but this is a launch, not a conversation, so the past-session
 * picker leaves it out (#13206).
 */
export const HELP_ASSISTANT_GREETING =
  "I need help with Daintree, an IDE for orchestrating AI coding agents. Please briefly tell me how you can help.";
