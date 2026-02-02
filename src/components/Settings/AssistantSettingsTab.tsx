import { useEffect, useState, useCallback } from "react";
import { useAppAgentStore } from "@/store";
import { Button } from "@/components/ui/button";
import {
  Bot,
  Check,
  Eye,
  EyeOff,
  Sparkles,
  AlertCircle,
  Loader2,
  FlaskConical,
  RotateCcw,
} from "lucide-react";
import { DEFAULT_APP_AGENT_CONFIG } from "@shared/types";

type ValidationResult = "success" | "error" | "test-success" | "test-error" | null;

export function AssistantSettingsTab() {
  const { hasApiKey, config, initialize, setApiKey, setModel } = useAppAgentStore();
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSavingModel, setIsSavingModel] = useState(false);
  const [isTestingModel, setIsTestingModel] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [modelSaved, setModelSaved] = useState(false);
  const [modelTestResult, setModelTestResult] = useState<ValidationResult>(null);
  const [modelTestError, setModelTestError] = useState<string | null>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    if (config?.model && !modelInput) {
      setModelInput(config.model);
    }
  }, [config?.model, modelInput]);

  useEffect(() => {
    if (!validationResult) return;
    const timer = setTimeout(() => {
      setValidationResult(null);
      setErrorMessage(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [validationResult]);

  useEffect(() => {
    if (!modelTestResult) return;
    const timer = setTimeout(() => {
      setModelTestResult(null);
      setModelTestError(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, [modelTestResult]);

  const handleTestApiKey = useCallback(async () => {
    if (!apiKeyInput.trim()) return;

    setIsTesting(true);
    setValidationResult(null);
    setErrorMessage(null);

    try {
      const result = await window.electron.appAgent.testApiKey(apiKeyInput.trim());
      setValidationResult(result.valid ? "test-success" : "test-error");
      if (!result.valid) {
        setErrorMessage(result.error || "Invalid API key");
      }
    } catch (error) {
      setValidationResult("test-error");
      setErrorMessage(error instanceof Error ? error.message : "Failed to test API key");
    } finally {
      setIsTesting(false);
    }
  }, [apiKeyInput]);

  const handleSaveApiKey = useCallback(async () => {
    if (!apiKeyInput.trim()) return;

    setIsValidating(true);
    setValidationResult(null);
    setErrorMessage(null);

    try {
      const testResult = await window.electron.appAgent.testApiKey(apiKeyInput.trim());
      if (!testResult.valid) {
        setValidationResult("error");
        setErrorMessage(testResult.error || "Invalid API key");
        return;
      }

      await setApiKey(apiKeyInput.trim());
      setApiKeyInput("");
      setValidationResult("success");
    } catch (error) {
      setValidationResult("error");
      setErrorMessage(error instanceof Error ? error.message : "Failed to save API key");
    } finally {
      setIsValidating(false);
    }
  }, [apiKeyInput, setApiKey]);

  const handleSaveModel = useCallback(async () => {
    if (!modelInput.trim()) return;

    setIsSavingModel(true);
    setModelSaved(false);

    try {
      await setModel(modelInput.trim());
      setModelSaved(true);
      setTimeout(() => setModelSaved(false), 3000);
    } catch (error) {
      setModelTestError(error instanceof Error ? error.message : "Failed to save model");
    } finally {
      setIsSavingModel(false);
    }
  }, [modelInput, setModel]);

  const handleTestModel = useCallback(async () => {
    if (!modelInput.trim()) return;

    setIsTestingModel(true);
    setModelTestResult(null);
    setModelTestError(null);

    try {
      const result = await window.electron.appAgent.testModel(modelInput.trim());
      setModelTestResult(result.valid ? "test-success" : "test-error");
      if (!result.valid) {
        setModelTestError(result.error || "Model test failed");
      }
    } catch (error) {
      setModelTestResult("test-error");
      setModelTestError(error instanceof Error ? error.message : "Failed to test model");
    } finally {
      setIsTestingModel(false);
    }
  }, [modelInput]);

  const handleResetModel = useCallback(() => {
    setModelInput(DEFAULT_APP_AGENT_CONFIG.model);
    setModelTestResult(null);
    setModelTestError(null);
  }, []);

  const isModelModified = config?.model !== modelInput;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-canopy-text">Canopy Assistant</h2>
          <span className="shrink-0 whitespace-nowrap px-1.5 py-0.5 text-xs leading-none font-medium rounded bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-400 border border-amber-300 dark:border-amber-500/20">
            Experimental
          </span>
        </div>
        <p className="text-sm text-canopy-text/70">
          The Canopy Assistant is an AI-powered panel that lets you control the app using natural
          language. This is an experimental feature actively being developed. Press{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-canopy-bg border border-canopy-border text-xs font-mono">
            ⌘⇧K
          </kbd>{" "}
          to open the Assistant.
        </p>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4 space-y-4">
        <div className="flex items-center gap-3 pb-3 border-b border-canopy-border">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-gradient-to-br from-orange-500/20 to-red-500/20 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-orange-400" />
          </div>
          <div className="flex-1">
            <h4 className="text-sm font-medium text-canopy-text">Fireworks AI</h4>
            <p className="text-xs text-canopy-text/50">OpenAI-compatible inference API</p>
          </div>
          <div>
            {hasApiKey ? (
              <span className="flex items-center gap-1.5 text-xs text-green-500">
                <Check size={14} />
                Configured
              </span>
            ) : (
              <span className="text-xs text-canopy-text/50">Not configured</span>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {/* API Key */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-canopy-text">
              {hasApiKey ? "Update API Key" : "API Key"}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={apiKeyInput}
                  onChange={(e) => {
                    setApiKeyInput(e.target.value);
                    setValidationResult(null);
                    setErrorMessage(null);
                  }}
                  placeholder={hasApiKey ? "Enter new API key to update..." : "fw-xxx..."}
                  className="w-full rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg px-3 py-2 pr-10 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 placeholder:text-canopy-text/30"
                  disabled={isValidating || isTesting}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-canopy-text/40 hover:text-canopy-text"
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <Button
                onClick={() => void handleTestApiKey()}
                disabled={isTesting || isValidating || !apiKeyInput.trim()}
                variant="outline"
                size="sm"
                className="min-w-[70px] text-canopy-text border-canopy-border hover:bg-canopy-border"
              >
                {isTesting ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <>
                    <FlaskConical />
                    Test
                  </>
                )}
              </Button>
              <Button
                onClick={() => void handleSaveApiKey()}
                disabled={isValidating || isTesting || !apiKeyInput.trim()}
                size="sm"
                className="min-w-[70px]"
              >
                {isValidating ? <Loader2 className="animate-spin" /> : "Save"}
              </Button>
            </div>

            {validationResult === "success" && (
              <p className="text-xs text-[var(--color-status-success)] flex items-center gap-1">
                <Check className="w-3 h-3" />
                API key validated and saved successfully
              </p>
            )}
            {validationResult === "test-success" && (
              <p className="text-xs text-[var(--color-status-success)] flex items-center gap-1">
                <Check className="w-3 h-3" />
                API key is valid! Click Save to store it.
              </p>
            )}
            {validationResult === "error" && (
              <p className="text-xs text-[var(--color-status-error)] flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {errorMessage || "Invalid API key. Please check and try again."}
              </p>
            )}
            {validationResult === "test-error" && (
              <p className="text-xs text-[var(--color-status-error)] flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {errorMessage || "API key test failed. Please check your key."}
              </p>
            )}

            <div className="px-3 py-2 rounded-[var(--radius-md)] bg-canopy-bg/50 border border-canopy-border/50">
              <p className="text-xs text-canopy-text/50">
                Get your API key from{" "}
                <button
                  onClick={() =>
                    void window.electron.system.openExternal(
                      "https://app.fireworks.ai/settings/users/api-keys"
                    )
                  }
                  className="text-canopy-accent hover:underline"
                >
                  app.fireworks.ai
                </button>
              </p>
            </div>
          </div>

          {/* Model */}
          <div className="space-y-2 pt-2 border-t border-canopy-border">
            <label className="text-sm font-medium text-canopy-text">Model</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={modelInput}
                onChange={(e) => {
                  setModelInput(e.target.value);
                  setModelTestResult(null);
                  setModelTestError(null);
                }}
                placeholder="accounts/fireworks/models/kimi-k2p5"
                className="flex-1 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 placeholder:text-canopy-text/30"
                disabled={isSavingModel || isTestingModel}
              />
              <Button
                onClick={handleResetModel}
                disabled={
                  isSavingModel || isTestingModel || modelInput === DEFAULT_APP_AGENT_CONFIG.model
                }
                variant="outline"
                size="sm"
                className="text-canopy-text border-canopy-border hover:bg-canopy-border"
                title="Reset to default"
              >
                <RotateCcw size={14} />
              </Button>
              <Button
                onClick={() => void handleTestModel()}
                disabled={isTestingModel || isSavingModel || !modelInput.trim() || !hasApiKey}
                variant="outline"
                size="sm"
                className="min-w-[70px] text-canopy-text border-canopy-border hover:bg-canopy-border"
                title={!hasApiKey ? "Configure API key first" : "Test model"}
              >
                {isTestingModel ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <>
                    <FlaskConical />
                    Test
                  </>
                )}
              </Button>
              <Button
                onClick={() => void handleSaveModel()}
                disabled={isSavingModel || isTestingModel || !modelInput.trim() || !isModelModified}
                size="sm"
                className="min-w-[70px]"
              >
                {isSavingModel ? <Loader2 className="animate-spin" /> : "Save"}
              </Button>
            </div>

            {modelTestResult === "test-success" && (
              <p className="text-xs text-[var(--color-status-success)] flex items-center gap-1">
                <Check className="w-3 h-3" />
                Model is valid! Click Save to use it.
              </p>
            )}
            {modelTestResult === "test-error" && (
              <p className="text-xs text-[var(--color-status-error)] flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                {modelTestError || "Model test failed"}
              </p>
            )}
            {modelSaved && (
              <p className="text-xs text-[var(--color-status-success)] flex items-center gap-1">
                <Check className="w-3 h-3" />
                Model saved successfully
              </p>
            )}
            {!hasApiKey && (
              <p className="text-xs text-canopy-text/50">
                Configure an API key above to test models
              </p>
            )}
            <p className="text-xs text-canopy-text/40">
              Default: <code className="font-mono">{DEFAULT_APP_AGENT_CONFIG.model}</code>
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-canopy-text">What can the Assistant do?</h4>
        <div className="grid gap-2">
          {[
            "Open settings, panels, and palettes",
            "Launch agents in terminals",
            "Navigate between worktrees",
            "Control the sidebar and focus mode",
            "Execute any registered action",
          ].map((item) => (
            <div key={item} className="flex items-center gap-2 text-sm text-canopy-text/60">
              <Bot size={14} className="text-canopy-accent shrink-0" />
              {item}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
