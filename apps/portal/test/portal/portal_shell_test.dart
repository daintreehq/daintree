import 'dart:convert';

import 'package:daintree_portal/console/portal_terminal.dart';
import 'package:daintree_portal/portal/portal_controller.dart';
import 'package:daintree_portal/portal/portal_shell.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:daintree_portal/theme/generated_daintree_appearance.dart';
import 'package:daintree_portal/theme/portal_appearance.dart';
import 'package:daintree_portal/theme/portal_icons.dart';
import 'package:daintree_portal/theme/portal_theme.dart';
import 'package:daintree_portal/transport/remote_protocol_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import '../security/device_identity_store_test.dart';

class WidgetPortalController extends PortalController {
  WidgetPortalController({PortalAppearance? appearance})
    : super(
        credential: PairedHostCredential(
          hostId: 'host-01',
          displayName: 'Studio Mac',
          host: '192.168.1.5',
          port: 45123,
          hostPublicKey: 'host-key',
          hostFingerprint: 'sha256:${List.filled(43, 'h').join()}',
          tlsFingerprint: 'sha256:${List.filled(43, 't').join()}',
          capabilities: const [
            'observe-projects',
            'prompt-agents',
            'launch-agents',
          ],
        ),
        identityStore: DeviceIdentityStore(MemoryProtectedValues()),
        client: RemoteProtocolClient(),
      ) {
    hostAppearance = appearance;
  }

  final project = const PortalProject(
    id: 'project-01',
    name: 'Daintree',
    status: 'active',
    waiting: 1,
    order: 0,
    iconKind: 'emoji',
    iconValue: '🌿',
  );
  final worktree = const PortalWorktree(
    id: 'worktree-01',
    name: 'Portal',
    branch: 'feature/portal',
    availability: 'available',
    isCurrent: true,
    isMain: false,
  );
  final agent = const PortalAgent(
    panelId: 'panel-01',
    generation: 1,
    worktreeId: 'worktree-01',
    agentId: 'codex',
    displayName: 'Codex',
    title: 'Portal implementation',
    state: 'working',
    continuityState: 'live',
    resumeState: 'resumable-by-cli',
    waitingReason: null,
    stateSince: 100,
    spawnedRemotely: true,
  );
  int closeAgentPaneCount = 0;

  @override
  Future<void> connect() async {
    connectionState = PortalConnectionState.ready;
    projects = [project];
    notifyListeners();
  }

  @override
  Future<void> openProject(
    String projectId, {
    bool preserveConsoleTarget = false,
  }) async {
    selectedProject = project;
    worktrees = [worktree];
    agents = [agent];
    notifyListeners();
  }

  @override
  Future<void> openAgent(PortalAgent value, {bool forceResync = false}) async {
    selectedAgent = value;
    selectedWorktree = worktree;
    consoleRenderer.replace('Ready for the next instruction\n');
    consoleStale = false;
    notifyListeners();
  }

  @override
  Future<List<PortalLaunchableAgent>> launchableAgents(
    PortalWorktree worktree,
  ) async => const [];

  @override
  Future<bool> closeAgentPane(PortalAgent agent) async {
    closeAgentPaneCount += 1;
    agents = agents
        .where((candidate) => candidate.panelId != agent.panelId)
        .toList();
    notifyListeners();
    return true;
  }
}

class PendingCloseWidgetPortalController extends WidgetPortalController {
  @override
  bool isClosingAgent(PortalAgent agent) => mutationPending;
}

class EmptyWidgetPortalController extends WidgetPortalController {
  int connectCount = 0;

  @override
  Future<void> connect() async {
    connectCount += 1;
    connectionState = PortalConnectionState.ready;
    projects = const [];
    notifyListeners();
  }
}

class LoadingWidgetPortalController extends WidgetPortalController {
  @override
  Future<void> connect() async {
    connectionState = PortalConnectionState.loading;
    projects = const [];
    notifyListeners();
  }
}

class LoadingProjectWidgetPortalController extends WidgetPortalController {
  int refreshCount = 0;

  @override
  Future<void> connect() async {
    selectedProject = project;
    worktrees = const [];
    connectionState = PortalConnectionState.loading;
    notifyListeners();
  }

  @override
  Future<void> refreshSelectedProject() async {
    refreshCount += 1;
  }
}

class DegradedProjectWidgetPortalController extends WidgetPortalController {
  int refreshCount = 0;

  @override
  Future<void> connect() async {
    selectedProject = project;
    worktrees = const [];
    connectionState = PortalConnectionState.degraded;
    statusMessage =
        'Not enough memory is available to prepare this project. Close an app on the host and retry. · tap Retry to try again';
    notifyListeners();
  }

  @override
  Future<void> refreshSelectedProject() async {
    refreshCount += 1;
  }
}

class RevokedWidgetPortalController extends PortalController {
  RevokedWidgetPortalController()
    : super(
        credential: PairedHostCredential(
          hostId: 'host-01',
          displayName: 'Studio Mac',
          host: '192.168.1.5',
          port: 45123,
          hostPublicKey: 'host-key',
          hostFingerprint: 'sha256:${List.filled(43, 'h').join()}',
          tlsFingerprint: 'sha256:${List.filled(43, 't').join()}',
          capabilities: const ['observe-projects'],
          accessRevoked: true,
        ),
        identityStore: DeviceIdentityStore(MemoryProtectedValues()),
        client: RemoteProtocolClient(),
      );
}

class LaunchableWidgetPortalController extends WidgetPortalController {
  @override
  Future<void> openProject(
    String projectId, {
    bool preserveConsoleTarget = false,
  }) async {
    selectedProject = project;
    worktrees = [worktree];
    agents = const [];
    notifyListeners();
  }

  @override
  Future<List<PortalLaunchableAgent>> launchableAgents(
    PortalWorktree worktree,
  ) async => const [
    PortalLaunchableAgent(
      agentId: 'codex',
      displayName: 'Codex',
      iconId: 'codex',
      brandColor: '#10A37F',
    ),
  ];
}

class FailedLaunchableWidgetPortalController
    extends LaunchableWidgetPortalController {
  @override
  Future<List<PortalLaunchableAgent>> launchableAgents(
    PortalWorktree worktree,
  ) async => throw const RemoteProtocolException(
    'HOST_UI_UNAVAILABLE',
    'Project renderer is unavailable',
    retryable: true,
  );
}

void main() {
  testWidgets(
    'authenticated appearance is scoped to shell, system chrome, overlays, and terminal',
    (tester) async {
      final appearance = _hostAppearance(
        themeId: 'studio-host',
        canvas: '#123456ff',
        terminalBackground: '#07111fff',
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: buildPortalTheme(generatedDaintreeAppearance),
          home: Column(
            children: [
              const _OfflineThemeProbe(),
              Expanded(
                child: PortalShell(
                  controller: WidgetPortalController(appearance: appearance),
                ),
              ),
            ],
          ),
        ),
      );
      await tester.pump();

      final scaffoldContext = tester.element(find.byType(Scaffold));
      final hostTheme = Theme.of(scaffoldContext);
      expect(hostTheme.colorScheme.surface, appearance.surfaces.canvas);
      expect(
        hostTheme.dialogTheme.backgroundColor,
        appearance.surfaces.elevatedPanel,
      );
      expect(
        hostTheme.bottomSheetTheme.backgroundColor,
        appearance.surfaces.elevatedPanel,
      );
      expect(
        buildPortalTerminalTheme(
          scaffoldContext,
          highContrast: false,
        ).background,
        appearance.terminal.background,
      );
      final overlays = tester
          .widgetList<AnnotatedRegion<SystemUiOverlayStyle>>(
            find.byType(AnnotatedRegion<SystemUiOverlayStyle>),
          )
          .map((region) => region.value);
      expect(
        overlays,
        contains(
          isA<SystemUiOverlayStyle>()
              .having(
                (style) => style.statusBarColor,
                'status bar color',
                appearance.surfaces.toolbar,
              )
              .having(
                (style) => style.systemNavigationBarColor,
                'navigation bar color',
                appearance.surfaces.canvas,
              ),
        ),
      );
      expect(
        tester
            .widget<ColoredBox>(
              find.byKey(const ValueKey('offline-theme-probe')),
            )
            .color,
        generatedDaintreeAppearance.surfaces.canvas,
      );
    },
  );

  testWidgets(
    'replacing the host context applies only the replacement appearance',
    (tester) async {
      final first = _hostAppearance(themeId: 'first', canvas: '#123456ff');
      final second = _hostAppearance(themeId: 'second', canvas: '#654321ff');

      await tester.pumpWidget(
        MaterialApp(
          home: PortalShell(
            controller: WidgetPortalController(appearance: first),
          ),
        ),
      );
      await tester.pump();
      expect(
        Theme.of(tester.element(find.byType(Scaffold))).colorScheme.surface,
        first.surfaces.canvas,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: PortalShell(
            controller: WidgetPortalController(appearance: second),
          ),
        ),
      );
      await tester.pump();
      expect(
        Theme.of(tester.element(find.byType(Scaffold))).colorScheme.surface,
        second.surfaces.canvas,
      );
    },
  );

  testWidgets(
    'popping a host route reveals the generated system chrome owner',
    (tester) async {
      final host = _hostAppearance(themeId: 'host', canvas: '#654321ff');
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => PortalSystemChrome(
            appearance: generatedDaintreeAppearance,
            child: child!,
          ),
          home: Builder(
            builder: (context) => FilledButton(
              onPressed: () => Navigator.push<void>(
                context,
                MaterialPageRoute(
                  builder: (_) => PortalShell(
                    controller: WidgetPortalController(appearance: host),
                  ),
                ),
              ),
              child: const Text('Open host'),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Open host'));
      await tester.pumpAndSettle();
      expect(_overlayColors(tester), contains(host.surfaces.canvas));

      Navigator.of(tester.element(find.byType(PortalShell))).pop();
      await tester.pumpAndSettle();
      expect(find.byType(PortalShell), findsNothing);
      expect(
        _overlayColors(tester),
        contains(generatedDaintreeAppearance.surfaces.canvas),
      );
      expect(_overlayColors(tester), isNot(contains(host.surfaces.canvas)));
    },
  );

  testWidgets(
    'host theme preserves device high contrast and accessibility data',
    (tester) async {
      final appearance = _hostAppearance(
        themeId: 'contrast',
        canvas: '#123456ff',
      );
      const media = MediaQueryData(
        highContrast: true,
        disableAnimations: true,
        textScaler: TextScaler.linear(1.6),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: media,
            child: PortalShell(
              controller: WidgetPortalController(appearance: appearance),
            ),
          ),
        ),
      );
      await tester.pump();

      final context = tester.element(find.byType(Scaffold));
      expect(Theme.of(context).colorScheme.outline, appearance.borders.strong);
      expect(MediaQuery.of(context).disableAnimations, isTrue);
      expect(MediaQuery.of(context).textScaler.scale(10), 16);
    },
  );

  testWidgets(
    'authenticated host status and console match their semantic palette',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final appearance = _hostAppearance(
        themeId: 'studio-host',
        canvas: '#111827ff',
        terminalBackground: '#07111fff',
      );

      await tester.pumpWidget(
        MaterialApp(
          home: PortalShell(
            controller: WidgetPortalController(appearance: appearance),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.text('Daintree'));
      await tester.pump();
      await tester.tap(find.text('Portal implementation'));
      await tester.pump();
      final controller = tester
          .widget<PortalShell>(find.byType(PortalShell))
          .controller;
      controller.connectionState = PortalConnectionState.degraded;
      controller.statusMessage =
          'Showing the host’s last successful project state';
      controller.notifyListeners();
      await tester.pump();

      expect(
        tester
            .widget<ColoredBox>(
              find
                  .ancestor(
                    of: find.byKey(const ValueKey('portal-terminal-surface')),
                    matching: find.byType(ColoredBox),
                  )
                  .first,
            )
            .color,
        appearance.terminal.background,
      );
      expect(
        tester.widget<Icon>(find.byIcon(PortalIcons.warning).first).color,
        appearance.activity.waiting.foreground,
      );
      final banner = tester.widget<Material>(
        find
            .ancestor(
              of: find.text('Showing the host’s last successful project state'),
              matching: find.byType(Material),
            )
            .first,
      );
      expect(banner.color, appearance.status.warning.surface);
      expect(
        tester.widget<Icon>(find.byIcon(Icons.info_outline_rounded)).color,
        appearance.status.warning.foreground,
      );
      expect(
        tester.widget<Icon>(find.byIcon(PortalIcons.terminal).last).color,
        appearance.activity.working.foreground,
      );

      await expectLater(
        find.byType(PortalShell),
        matchesGoldenFile('goldens/authenticated_host_context.png'),
      );
    },
  );

  testWidgets(
    'Bondi host appearance renders the complete connected experience',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = WidgetPortalController(
        appearance: generatedBondiAppearance,
      );
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agent);

      await tester.pumpWidget(
        MaterialApp(home: PortalShell(controller: controller)),
      );
      await tester.pump();

      expect(
        Theme.of(tester.element(find.byType(Scaffold))).colorScheme.surface,
        generatedBondiAppearance.surfaces.canvas,
      );
      expect(
        tester
            .widget<ColoredBox>(
              find
                  .ancestor(
                    of: find.byKey(const ValueKey('portal-terminal-surface')),
                    matching: find.byType(ColoredBox),
                  )
                  .first,
            )
            .color,
        generatedBondiAppearance.terminal.background,
      );
      await expectLater(
        find.byType(PortalShell),
        matchesGoldenFile('goldens/bondi_host_context.png'),
      );
    },
  );

  testWidgets('revoked host offers fresh pairing instead of generic retry', (
    tester,
  ) async {
    var pairAgainCalls = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: PortalShell(
          controller: RevokedWidgetPortalController(),
          onPairAgain: () => pairAgainCalls += 1,
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Pair Studio Mac again'), findsOneWidget);
    expect(find.text('Check again'), findsNothing);
    await tester.tap(find.widgetWithText(FilledButton, 'Pair again'));
    expect(pairAgainCalls, 1);
  });

  testWidgets('project loading uses one host-specific status surface', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(
      MaterialApp(
        home: PortalShell(controller: LoadingWidgetPortalController()),
      ),
    );
    await tester.pump();

    expect(find.text('Checking Studio Mac for projects'), findsOneWidget);
    expect(find.textContaining('Desktop project state'), findsOneWidget);
    expect(find.text('Loading from host…'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsWidgets);
  });

  testWidgets('project detail loading animates and offers bounded retry', (
    tester,
  ) async {
    final controller = LoadingProjectWidgetPortalController();
    await tester.pumpWidget(
      MaterialApp(home: PortalShell(controller: controller)),
    );
    await tester.pump();

    expect(find.text('Preparing Daintree'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsWidgets);
    expect(find.widgetWithText(OutlinedButton, 'Retry'), findsNothing);

    await tester.pump(const Duration(seconds: 5));
    expect(find.textContaining('taking longer than expected'), findsOneWidget);
    await tester.tap(find.widgetWithText(OutlinedButton, 'Retry'));
    expect(controller.refreshCount, 1);
  });

  testWidgets('degraded project details expose the promised retry action', (
    tester,
  ) async {
    final controller = DegradedProjectWidgetPortalController();
    await tester.pumpWidget(
      MaterialApp(home: PortalShell(controller: controller)),
    );
    await tester.pump();

    expect(find.text('Degraded'), findsOneWidget);
    expect(find.textContaining('Not enough memory'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Retry'));
    expect(controller.refreshCount, 1);
  });

  testWidgets(
    'empty project chooser explains the completed state and offers recovery',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = EmptyWidgetPortalController();

      await tester.pumpWidget(
        MaterialApp(home: PortalShell(controller: controller)),
      );
      await tester.pump();

      expect(find.text('Open a project on Studio Mac'), findsOneWidget);
      expect(find.textContaining('no open projects'), findsOneWidget);
      expect(find.textContaining('appear here automatically'), findsOneWidget);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Check again'));
      await tester.pump();
      expect(controller.connectCount, 2);
    },
  );

  testWidgets('empty worktree launch action opens the configured agent flow', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final appearance = _hostAppearance(
      themeId: 'sheet-host',
      canvas: '#123456ff',
    );
    final controller = LaunchableWidgetPortalController()
      ..hostAppearance = appearance;

    await tester.pumpWidget(
      MaterialApp(home: PortalShell(controller: controller)),
    );
    await tester.pump();
    await tester.tap(find.text('Daintree'));
    await tester.pump();

    expect(find.text('Start work in this worktree'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Launch an agent'));
    await tester.pumpAndSettle();

    expect(find.text('Launch agent'), findsOneWidget);
    expect(find.text('Codex'), findsOneWidget);
    final sheetMaterial = tester.widget<Material>(
      find
          .ancestor(
            of: find.text('Launch agent'),
            matching: find.byType(Material),
          )
          .first,
    );
    expect(sheetMaterial.color, appearance.surfaces.elevatedPanel);
    expect(
      find.text('Uses the same defaults as the Daintree agent toolbar'),
      findsOneWidget,
    );
  });

  testWidgets('launch catalog failure offers a visible retry action', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = FailedLaunchableWidgetPortalController();

    await tester.pumpWidget(
      MaterialApp(home: PortalShell(controller: controller)),
    );
    await tester.pump();
    await tester.tap(find.text('Daintree'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Launch an agent'));
    await tester.pump();

    expect(find.text('Project renderer is unavailable'), findsOneWidget);
    expect(find.widgetWithText(SnackBarAction, 'Retry'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'tablet layout exposes the full hierarchy as three touch-friendly panes',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = WidgetPortalController();

      await tester.pumpWidget(
        MaterialApp(home: PortalShell(controller: controller)),
      );
      await tester.pump();

      expect(find.text('PROJECTS'), findsOneWidget);
      expect(find.text('WORKTREES / AGENTS'), findsOneWidget);
      expect(find.text('LIVE CONSOLE'), findsOneWidget);
      expect(
        tester.getSize(find.widgetWithText(ListTile, 'Daintree')).height,
        greaterThanOrEqualTo(60),
      );
      expect(find.text('🌿'), findsOneWidget);
      await tester.enterText(
        find.widgetWithText(TextField, 'Search projects'),
        'missing',
      );
      await tester.pump();
      expect(find.text('Try a different project name'), findsOneWidget);
    },
  );

  testWidgets(
    'phone layout preserves the selected target while drilling into the console',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = WidgetPortalController();
      await tester.pumpWidget(
        MaterialApp(home: PortalShell(controller: controller)),
      );
      await tester.pump();

      expect(find.text('Choose a project'), findsOneWidget);
      await tester.tap(find.text('Daintree'));
      await tester.pump();
      expect(find.text('Portal'), findsOneWidget);
      await tester.tap(find.text('Portal implementation'));
      await tester.pump();

      expect(
        find.bySemanticsLabel(
          'Read-only console output for Portal implementation',
        ),
        findsOneWidget,
      );
      expect(
        tester
            .getSemantics(
              find.bySemanticsLabel(
                'Read-only console output for Portal implementation',
              ),
            )
            .value,
        contains('Ready for the next instruction'),
      );
      expect(controller.selectedAgent?.panelId, 'panel-01');
    },
  );

  testWidgets('agent actions require confirmation before closing a pane', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final appearance = _hostAppearance(
      themeId: 'dialog-host',
      canvas: '#123456ff',
    );
    final controller = WidgetPortalController(appearance: appearance);
    await tester.pumpWidget(
      MaterialApp(home: PortalShell(controller: controller)),
    );
    await tester.pump();
    await tester.tap(find.text('Daintree'));
    await tester.pump();

    await tester.tap(find.byTooltip('Agent actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Close pane'));
    await tester.pumpAndSettle();

    expect(find.text("Close 'Portal implementation'?"), findsOneWidget);
    final dialogMaterial = tester.widget<Material>(
      find
          .ancestor(
            of: find.text("Close 'Portal implementation'?"),
            matching: find.byType(Material),
          )
          .first,
    );
    expect(dialogMaterial.color, appearance.surfaces.elevatedPanel);
    expect(controller.closeAgentPaneCount, 0);
    await tester.tap(find.widgetWithText(FilledButton, 'Close pane'));
    await tester.pumpAndSettle();

    expect(controller.closeAgentPaneCount, 1);
  });

  testWidgets('closing a pane replaces its action menu with progress', (
    tester,
  ) async {
    final controller = PendingCloseWidgetPortalController();
    await controller.connect();
    await controller.openProject('project-01');
    controller.mutationPending = true;
    controller.notifyListeners();
    await tester.pumpWidget(
      MaterialApp(home: PortalShell(controller: controller)),
    );
    await tester.pump();

    expect(find.byTooltip('Agent actions'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('stable tablet hierarchy matches its visual baseline', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final controller = WidgetPortalController();
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(
          useMaterial3: true,
          colorSchemeSeed: const Color(0xFF315C45),
        ),
        home: PortalShell(controller: controller),
      ),
    );
    await tester.pump();

    await expectLater(
      find.byType(PortalShell),
      matchesGoldenFile('goldens/portal_tablet.png'),
    );
  });

  testWidgets(
    'large text, high contrast, and reduced motion retain an operable console',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(700, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final controller = WidgetPortalController();
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agent);
      controller.mutationPending = true;
      controller.composerText = 'Pending prompt';

      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: const TextScaler.linear(2),
              highContrast: true,
              disableAnimations: true,
            ),
            child: child!,
          ),
          home: PortalShell(controller: controller),
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.byIcon(Icons.hourglass_top_rounded), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(
        find.bySemanticsLabel(
          'Read-only console output for Portal implementation',
        ),
        findsOneWidget,
      );
    },
  );
}

class _OfflineThemeProbe extends StatelessWidget {
  const _OfflineThemeProbe();

  @override
  Widget build(BuildContext context) => ColoredBox(
    key: const ValueKey('offline-theme-probe'),
    color: Theme.of(context).colorScheme.surface,
    child: const SizedBox(height: 1),
  );
}

PortalAppearance _hostAppearance({
  required String themeId,
  required String canvas,
  String? terminalBackground,
}) {
  final json =
      jsonDecode(jsonEncode(generatedDaintreeAppearanceJson))
          as Map<String, dynamic>;
  json['revision'] = 4;
  json['themeId'] = themeId;
  (json['surfaces']! as Map<String, dynamic>)['canvas'] = canvas;
  final status = json['status']! as Map<String, dynamic>;
  (status['warning']! as Map<String, dynamic>)
    ..['foreground'] = '#ff44aaff'
    ..['surface'] = '#552244ff';
  final activity = json['activity']! as Map<String, dynamic>;
  (activity['waiting']! as Map<String, dynamic>)['foreground'] = '#ffd500ff';
  (activity['working']! as Map<String, dynamic>)['foreground'] = '#00e5ffff';
  if (terminalBackground != null) {
    (json['terminal']! as Map<String, dynamic>)['background'] =
        terminalBackground;
  }
  return PortalAppearance.parse(json);
}

Iterable<Color?> _overlayColors(WidgetTester tester) => tester
    .widgetList<AnnotatedRegion<SystemUiOverlayStyle>>(
      find.byType(AnnotatedRegion<SystemUiOverlayStyle>),
    )
    .map((region) => region.value.systemNavigationBarColor);
