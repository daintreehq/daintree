const CHAT_HOSTS: Record<string, { title: string; icon: string }> = {
  "claude.ai": { title: "Claude", icon: "claude" },
  "chatgpt.com": { title: "ChatGPT", icon: "codex" },
  "gemini.google.com": { title: "Gemini", icon: "gemini" },
  "grok.com": { title: "Grok", icon: "grok" },
  "chat.mistral.ai": { title: "Le Chat", icon: "mistral" },
  "chat.qwen.ai": { title: "Qwen", icon: "qwen" },
  "kimi.com": { title: "Kimi", icon: "kimi" },
};

export function getAIAgentInfo(url: string): { title: string; icon: string } | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return CHAT_HOSTS[hostname] ?? null;
  } catch {
    return null;
  }
}
