# Portal Theme Synchronization Plan

## 1. Intent

Deliver visual convergence between Daintree desktop and Daintree Portal so Portal uses the named Daintree theme as its native offline appearance and adopts the authenticated host's committed application theme while operating inside that host context.

This is a follow-on project to Daintree Portal v1. It must not expand or move the acceptance boundary of the active `Daintree Portal` SynthOps project. Implementation begins only after the active task `Complete cross-platform Portal acceptance and security readiness` is complete, providing a stable release baseline against which this project can be reviewed.

## 2. Binding Outcome

Portal and desktop must feel like sister applications through shared surface hierarchy, color semantics, typography roles, terminal colors, status language, radius strategy, and restrained accent usage while retaining platform-appropriate mobile layout, navigation, touch targets, system chrome, and accessibility behavior.

The desktop theme remains the source of truth for host-provided appearance. Portal never interprets the full CSS theme contract and never accepts arbitrary CSS, gradients, images, URLs, shadows, or component extension values over the remote protocol.

## 3. Existing Foundations

- Daintree already owns a three-layer theme pipeline: authored `ThemePalette`, compiled semantic `AppColorSchemeTokens`, and component-scoped extension variables. The canonical architecture is `docs/themes/theme-system.md`; the complete token semantics are in `docs/themes/theme-tokens.md`.
- The named Daintree theme is authored in `shared/theme/builtInThemes/daintree.ts` and compiled with all other built-ins through `shared/theme/themes.ts`.
- Committed desktop theme configuration is Main-owned through `electron/store.ts` and the application-theme IPC handlers. Renderer-only Theme Browser previews are not committed state and must not propagate remotely.
- The remote gateway already provides authenticated, versioned `session.hello` / `session.welcome` / `session.ready` negotiation through strict Zod envelope schemas and a pinned WSS connection.
- Portal already scopes the connected experience to `PortalShell`, which is the natural boundary for host-specific appearance without leaking one host's theme into discovery, pairing, or another host.
- Flutter analysis, widget tests, integration tests, host unit tests, CI checks, and the on-demand stabilization surface already exist. Tests ship with each implementation task rather than in a separate testing phase.
- Device identity and trust material already use protected platform storage. Appearance data is non-secret and introduces no new credential flow.
- The repository already depends on `culori`; no second general-purpose color library should be introduced unless the existing dependency demonstrably cannot support the bounded projection.

## 4. Architectural Decisions

### 4.1 Appearance ownership

Portal uses a generated representation of the named Daintree theme for entry, discovery, pairing, host management, and any host that does not provide a compatible appearance snapshot.

After the host authenticates the paired device, `session.welcome` may include the host's committed appearance snapshot. Portal applies that snapshot only inside the corresponding host route.

Portal retains the last authenticated host appearance during a transient disconnect or reconnect while the user remains inside that host route, preventing distracting visual flashes. It returns to the generated Daintree default when the route closes, the host context is replaced, or access is permanently revoked.

### 4.2 Portable contract

The wire contract is a strict, versioned `RemoteAppearanceSnapshot` separate from both `AppColorScheme` and the remote protocol version. Version 1 contains only bounded portable values:

| Group | Required semantics |
| --- | --- |
| Identity | Appearance schema version, monotonically increasing revision, theme ID, display name, dark/light polarity |
| Surfaces | Grid, chrome/sidebar, canvas, toolbar, panel, elevated panel, input, inset, hover, active |
| Text | Primary, secondary, muted, placeholder, inverse, link |
| Borders | Default, subtle, strong, divider, interactive |
| Accent | Primary, foreground, soft, muted, focus ring |
| Status and activity | Success, warning, danger, info, active, idle, working, waiting, completed and their required low-emphasis surfaces |
| Terminal | Background, foreground, muted text, cursor, cursor accent, selection, base ANSI colors, and bright ANSI colors |
| Strategy | Radius scale only in version 1 |

Every transmitted color is normalized to a concrete bounded representation accepted identically by TypeScript and Dart, preferably lowercase `#rrggbbaa`. Unsupported or unevaluable custom values fall back field-by-field to a safe value from the same-polarity built-in theme, then to the named Daintree default if necessary. The snapshot is validated before transmission and again before application.

The host applies the persisted accent override before projection. Desktop color-vision simulation, forced colors, high contrast, reduced motion, reduced transparency, text scaling, and system UI overlay preferences do not cross the wire; Portal derives those from the mobile device.

### 4.3 Compatibility

`appearance` is optional in `session.welcome`. A new Portal connected to an old host uses its generated Daintree default, while an old Portal connected to a new host ignores the additive field. This additive change does not require a remote protocol version bump.

Live synchronization uses an additive `appearance.updated` event carrying the same snapshot contract. Older clients already ignore unknown events. Portal applies only snapshots with a newer revision than the active one.

### 4.4 Visual convergence

Portal builds `ThemeData` explicitly from portable semantic values rather than using `ColorScheme.fromSeed`, which invents tones that do not match the desktop palette. The mapping covers scaffold and app-bar chrome, panes, cards, dialogs, sheets, inputs, dividers, buttons, list selection, focus, banners, status/activity indicators, and terminal rendering.

The generated Daintree default is produced from the TypeScript theme source and guarded by a deterministic drift check. TypeScript remains the only hand-authored palette source.

Portal uses system UI sans typography for product text and a bundled JetBrains Mono asset for terminal and technical metadata. Shared app-concept icons use a Lucide-compatible Flutter source or generated Lucide assets; platform-specific controls may retain native platform iconography where that distinction is meaningful.

Accent usage follows the desktop restraint rule: at most one load-bearing accent signal in an active focus region. Selection, membership, and secondary emphasis use neutral surface lift and borders unless accent is the necessary primary signal.

Mobile layout, information architecture, touch targets, keyboard behavior, responsive project/worktree/agent navigation, and native accessibility semantics remain Portal-owned and are not dictated by the host theme.

## 5. Security and Failure Boundaries

- Appearance is delivered only after paired-device authentication succeeds; unauthenticated pairing and discovery traffic never receives custom appearance data.
- Custom theme content is treated as untrusted input even though the host is authenticated.
- The projection uses an allowlist of semantic fields, strict length/count limits, concrete color normalization, and deterministic fallbacks.
- No raw CSS functions, `var()` references, gradients, data URIs, remote URLs, hero images, texture data, component extensions, arbitrary metadata, or executable content crosses the boundary.
- Malformed, oversized, unknown-version, or incomplete appearance data never terminates an otherwise valid remote session. Portal retains its last valid appearance and records bounded diagnostics without exposing theme content in audit logs.
- Theme changes do not grant a new remote capability and do not change device authorization, because the client receives presentation metadata rather than authority. The handshake and projection task still receives a STEP audit because it extends an authenticated network boundary.

## 6. Delivery Plan

### Phase 1: Portable Appearance Foundation

#### Task 1: Define the bounded remote appearance contract and host projection — 8 hours

Deliver a versioned, strictly validated appearance snapshot derived from committed Daintree theme state, including safe normalization and deterministic field-level fallback for imported custom themes. Prove every built-in theme projects successfully, unsafe forms are excluded, accent overrides are represented, output is deterministic, and the projection remains within remote frame bounds. `[TE: BUSINESS_LOGIC] [STEP_AUDIT]`

Binding spec: this document §§3–5.

#### Task 2: Deliver the generated Daintree default and Flutter semantic theme foundation — 10 hours

Give Portal one typed semantic appearance model, defensive wire parser, explicit Material theme mapping, deterministic generated Daintree default, and source-drift guard. Prove valid snapshots map consistently, missing/unknown/malformed values fall back without crashing, and mobile accessibility inputs remain authoritative. `[TE: BUSINESS_LOGIC] [TE: ERROR_HANDLING]`

Binding spec: this document §§4.2–4.4.

#### Task 3: Converge Portal's offline visual language and terminal styling — 10 hours

Apply the semantic theme foundation across entry, discovery, pairing, host management, banners, sheets, responsive panes, and the console so Portal presents the named Daintree identity without a host connection. Remove visual decisions that bypass the semantic contract, preserve existing interaction behavior and accessibility semantics, and prove the terminal uses the generated ANSI palette. `[TE: ERROR_HANDLING]`

Binding spec: this document §§2 and 4.4.

### Phase 2: Authenticated Host Appearance

#### Task 4: Add backward-compatible appearance negotiation to the authenticated handshake — 6 hours

Extend the existing welcome exchange so an authenticated host may provide its current appearance without weakening strict envelope validation or changing the remote protocol version. Prove new/old host-client combinations retain their expected behavior, unauthenticated clients receive no custom appearance, and invalid appearance data cannot break an otherwise valid session. `[TE: BUSINESS_LOGIC] [TE: ERROR_HANDLING] [STEP_AUDIT]`

Binding spec: this document §§4.2, 4.3, and 5.

Depends on Task 1.

#### Task 5: Apply authenticated host appearance within the host context — 7 hours

Apply a valid welcome snapshot to the connected host shell, its dialogs and sheets, system chrome, and terminal while leaving Portal's global entry and pairing experience on the generated Daintree default. Preserve the host appearance through transient reconnects, revert at the defined route and revocation boundaries, avoid theme flashes, and keep high contrast and other device accessibility behavior effective. `[TE: BUSINESS_LOGIC] [TE: ERROR_HANDLING]`

Binding spec: this document §§4.1, 4.4, and 5.

Depends on Tasks 2–4.

### Phase 3: Live Convergence and Acceptance

#### Task 6: Synchronize committed host appearance changes — 6 hours

Publish revisioned appearance updates to ready authenticated sessions when committed desktop theme state changes, including follow-system changes and accent overrides, while excluding renderer-only previews. Apply only newer valid revisions in Portal and retain the last valid appearance across malformed events and reconnect boundaries. `[TE: BUSINESS_LOGIC] [TE: ERROR_HANDLING]`

Binding spec: this document §§4.1–4.3 and 5.

Depends on Tasks 4 and 5.

#### Task 7: Complete cross-theme visual, accessibility, and compatibility acceptance — 10 hours

Demonstrate the integrated feature across the named Daintree and Bondi themes, all built-in projection cases, representative valid and hostile custom themes, terminal rendering, high contrast, reduced motion, text scaling, reconnects, live updates, and backward-compatible host/client combinations. Retain reproducible visual and automated evidence, and verify repository checks relevant to the changed TypeScript, Electron, protocol, Flutter, and generated-code surfaces. `[TE: ERROR_HANDLING]`

Binding spec: this document §§2, 4, 5, and 7.

Depends on Tasks 1–6.

## 7. Project Acceptance Criteria

1. Portal uses a generated representation of the named Daintree theme before connecting, with no independently maintained duplicate palette.
2. An authenticated host can provide a strictly bounded portable appearance snapshot that styles only its Portal host context.
3. All built-in Daintree themes project into valid portable snapshots, and representative imported custom themes either render safely or fall back field-by-field without session failure.
4. Portal's console uses the active appearance's terminal background, foreground, cursor, selection, and ANSI palette while preserving console behavior and accessibility.
5. Committed host theme, follow-system, and accent-override changes reach ready Portal sessions in revision order, while renderer-only previews never propagate.
6. New/old Portal-host combinations remain compatible, transient reconnects do not flash to the offline theme, and leaving or permanently losing a host restores the generated Daintree default.
7. No raw CSS, component extensions, gradients, URLs, image data, renderer state, filesystem data, environment values, commands, credentials, or secrets enter the remote appearance contract.
8. Device high contrast, reduced motion, text scaling, and system chrome requirements remain effective with both default and host-provided appearance.
9. Relevant repository checks, TypeScript and Flutter tests, integration journeys, and visual evidence pass without regressing the accepted Daintree Portal v1 baseline.
10. `[PROJECT_AUDIT]` Pass the SynthOps project audit, including binding-spec adherence, security boundary review, generated-source drift review, compatibility evidence, and scope review.

## 8. Explicitly Out of Scope

- Remote editing, importing, selecting, or administering the desktop host's themes from Portal.
- Synchronizing Portal-selected appearance back to the host.
- Transmitting complete `AppColorScheme` objects, component extension variables, theme imagery, or browser CSS values.
- Reproducing desktop-only layout, hover density, window chrome, drag behavior, or panel-grid mechanics on mobile.
- Adding a Portal theme picker or independent user theme persistence in this project.
- Redesigning Portal navigation, pairing, project selection, agent launch, console semantics, or remote authorization.
- Modifying the binding scope or acceptance criteria of the existing `Daintree Portal` SynthOps project.
