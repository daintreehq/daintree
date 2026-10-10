const SECRET_WORD = /\b(?:password|passphrase|passcode|pin|one-time code|otp|2fa|token|secret)\b/i;

/**
 * The prompt asks the user to type a secret, which the panel never takes inline.
 * A secret word in a line that ends asking for input (`Password:`, `Enter
 * passphrase for key '…':`) — not in a question about one ("Should I rotate the
 * token?"), which is an ordinary reply.
 */
export function isSecretPrompt(question: string | null): boolean {
  if (question === null) return false;
  const text = question.trim();
  return text.endsWith(":") && SECRET_WORD.test(text);
}
