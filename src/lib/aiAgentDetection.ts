export function getAIAgentInfo(url: string): { title: string; icon: string } | null {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    if (hostname === "claude.ai" || hostname === "www.claude.ai") {
      return { title: "Claude", icon: "claude" };
    }
    if (hostname === "chatgpt.com" || hostname === "www.chatgpt.com") {
      return { title: "ChatGPT", icon: "codex" };
    }
    if (hostname === "gemini.google.com") {
      return { title: "Gemini", icon: "gemini" };
    }
    return null;
  } catch {
    return null;
  }
}
