// eager-import-allow: reads app-agent config via store.get synchronously during service init
import { store } from "../store.js";
import type { AppAgentConfig } from "../../shared/types/appAgent.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
export const API_TEST_TIMEOUT_MS = 15_000;

function formatApiErrorText(rawText: string): string {
  const MAX_CHARS = 200;

  let message = rawText;
  try {
    const parsed = JSON.parse(rawText);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      message = parsed.error.message;
    }
  } catch {
    // Not JSON, use raw text
  }

  if (message.length > MAX_CHARS) {
    return message.slice(0, MAX_CHARS) + "...";
  }
  return message;
}

export class AppAgentService {
  getConfig(): Omit<AppAgentConfig, "apiKey"> {
    const config = store.get("appAgentConfig");
    const { apiKey: _, ...safeConfig } = config;
    return safeConfig;
  }

  setConfig(config: Partial<AppAgentConfig>): void {
    if (!config || typeof config !== "object") return;
    for (const [field, value] of Object.entries(config)) {
      if (value === undefined) continue;
      store.set(`appAgentConfig.${field}`, value);
    }
  }

  hasApiKey(): boolean {
    const config = store.get("appAgentConfig");
    return typeof config.apiKey === "string" && config.apiKey.trim() !== "";
  }

  async testApiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const config = store.get("appAgentConfig");
    const baseUrl = config.baseUrl || FIREWORKS_BASE_URL;

    let url: URL;
    try {
      url = new URL(`${baseUrl}/chat/completions`);
    } catch {
      return { valid: false, error: "Invalid base URL configured" };
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), API_TEST_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }),
        signal: abortController.signal,
      });

      if (response.ok) {
        clearTimeout(timeoutId);
        return { valid: true };
      }

      if (response.status === 401) {
        clearTimeout(timeoutId);
        return { valid: false, error: "Invalid API key" };
      }

      if (response.status === 403) {
        clearTimeout(timeoutId);
        return { valid: false, error: "API key does not have access to this model" };
      }

      if (response.status === 429) {
        clearTimeout(timeoutId);
        // Rate limited but key is valid
        return { valid: true };
      }

      const errorText = await response.text().catch(() => "");
      clearTimeout(timeoutId);
      return {
        valid: false,
        error: `API error: ${response.status} ${formatApiErrorText(errorText)}`.trim(),
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return { valid: false, error: "Request timed out" };
      }

      return {
        valid: false,
        error: formatErrorMessage(error, "Failed to connect to API"),
      };
    }
  }

  async testModel(model: string): Promise<{ valid: boolean; error?: string }> {
    const config = store.get("appAgentConfig");

    if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
      return { valid: false, error: "API key not configured" };
    }

    const baseUrl = config.baseUrl || FIREWORKS_BASE_URL;

    let url: URL;
    try {
      url = new URL(`${baseUrl}/chat/completions`);
    } catch {
      return { valid: false, error: "Invalid base URL configured" };
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), API_TEST_TIMEOUT_MS);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
        }),
        signal: abortController.signal,
      });

      if (response.ok) {
        clearTimeout(timeoutId);
        return { valid: true };
      }

      if (response.status === 401) {
        clearTimeout(timeoutId);
        return { valid: false, error: "API key is invalid" };
      }

      if (response.status === 404) {
        clearTimeout(timeoutId);
        return { valid: false, error: "Model not found" };
      }

      if (response.status === 429) {
        clearTimeout(timeoutId);
        // Rate limited but model is valid
        return { valid: true };
      }

      const errorText = await response.text().catch(() => "");
      clearTimeout(timeoutId);
      return {
        valid: false,
        error: `API error: ${response.status} ${formatApiErrorText(errorText)}`.trim(),
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return { valid: false, error: "Request timed out" };
      }

      return {
        valid: false,
        error: formatErrorMessage(error, "Failed to connect to API"),
      };
    }
  }
}

export const appAgentService = new AppAgentService();
