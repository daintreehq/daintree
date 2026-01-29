import { store } from "../store.js";
import type { AppAgentConfig } from "../../shared/types/appAgent.js";

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";

export class AppAgentService {
  getConfig(): Omit<AppAgentConfig, "apiKey"> {
    const config = store.get("appAgentConfig");
    const { apiKey: _, ...safeConfig } = config;
    return safeConfig;
  }

  setConfig(config: Partial<AppAgentConfig>): void {
    const currentConfig = store.get("appAgentConfig");
    store.set("appAgentConfig", { ...currentConfig, ...config });
  }

  hasApiKey(): boolean {
    const config = store.get("appAgentConfig");
    return !!config.apiKey;
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
    const timeoutId = setTimeout(() => abortController.abort(), 15000);

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

      clearTimeout(timeoutId);

      if (response.ok) {
        return { valid: true };
      }

      if (response.status === 401) {
        return { valid: false, error: "Invalid API key" };
      }

      if (response.status === 403) {
        return { valid: false, error: "API key does not have access to this model" };
      }

      if (response.status === 429) {
        // Rate limited but key is valid
        return { valid: true };
      }

      const errorText = await response.text().catch(() => "");
      return { valid: false, error: `API error: ${response.status} ${errorText}`.trim() };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return { valid: false, error: "Request timed out" };
      }

      return {
        valid: false,
        error: error instanceof Error ? error.message : "Failed to connect to API",
      };
    }
  }

  async testModel(model: string): Promise<{ valid: boolean; error?: string }> {
    const config = store.get("appAgentConfig");

    if (!config.apiKey) {
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
    const timeoutId = setTimeout(() => abortController.abort(), 15000);

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

      clearTimeout(timeoutId);

      if (response.ok) {
        return { valid: true };
      }

      if (response.status === 401) {
        return { valid: false, error: "API key is invalid" };
      }

      if (response.status === 404) {
        return { valid: false, error: "Model not found" };
      }

      if (response.status === 429) {
        // Rate limited but model is valid
        return { valid: true };
      }

      const errorText = await response.text().catch(() => "");
      return { valid: false, error: `API error: ${response.status} ${errorText}`.trim() };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return { valid: false, error: "Request timed out" };
      }

      return {
        valid: false,
        error: error instanceof Error ? error.message : "Failed to connect to API",
      };
    }
  }
}

export const appAgentService = new AppAgentService();
