import 'package:daintree_portal/portal/portal_controller.dart';
import 'package:daintree_portal/portal/portal_shell.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:daintree_portal/transport/remote_protocol_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import '../security/device_identity_store_test.dart';

class WidgetPortalController extends PortalController {
  WidgetPortalController()
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
      );

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
    final controller = LaunchableWidgetPortalController();

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
    final controller = WidgetPortalController();
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
