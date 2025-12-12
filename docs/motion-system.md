# Motion System

Canopy's motion system follows a "digital ecology" design philosophy—motion should feel organic, purposeful, and respectful of user attention and system resources.

## Philosophy

### Purpose-First Motion

Every animation in Canopy serves one of three purposes:

1. **Confirm actions** — Provide immediate feedback that an action was received (selections, clicks)
2. **Explain hierarchy** — Show relationships between elements (transitions, entrances/exits)
3. **Convey life signs** — Indicate ongoing activity without demanding attention (status pulses)

### Design Principles

- **Subtle over flashy** — Animations enhance rather than distract
- **Performance first** — All motion can be disabled for resource-constrained scenarios
- **Accessibility always** — Reduced motion preferences are fully respected
- **Consistency** — Shared timing tokens create cohesive rhythm

## Timing Tokens

CSS custom properties control all animation and transition durations, ensuring consistent timing across the application.

| Token                           | Default  | Scope            | Purpose                                                      |
| ------------------------------- | -------- | ---------------- | ------------------------------------------------------------ |
| `--animation-duration`          | `150ms`  | `:root`          | Default animation length for UI elements                     |
| `--transition-duration`         | `150ms`  | `:root`          | Default transition length for property changes               |
| `--terminal-animation-duration` | `150ms`  | `:root`          | Terminal-specific animations (restore, trash)                |
| `--terminal-ping-duration`      | `1600ms` | `.terminal-pane` | Attention-grabbing ping animation (scoped to terminal panes) |
| `--terminal-select-duration`    | `200ms`  | `.terminal-pane` | Selection state transitions (scoped to terminal panes)       |

**Note:** Terminal-specific timing tokens (`--terminal-ping-duration`, `--terminal-select-duration`) are scoped to `.terminal-pane` rather than `:root`. Animations using these tokens must be applied within a `.terminal-pane` context.

### Timing Philosophy

- **150ms** — Fast, snappy feedback for immediate interactions
- **200ms** — Slightly deliberate feel for selection/focus changes
- **1600ms** — Long enough to be noticed, short enough not to annoy (attention animations)
- **1-2s loops** — Ambient status indicators that don't demand attention

## Easing Functions

### Primary Easing

```css
cubic-bezier(0.4, 0, 0.2, 1)
```

Used for most animations. Provides a slight ease-in-out curve that feels natural without being slow.

### Secondary Easing

`ease-out` is used for both entrance and exit animations in the current implementation (e.g., `terminal-restoring`, `terminal-trashing`).

## Animation Catalog

### Status Indicators

#### `animate-activity-pulse`

Pulsing indicator for very recent terminal activity.

```css
.animate-activity-pulse {
  animation: activity-pulse 1s ease-in-out infinite;
}
```

**Use case:** Activity light on terminal cards to show recent output.

**Keyframes:** Opacity 1 → 0.7 with slight scale 1 → 1.1 at midpoint.

#### `animate-agent-pulse`

Subtle opacity pulse for agent status indicators.

```css
.animate-agent-pulse {
  animation: agent-pulse 1.5s ease-in-out infinite;
}
```

**Use case:** Working/waiting state indicators in terminal headers.

**Keyframes:** Opacity 1 → 0.5 at midpoint.

#### `status-working`

Color-shifting animation for "working" agent state.

```css
.status-working {
  animation: status-pulse 2s ease-in-out infinite;
}
```

**Use case:** Text or icon color when an agent is actively processing.

**Keyframes:** Alternates between Emerald-500 (`#10b981`) and Emerald-400 (`#34d399`).

### Terminal Lifecycle

#### `terminal-restoring`

Entrance animation when restoring a trashed terminal.

```css
.terminal-restoring {
  animation: terminal-restore var(--terminal-animation-duration) ease-out;
}
```

**Keyframes:** Opacity 0 → 1, translateY 4px → 0.

#### `terminal-trashing`

Exit animation when sending a terminal to trash.

```css
.terminal-trashing {
  animation: terminal-trash var(--terminal-animation-duration) ease-out forwards;
}
```

**Keyframes:** Opacity 1 → 0, translateY 0 → 4px.

### Attention/Selection

#### `animate-terminal-ping`

Overlay-based ping animation for already-selected terminals. Creates a brightness wave and border pulse.

```css
.animate-terminal-ping::before {
  animation: terminal-ping-overlay var(--terminal-ping-duration) cubic-bezier(0.4, 0, 0.2, 1) both;
}
.animate-terminal-ping::after {
  animation: terminal-ping-border var(--terminal-ping-duration) cubic-bezier(0.4, 0, 0.2, 1) both;
}
```

**Use case:** "Locate this terminal" command on an already-selected terminal.

**Peak timing:** 35% of duration (provides early visual confirmation).

#### `animate-terminal-ping-select`

Element-level animation for terminals being selected. Animates directly on the element, not an overlay.

```css
.animate-terminal-ping-select {
  animation: terminal-ping-select-element var(--terminal-ping-duration) cubic-bezier(0.4, 0, 0.2, 1)
    both !important;
}
```

**Use case:** "Locate this terminal" command causing selection change.

**Journey:** Unselected → Overshoot (brighter than selected) → Settled (matches `.terminal-selected`).

#### `animate-terminal-header-ping`

Border-color pulse for terminal headers during ping.

```css
.animate-terminal-header-ping {
  animation: terminal-header-border var(--terminal-ping-duration, 1600ms)
    cubic-bezier(0.4, 0, 0.2, 1) both;
}
```

**Use case:** Paired with terminal ping to highlight header separator.

#### `animate-eco-title` / `animate-eco-title-select`

Text shadow glow effect for terminal titles during ping. Both classes share the same `title-glow` animation.

```css
.animate-eco-title,
.animate-eco-title-select {
  animation: title-glow var(--terminal-ping-duration, 1600ms) cubic-bezier(0.4, 0, 0.2, 1) both;
}
```

**Use case:** Title emphasis during terminal ping animation.

**Keyframes:** Text-shadow 0 → 8px semi-transparent white glow (`rgb(255 255 255 / 0.3)`) at 35% → 0.

### Terminal Transitions

The `.terminal-pane` class defines base transitions for selection state changes and provides the structural foundation for ping animations:

```css
.terminal-pane {
  position: relative; /* Required for ::before and ::after overlays */
  transition:
    background-color var(--terminal-select-duration) cubic-bezier(0.4, 0, 0.2, 1),
    border-color var(--terminal-select-duration) cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow var(--terminal-select-duration) cubic-bezier(0.4, 0, 0.2, 1);
}
```

**Important:** The `position: relative` is essential for `animate-terminal-ping` overlay pseudo-elements to work correctly.

### Terminal Selected State

The `.terminal-selected` class applies the selected appearance. There's also a backwards-compatible `.terminal-focused` alias with identical styling.

## Usage Guidelines

### When to Use Animation

| Scenario          | Animation                         | Why                        |
| ----------------- | --------------------------------- | -------------------------- |
| Terminal selected | `.terminal-selected` (transition) | Confirms user action       |
| "Locate" command  | `animate-terminal-ping`           | Draws attention to target  |
| Terminal restored | `terminal-restoring`              | Shows element entering     |
| Terminal trashed  | `terminal-trashing`               | Shows element leaving      |
| Agent working     | `status-working`                  | Ambient activity indicator |
| Recent activity   | `animate-activity-pulse`          | Transient attention signal |

### When NOT to Use Animation

- **Frequent updates** — Don't animate changes happening more than once per second
- **Bulk operations** — Skip animation when modifying many elements at once
- **Background processes** — Use static indicators for long-running operations
- **Navigation** — Instant page/panel transitions feel more responsive

### Adding New Animations

1. **Define the keyframes** in `src/index.css` with descriptive names
2. **Use timing tokens** — Reference `--animation-duration` or `--terminal-animation-duration`
3. **Add will-change** — For animated properties (`opacity`, `transform`)
4. **Add reduced-motion override** — See Accessibility section

**Template:**

```css
@keyframes my-animation {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.animate-my-animation {
  animation: my-animation var(--animation-duration) ease-out;
  will-change: opacity;
}

@media (prefers-reduced-motion: reduce) {
  .animate-my-animation {
    animation: none;
    opacity: 1;
  }
}
```

## Accessibility Requirements

All animations MUST support both system preferences and application settings.

### `prefers-reduced-motion`

System-level setting from the operating system. Canopy disables all decorative animations when this is set.

```css
@media (prefers-reduced-motion: reduce) {
  /* Disable status pulse animations */
  .animate-activity-pulse,
  .animate-agent-pulse,
  .status-working {
    animation: none;
    opacity: 1;
    transform: none;
    will-change: auto;
  }

  /* Disable button transforms */
  button,
  [role="button"],
  [type="button"],
  [type="submit"],
  [type="reset"] {
    transform: none !important;
    transition: none !important;
  }

  /* Disable terminal lifecycle animations */
  .terminal-restoring,
  .terminal-trashing {
    animation: none;
  }

  /* Disable terminal ping animations */
  .animate-terminal-ping::before,
  .animate-terminal-ping::after,
  .animate-terminal-header-ping {
    animation: none;
    opacity: 0;
    background: transparent;
    box-shadow: none;
  }

  /* Replace ping-select animation with simple transition */
  .animate-terminal-ping-select {
    animation: none !important;
    transition:
      background-color 0.2s,
      border-color 0.2s,
      box-shadow 0.2s !important;
  }

  /* Disable title glow */
  .animate-eco-title,
  .animate-eco-title-select {
    animation: none;
    text-shadow: none;
  }
}
```

### Performance Mode

Application-level kill switch for all animations, set via `data-performance-mode="true"` on the body element. Used when running many concurrent terminals.

```css
body[data-performance-mode="true"] *,
body[data-performance-mode="true"] *::before,
body[data-performance-mode="true"] *::after {
  animation: none !important;
  animation-play-state: paused !important;
  transition: none !important;
}
```

### Checklist for New Animations

- [ ] Uses timing token instead of hardcoded duration
- [ ] Has `will-change` property for animated attributes
- [ ] Disabled in `prefers-reduced-motion` media query
- [ ] Disabled by `body[data-performance-mode="true"]` selector
- [ ] Falls back gracefully (element still visible/functional)

## Performance Considerations

### `will-change` Property

Declare which properties will animate to enable GPU acceleration:

```css
.animate-my-animation {
  will-change: opacity, transform;
}
```

**Remove in reduced motion:**

```css
@media (prefers-reduced-motion: reduce) {
  .animate-my-animation {
    will-change: auto;
  }
}
```

### Prefer Transform and Opacity

These properties don't trigger layout recalculation:

- `opacity` — Fades
- `transform` — Scale, translate, rotate
- `filter` — Blur, brightness (use sparingly)

**Avoid animating:**

- `width`, `height` — Triggers layout
- `top`, `left`, `right`, `bottom` — Triggers layout
- `margin`, `padding` — Triggers layout
- `box-shadow` — Expensive but acceptable for highlights

### Looping Animations

For infinite animations, keep the effect subtle:

- Use opacity changes over scale changes
- Keep loops at 1s or longer to avoid visual noise
- Ensure the animation doesn't cause cumulative drift

## Examples

### Correct: Adding a Fade-in Animation

```css
@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.animate-fade-in {
  animation: fade-in var(--animation-duration) ease-out;
  will-change: opacity;
}

@media (prefers-reduced-motion: reduce) {
  .animate-fade-in {
    animation: none;
    opacity: 1;
    will-change: auto;
  }
}
```

### Correct: Adding a Status Pulse

```css
@keyframes custom-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

.animate-custom-pulse {
  animation: custom-pulse 2s ease-in-out infinite;
  will-change: opacity;
}

@media (prefers-reduced-motion: reduce) {
  .animate-custom-pulse {
    animation: none;
    opacity: 1;
    will-change: auto;
  }
}
```

### Incorrect: Missing Accessibility Support

```css
/* BAD - no reduced motion support */
.animate-bounce {
  animation: bounce 0.5s infinite;
}
```

### Incorrect: Hardcoded Duration

```css
/* BAD - should use --animation-duration */
.animate-slide {
  animation: slide 150ms ease-out;
}
```

## Quick Reference

| Class                          | Duration | Loop | Purpose                        |
| ------------------------------ | -------- | ---- | ------------------------------ |
| `animate-activity-pulse`       | 1s       | Yes  | Activity indicator             |
| `animate-agent-pulse`          | 1.5s     | Yes  | Agent status                   |
| `status-working`               | 2s       | Yes  | Working state color            |
| `terminal-restoring`           | 150ms    | No   | Restore entrance               |
| `terminal-trashing`            | 150ms    | No   | Trash exit                     |
| `animate-terminal-ping`        | 1600ms   | No   | Attention (selected)           |
| `animate-terminal-ping-select` | 1600ms   | No   | Attention (becoming selected)  |
| `animate-terminal-header-ping` | 1600ms   | No   | Header highlight               |
| `animate-eco-title`            | 1600ms   | No   | Title glow                     |
| `animate-eco-title-select`     | 1600ms   | No   | Title glow (selection variant) |

**Note:** `.terminal-focused` exists as a backwards-compatible alias for `.terminal-selected`.
