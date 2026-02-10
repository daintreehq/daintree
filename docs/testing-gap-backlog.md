# Aggressive Testing Backlog

Prioritized files that still need heavier adversarial testing.

## Tier 1: Critical backend/process paths

Tier 1 backlog is currently cleared. Continue with Tier 2+ for broader hardening.

## Tier 2: Renderer orchestration/state paths

Tier 2 backlog is currently cleared. Continue with Tier 3+ for broader hardening.

## Tier 3: Hooks with multi-store side effects

Tier 3 backlog is currently cleared. Continue with Tier 4 for integration hardening.

## Tier 4: Action-definition integration surfaces

1. `src/services/actions/definitions/terminalActions.ts`
2. `src/services/actions/definitions/panelActions.ts`
3. `src/services/actions/definitions/worktreeActions.ts`
4. `src/services/actions/definitions/preferencesActions.ts`
5. `src/services/actions/definitions/systemActions.ts`
6. `src/services/actions/definitions/projectActions.ts`
7. `src/services/actions/definitions/agentActions.ts`
8. `src/services/actions/definitions/githubActions.ts`
9. `src/services/actions/definitions/logActions.ts`
10. `src/services/actions/definitions/workflowActions.ts`

## Completed In Hardening Rounds

- `electron/ipc/handlers/copyTree.ts`
- `electron/services/GitService.ts`
- `electron/services/CopyTreeService.ts`
- `electron/services/ProcessDetector.ts`
- `electron/services/NotesService.ts`
- `electron/services/DevPreviewSessionService.ts`
- `electron/services/PtyPool.ts`
- `electron/services/commands/githubWorkIssue.ts`
- `electron/services/commands/githubCreateIssue.ts`
- `electron/services/assistant/actionTools.ts`
- `electron/services/github/GitHubAuth.ts`
- `electron/services/github/GitHubQueries.ts`
- `electron/services/pty/AgentStateService.ts`
- `electron/services/pty/PtyEventsBridge.ts`
- `electron/services/pty/terminalSessionPersistence.ts`
- `electron/services/pty/TerminalSerializerService.ts`
- `src/services/KeybindingService.ts`
- `src/services/SemanticAnalysisService.ts`
- `src/services/terminal/TerminalOutputIngestService.ts`
- `src/services/terminal/TerminalResizeController.ts`
- `src/services/terminal/TerminalWakeManager.ts`
- `src/store/assistantChatStore.ts`
- `src/store/errorStore.ts`
- `src/store/eventStore.ts`
- `src/store/logsStore.ts`
- `src/store/projectSettingsStore.ts`
- `src/store/pulseStore.ts`
- `src/store/recipeStore.ts`
- `src/store/sidecarStore.ts`
- `src/store/userAgentRegistryStore.ts`
- `src/store/worktreeFilterStore.ts`
- `src/store/worktreeStore.ts`
- `src/hooks/useProjectSettings.ts`
- `src/hooks/useSearchablePalette.ts`
- `src/hooks/useActionPalette.ts`
- `src/hooks/useMenuActions.ts`
- `src/hooks/usePanelPalette.ts`
- `src/hooks/useProjectSwitcherPalette.ts`
- `src/hooks/useRepositoryStats.ts`
- `src/hooks/useWorktreeActions.ts`
- `src/hooks/useTerminalLogic.ts`
- `src/hooks/useTerminalSelectors.ts`
- `src/hooks/useAssistantStreamProcessor.ts`
- `src/hooks/useContextInjection.ts`
