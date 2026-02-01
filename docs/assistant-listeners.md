# Assistant Listener Architecture

The Canopy Assistant can subscribe to application events using the `register_listener` tool. This enables reactive workflows where the assistant monitors terminal agent state changes and responds appropriately.

## Event Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Event Flow                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐                           ┌──────────────────────┐   │
│  │ AgentStateService │                           │ TerminalStateListener │   │
│  │ (Source of Truth) │                           │ Bridge (Adapter)      │   │
│  └──────────────────┘                           └──────────────────────┘   │
│          │                                                ▲                  │
│          │ Detects state transitions                      │ Subscribes to    │
│          │ • idle → working → waiting → completed         │ agent:state-     │
│          │ • Pattern detection                            │ changed          │
│          │ • Activity monitoring                          │                  │
│          │                                                │                  │
│          │ Emits agent:state-changed                      │                  │
│          ▼                                                │                  │
│  ┌──────────────────┐                                    │                  │
│  │ Global Event Bus  │ ───────────────────────────────────┘                  │
│  │ (events.ts)       │                                                       │
│  └──────────────────┘                                                       │
│                                                                              │
│                                         Bridge transforms to                 │
│                                         terminal:state-changed               │
│                                         (assistant-facing only)              │
│                                                │                             │
│                                                ▼                             │
│                                       ┌──────────────────────┐              │
│                                       │   ListenerManager     │              │
│                                       │   (Filter & Match)    │              │
│                                       └──────────────────────┘              │
│                                                │                             │
│                                                │ Filters by:                 │
│                                                │ • eventType                 │
│                                                │ • terminalId                │
│                                                │ • toState                   │
│                                                ▼                             │
│                                       ┌──────────────────────┐              │
│                                       │   IPC Handler         │              │
│                                       │   (assistant.ts)      │              │
│                                       └──────────────────────┘              │
│                                                │                             │
│                                                │ listener_triggered          │
│                                                │ chunk                       │
│                                                ▼                             │
│                                       ┌──────────────────────┐              │
│                                       │   Renderer           │              │
│                                       │   (Assistant Chat)   │              │
│                                       └──────────────────────┘              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### AgentStateService (`electron/services/pty/AgentStateService.ts`)

The source of truth for agent state. Responsibilities:

- **State Tracking**: Maintains current state for each terminal agent
- **Transition Logic**: Validates and executes state transitions
- **Event Emission**: Emits `agent:state-changed` events to the global event bus
- **Trigger Inference**: Determines what caused each state change
- **Confidence Scoring**: Assigns confidence levels based on detection method

Key methods:

| Method | Purpose |
|--------|---------|
| `updateAgentState()` | Process events and emit state changes |
| `transitionState()` | External observer state updates with session validation |
| `inferTrigger()` | Determine cause of state change |
| `inferConfidence()` | Calculate confidence level |

### TerminalStateListenerBridge (`electron/services/assistant/TerminalStateListenerBridge.ts`)

Adapts internal events to the assistant-facing format:

- Subscribes to `agent:state-changed` on the global event bus
- Transforms event payload to `terminal:state-changed` format
- Queries `ListenerManager` for matching listeners
- Emits `listener_triggered` chunks to matching sessions

Event transformation:

```typescript
// Internal format (from AgentStateService)
{
  agentId, state, previousState, timestamp,
  terminalId, worktreeId, trigger, confidence,
  traceId? // optional trace identifier
}

// External format (sent to assistant)
{
  terminalId, agentId, oldState, newState,
  toState, worktreeId, timestamp
}
```

### ListenerManager (`electron/services/assistant/ListenerManager.ts`)

Manages listener registration and matching:

- Stores active listeners with session association
- Validates filter criteria on registration
- Matches incoming events against filters
- Provides session-scoped cleanup

### IPC Handler (`electron/ipc/handlers/assistant.ts`)

Initializes the bridge and provides the chunk emitter:

```typescript
const emitChunkToRenderer = (sessionId: string, chunk: StreamChunk): void => {
  sendToWebContents(mainWindow.webContents, CHANNELS.ASSISTANT_CHUNK, {
    sessionId,
    chunk,
  });
};

initTerminalStateListenerBridge(emitChunkToRenderer);
```

## Agent State Machine

States flow through a defined lifecycle:

```
     ┌─────────────────────────────────────────────────────┐
     │                                                     │
     ▼                                                     │
  ┌──────┐    start/busy     ┌─────────┐    silence     ┌─────────┐
  │ idle │ ────────────────► │ working │ ─────────────► │ waiting │
  └──────┘                   └─────────┘                └─────────┘
     ▲                            │                          │
     │                            │ exit(0)                  │ input
     │                            ▼                          │
     │                      ┌───────────┐                    │
     │                      │ completed │                    │
     │                      └───────────┘                    │
     │                                                       │
     │                      ┌────────┐                       │
     └──────────────────────│ failed │◄──────────────────────┘
        error at any point  └────────┘     error/exit(!=0)

Note: Shell terminals also have a 'running' state. This diagram shows agent-only states.
```

### State Definitions

| State | Description | Triggers |
|-------|-------------|----------|
| `idle` | Agent spawned, not yet active | Initial state |
| `working` | Agent actively processing | Start event, busy event, input from waiting state |
| `waiting` | Agent paused, awaiting input | Silence timeout, prompt detection |
| `completed` | Agent finished successfully | Process exit with code 0 |
| `failed` | Agent encountered error | Error event, non-zero exit |

## State Detection Heuristics

### Pattern-Based Detection

The `AgentPatternDetector` scans terminal output for CLI-specific status indicators:

**Claude patterns:**
- `✽ Deliberating… (esc to interrupt · 15s)`
- `esc to interrupt` at end of line

**Gemini patterns:**
- `⠼ Unpacking Project Details (esc to cancel, 14s)`
- Braille spinner characters (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`)

**Codex patterns:**
- `• Working (1s • esc to interrupt)`

Confidence levels (per-agent):
- Primary pattern match: 0.95
- Fallback pattern match: 0.75 (Claude/Codex), 0.7 (Gemini), 0.65 (universal)

### Activity-Based Detection

The `ActivityMonitor` tracks terminal activity:

1. **Output Volume**: High bytes/second indicates working state
2. **Line Rewrites**: Spinner-like CR sequences
3. **Silence Detection**: Debounce period without output triggers waiting

Configuration defaults for agent terminals:
- Idle debounce: 2000ms
- Activity window: 1000ms
- Minimum frames: 2
- Minimum bytes: 32 bytes

High-output recovery threshold: 2048 bytes/second (separate guard mechanism)

### Prompt Detection

Detects when agent displays input prompt:

- Scans visible terminal lines for prompt patterns
- Uses cursor line for high-confidence detection
- Prompt hint patterns for fallback scanning
- Default confidence: 0.85

## Listener Tools

### register_listener

Subscribe to events:

```javascript
register_listener({
  eventType: "terminal:state-changed",
  filter: {
    toState: "waiting",
    // Optional: terminalId: "abc-123"
  }
})
```

Returns:
```javascript
{
  success: true,
  listenerId: "uuid-here",
  eventType: "terminal:state-changed",
  filter: { toState: "waiting" },
  message: "Successfully subscribed to terminal:state-changed events"
}
```

### list_listeners

Query active listeners:

```javascript
list_listeners()
```

Returns:
```javascript
{
  success: true,
  count: 2,
  listeners: [
    { listenerId: "...", eventType: "terminal:state-changed", filter: {...}, createdAt: 1234567890 }
  ]
}
```

### remove_listener

Unsubscribe by ID:

```javascript
remove_listener({ listenerId: "uuid-here" })
```

## Filter Criteria

Filters use exact-match semantics on event data fields:

| Filter Key | Type | Description |
|------------|------|-------------|
| `terminalId` | string | Match specific terminal |
| `toState` | string | Match target state (`waiting`, `completed`, etc.) |
| `oldState` | string | Match previous state |
| `newState` | string | Match new state (same as toState) |
| `worktreeId` | string | Match associated worktree |
| `agentId` | string | Match agent identifier |
| `timestamp` | number | Match specific timestamp (rarely used) |

Filter values can be: `string | number | boolean | null`

Empty filter `{}` matches all events of the specified type.

## Session Lifecycle

Listeners are scoped to assistant conversation sessions:

1. **Registration**: Listener associated with `sessionId`
2. **Matching**: Only listeners for matching session receive events
3. **Cleanup**: Session end clears all associated listeners

The bridge is destroyed on:
- WebContents destruction
- Handler cleanup (app shutdown)

Note: Navigation events cancel active assistant requests but do not destroy the bridge itself.

## Session Token Validation

`AgentStateService.transitionState()` validates session tokens to prevent stale observations:

```typescript
if (spawnedAt !== undefined && terminal.spawnedAt !== spawnedAt) {
  // Reject - terminal was restarted since observation began
  return false;
}
```

This prevents race conditions when:
- Terminal restarts during observation
- Multiple sessions observe same terminal
- Delayed events arrive after restart

## Troubleshooting

### Listeners Not Triggering

1. **Wrong event type**: Only `terminal:state-changed` is bridged currently
2. **Filter mismatch**: Check exact string match on filter values
3. **Session mismatch**: Listener registered in different conversation
4. **Terminal restarted**: Session token no longer matches

### Debug Checklist

1. Call `list_listeners()` to verify registration
2. Check filter criteria matches expected event data exactly
3. Verify terminal ID is correct (use `terminal_list()`)
4. Check state actually changed (same-state transitions don't emit)

### State Detection Issues

If waiting state isn't detected:
- Agent may not have recognizable prompt patterns
- Activity timeout may not have elapsed (default 2000ms for agents)
- High output rate may be preventing transition

If working state persists:
- Pattern detection may be matching stale output
- Line rewrite detection firing on non-spinner output

## Performance Considerations

- `ListenerManager` iterates all listeners on each event
- Bridge persists across navigation; destroyed only on webContents destruction
- Pattern detection polling: 50ms (high activity) or 500ms (low activity) depending on tier

## Usage Examples

### Monitor Single Terminal

```javascript
// Launch agent
const result = agent_launch({ agentId: "claude", prompt: "Run tests" });

// Register listener for this terminal
register_listener({
  eventType: "terminal:state-changed",
  filter: { terminalId: result.terminalId, toState: "waiting" }
});
```

### Monitor All Waiting States

```javascript
register_listener({
  eventType: "terminal:state-changed",
  filter: { toState: "waiting" }
});
```

### Multi-Step Workflow

```javascript
// Step 1: Create worktree and launch agent
const wt = worktree_createWithRecipe({ branchName: "feature-x", recipeId: "dev" });
const agent = agent_launch({ agentId: "claude", worktreeId: wt.worktreeId, prompt: "Implement feature" });

// Step 2: Register completion listener
register_listener({
  eventType: "terminal:state-changed",
  filter: { terminalId: agent.terminalId, toState: "completed" }
});

// Step 3: Handle notification when received
// (notification chunk arrives when agent completes)
// Then check output and inform user
terminal_getOutput({ terminalId: agent.terminalId, maxLines: 50 });
```

### React to Waiting State

When a `listener_triggered` notification arrives for a waiting state:

1. Query terminal output: `terminal_getOutput({ terminalId, maxLines: 20 })`
2. Analyze if agent is asking a question
3. Either provide input: `terminal_sendCommand({ terminalId, command: "y" })`
4. Or notify user and wait for instructions
