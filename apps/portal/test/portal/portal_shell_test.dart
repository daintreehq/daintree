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
  Future<List<Map<String, dynamic>>> launchableAgents(
    PortalWorktree worktree,
  ) async => const [];
}

void main() {
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
