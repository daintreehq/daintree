import 'dart:async';
import 'dart:convert';

import 'package:daintree_portal/portal/portal_controller.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:daintree_portal/transport/remote_protocol_client.dart';
import 'package:flutter_test/flutter_test.dart';
import '../security/device_identity_store_test.dart';

class FakePortalClient extends RemoteProtocolClient {
  final queued = <String, List<Object>>{};
  final deferred = <String, Completer<Map<String, dynamic>>>{};
  final beforeResponse = <String, void Function()>{};
  final calls = <String>[];
  final payloads = <Map<String, Object?>>[];
  final eventController = StreamController<Map<String, dynamic>>.broadcast(
    sync: true,
  );
  bool isConnected = false;

  @override
  Stream<Map<String, dynamic>> get events => eventController.stream;

  @override
  bool get connected => isConnected;

  @override
  String get sessionId => 'session-new';

  @override
  Future<void> open(Uri endpoint, String tlsFingerprint) async =>
      isConnected = true;

  @override
  Future<List<String>> authenticate({
    required DeviceIdentity identity,
    required String hostPublicKey,
    required String hostFingerprint,
    String? resumeSessionId,
  }) async => const ['observe-projects', 'prompt-agents', 'launch-agents'];

  @override
  Future<Map<String, dynamic>> request(
    String type,
    Map<String, Object?> payload, {
    Duration timeout = const Duration(seconds: 12),
  }) async {
    calls.add(type);
    payloads.add(payload);
    final pending = deferred.remove(type);
    if (pending != null) return pending.future;
    final responses = queued[type];
    if (responses == null || responses.isEmpty) {
      throw StateError('No response for $type');
    }
    beforeResponse.remove(type)?.call();
    final response = responses.removeAt(0);
    if (response is Map<String, dynamic>) return response;
    throw response;
  }

  @override
  void acknowledge(String streamId, int sequence) =>
      calls.add('ack:$streamId:$sequence');

  @override
  Future<void> close() async => isConnected = false;
}

void main() {
  test(
    'projects, worktrees, agents, and continuity state remain host-derived',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(
        client,
        degraded: true,
        continuity: 'restored-screen',
      );
      final controller = _controller(client);

      await controller.connect();
      expect(controller.connectionState, PortalConnectionState.degraded);
      expect(controller.projects.single.name, 'Daintree');
      await controller.openProject('project-01');

      expect(controller.worktrees.single.branch, 'feature/portal');
      expect(controller.agents.single.continuityState, 'restored-screen');
      expect(controller.agents.single.acceptsPrompts, isFalse);
      expect(controller.statusMessage, contains('last successful'));
    },
  );

  test(
    'unknown prompt status is reconciled and composer clears only after commit',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [_snapshot()];
      client.queued['prompt.submit'] = [
        _response('prompt.result', {
          'idempotencyKey': 'key',
          'disposition': 'unknown',
          'resultCode': 'commit-in-progress',
        }),
      ];
      client.queued['request.status'] = [
        _response('request.status', {
          'idempotencyKey': 'key',
          'disposition': 'committed',
          'resultCode': 'queued',
        }),
      ];
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agents.single);
      controller.updateComposer('Inspect the failing test');

      expect(await controller.submitPrompt(), isTrue);
      expect(controller.composerText, isEmpty);
      expect(
        client.calls,
        containsAllInOrder(['prompt.submit', 'request.status']),
      );
    },
  );

  test(
    'rejected prompt stays editable and disconnect makes the console stale and read-only',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [_snapshot()];
      client.queued['prompt.submit'] = [
        _response('prompt.result', {
          'idempotencyKey': 'key',
          'disposition': 'rejected',
          'resultCode': 'not-live',
        }),
      ];
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agents.single);
      controller.updateComposer('Keep this text');

      expect(await controller.submitPrompt(), isFalse);
      expect(controller.composerText, 'Keep this text');
      client.eventController.add({
        'kind': 'local',
        'type': 'session.disconnected',
      });
      await Future<void>.delayed(Duration.zero);
      expect(controller.consoleStale, isTrue);
      expect(controller.readOnly, isTrue);
      expect(controller.selectedAgent?.panelId, 'panel-01');
    },
  );

  test('revoked socket close remains explicit and read-only', () async {
    final client = FakePortalClient();
    _queueInitialJourney(client);
    client.queued['console.subscribe'] = [_snapshot()];
    final controller = _controller(client);
    await controller.connect();
    await controller.openProject('project-01');
    await controller.openAgent(controller.agents.single);

    client.eventController.add({
      'kind': 'local',
      'type': 'session.disconnected',
      'error': const RemoteProtocolException(
        'DEVICE_REVOKED',
        'This device was revoked on the host',
      ),
    });
    await Future<void>.delayed(Duration.zero);

    expect(controller.connectionState, PortalConnectionState.revoked);
    expect(controller.readOnly, isTrue);
    expect(controller.statusMessage, contains('pair it again'));
  });

  test(
    'unknown launch is reconciled without dispatching a second launch',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['agent.launch'] = [
        _response('agent.launchResult', {
          'idempotencyKey': 'launch-key',
          'requestedPanelId': 'panel-requested',
          'disposition': 'unknown',
          'resultCode': 'commit-in-progress',
        }),
      ];
      client.queued['request.status'] = [
        _response('request.status', {
          'idempotencyKey': 'launch-key',
          'disposition': 'committed',
          'createdResourceId': 'panel-created',
          'resultCode': 'created',
        }),
      ];
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');

      final result = await controller.launchAgent(
        worktree: controller.worktrees.single,
        agentId: 'codex',
        modelId: 'gpt-5',
        name: 'Portal verification',
      );

      expect(result['disposition'], 'committed');
      expect(
        client.calls.where((call) => call == 'agent.launch'),
        hasLength(1),
      );
      final launchPayload =
          client.payloads[client.calls.indexOf('agent.launch')];
      final statusPayload =
          client.payloads[client.calls.indexOf('request.status')];
      expect(statusPayload['idempotencyKey'], launchPayload['idempotencyKey']);
    },
  );

  test(
    'toolbar-equivalent launch omits stale overrides and opens its console',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['agent.launch'] = [
        _response('agent.launchResult', {
          'idempotencyKey': 'launch-key',
          'requestedPanelId': 'panel-created',
          'panelId': 'panel-created',
          'launchGeneration': 3,
          'projectId': 'project-01',
          'worktreeId': 'worktree-01',
          'agentId': 'codex',
          'placement': 'grid',
          'spawnStatus': 'starting',
          'disposition': 'created',
        }),
      ];
      client.queued['console.subscribe'] = [
        _snapshot(data: ''),
        _snapshot(streamId: 'stream-02', data: 'Codex startup screen\n'),
      ];
      client.queued['console.unsubscribe'] = [
        _response('console.unsubscribe', const {}),
      ];
      final controller = _controller(
        client,
        launchConsoleRecoveryDelay: const Duration(milliseconds: 1),
      );
      await controller.connect();
      await controller.openProject('project-01');

      final result = await controller.launchAgentAndOpen(
        worktree: controller.worktrees.single,
        agent: const PortalLaunchableAgent(
          agentId: 'codex',
          displayName: 'Codex',
          iconId: 'codex',
          brandColor: '#10A37F',
        ),
      );

      expect(result['disposition'], 'created');
      expect(controller.selectedAgent?.panelId, 'panel-created');
      expect(controller.consoleStale, isFalse);
      expect(
        client.calls,
        containsAllInOrder(['agent.launch', 'console.subscribe']),
      );
      final launchPayload =
          client.payloads[client.calls.indexOf('agent.launch')];
      expect(launchPayload, isNot(contains('modelId')));
      expect(launchPayload, isNot(contains('presetId')));
      expect(launchPayload, isNot(contains('name')));
      expect(launchPayload, isNot(contains('prompt')));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(
        client.calls,
        containsAllInOrder([
          'console.subscribe',
          'console.unsubscribe',
          'console.subscribe',
        ]),
      );
      expect(
        controller.consoleRenderer.normalizedText,
        contains('Codex startup screen'),
      );
    },
  );

  test('new launch waits for its host projection before opening', () async {
    final client = FakePortalClient();
    _queueInitialJourney(client);
    client.queued['agent.launch'] = [
      _response('agent.launchResult', {
        'idempotencyKey': 'launch-key',
        'requestedPanelId': 'panel-created',
        'panelId': 'panel-created',
        'launchGeneration': 3,
        'projectId': 'project-01',
        'worktreeId': 'worktree-01',
        'agentId': 'codex',
        'placement': 'grid',
        'spawnStatus': 'starting',
        'disposition': 'created',
      }),
    ];
    client.queued['console.subscribe'] = [
      const RemoteProtocolException('NOT_FOUND', 'Agent target was not found'),
      _snapshot(data: 'Codex is ready\n'),
    ];
    final controller = _controller(
      client,
      launchTargetRetryDelay: Duration.zero,
      launchTargetRetryAttempts: 2,
    );
    await controller.connect();
    await controller.openProject('project-01');

    await controller.launchAgentAndOpen(
      worktree: controller.worktrees.single,
      agent: const PortalLaunchableAgent(
        agentId: 'codex',
        displayName: 'Codex',
        iconId: 'codex',
        brandColor: '#10A37F',
      ),
    );

    expect(
      client.calls.where((call) => call == 'console.subscribe'),
      hasLength(2),
    );
    expect(
      controller.consoleRenderer.normalizedText,
      contains('Codex is ready'),
    );
  });

  test(
    'ordered console output is acknowledged and a gap requests explicit resync',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [_snapshot()];
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agents.single);
      expect(controller.consoleRenderer.terminal.viewWidth, 80);
      expect(controller.consoleRenderer.terminal.viewHeight, 24);
      var broadUpdates = 0;
      var consoleUpdates = 0;
      controller.addListener(() => broadUpdates += 1);
      controller.consoleRenderer.addListener(() => consoleUpdates += 1);

      client.eventController.add(_consoleOutput(sequence: 1, data: 'next'));
      await Future<void>.delayed(Duration.zero);
      expect(controller.consoleRenderer.normalizedText, contains('next'));
      expect(consoleUpdates, greaterThan(0));
      expect(broadUpdates, 0);
      expect(client.calls, contains('ack:stream-01:1'));

      final resync = Completer<Map<String, dynamic>>();
      client.queued['console.unsubscribe'] = [
        _response('console.unsubscribe', const {}),
      ];
      client.deferred['console.subscribe'] = resync;
      for (var sequence = 3; sequence <= 150; sequence += 1) {
        client.eventController.add(
          _consoleOutput(sequence: sequence, data: 'gap-$sequence'),
        );
      }
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      expect(
        client.calls.where((call) => call == 'console.subscribe'),
        hasLength(2),
      );
      resync.complete(_snapshot(streamId: 'stream-02'));
      await Future<void>.delayed(Duration.zero);
      expect(controller.selectedAgent?.panelId, 'panel-01');
    },
  );

  test(
    'first console output is retained when it arrives at the subscription boundary',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [_snapshot()];
      client.beforeResponse['console.subscribe'] = () {
        client.eventController.add(
          _consoleOutput(sequence: 1, data: 'Codex is ready'),
        );
      };
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');

      await controller.openAgent(controller.agents.single);

      expect(
        controller.consoleRenderer.normalizedText,
        contains('Codex is ready'),
      );
      expect(controller.consoleSequence, 1);
      expect(client.calls, contains('ack:stream-01:1'));
    },
  );

  test(
    'repeated resync events cannot create a console subscription storm',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [
        _snapshot(),
        _snapshot(mode: 'snapshot', throughSeq: 0),
      ];
      client.queued['console.unsubscribe'] = [
        _response('console.unsubscribe', const {}),
      ];
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agents.single);
      final event = {
        'protocolVersion': 1,
        'sessionId': 'session-new',
        'kind': 'event',
        'type': 'console.resyncRequired',
        'payload': {'streamId': 'stream-01', 'reason': 'gap'},
      };

      client.eventController.add(event);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      client.eventController.add(event);
      await Future<void>.delayed(Duration.zero);

      expect(
        client.calls.where((call) => call == 'console.subscribe'),
        hasLength(2),
      );
      expect(
        client.calls,
        containsAllInOrder([
          'console.subscribe',
          'console.unsubscribe',
          'console.subscribe',
        ]),
      );
      expect(controller.connectionState, PortalConnectionState.ready);
      expect(controller.consoleStale, isTrue);
      expect(controller.statusMessage, contains('Retry'));
    },
  );

  test(
    'gap recovery isolates the replacement stream from late output',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [_snapshot(data: 'stable screen')];
      client.queued['console.unsubscribe'] = [
        _response('console.unsubscribe', const {}),
      ];
      final replacement = Completer<Map<String, dynamic>>();
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agents.single);
      client.deferred['console.subscribe'] = replacement;

      client.eventController.add(_consoleOutput(sequence: 2, data: 'gap'));
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      client.eventController.add(
        _consoleOutput(sequence: 3, data: 'old stream'),
      );
      replacement.complete(
        _snapshot(
          streamId: 'stream-02',
          throughSeq: 3,
          data: 'recovered screen',
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(controller.streamId, 'stream-02');
      expect(controller.consoleSequence, 3);
      expect(controller.consoleStale, isFalse);
      expect(
        controller.consoleRenderer.normalizedText,
        contains('recovered screen'),
      );
    },
  );

  test('unsatisfied resync retains the last received console', () async {
    final client = FakePortalClient();
    _queueInitialJourney(client);
    client.queued['console.subscribe'] = [
      _snapshot(data: 'last good screen'),
      _snapshot(mode: 'resync', streamId: 'stream-02', throughSeq: 4),
    ];
    client.queued['console.unsubscribe'] = [
      _response('console.unsubscribe', const {}),
    ];
    final controller = _controller(client);
    await controller.connect();
    await controller.openProject('project-01');
    await controller.openAgent(controller.agents.single);

    client.eventController.add(_consoleOutput(sequence: 2, data: 'gap'));
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(controller.consoleStale, isTrue);
    expect(controller.statusMessage, contains('Retry'));
    expect(
      controller.consoleRenderer.normalizedText,
      contains('last good screen'),
    );
  });

  test(
    'foreground reconnect resumes the exact panel generation and target',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [
        _snapshot(),
        _snapshot(mode: 'resume'),
      ];
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agents.single);

      await controller.pause();
      expect(controller.selectedAgent?.panelId, 'panel-01');
      expect(controller.consoleStale, isTrue);
      await controller.resume();

      expect(controller.selectedProject?.id, 'project-01');
      expect(controller.selectedAgent?.panelId, 'panel-01');
      expect(controller.selectedAgent?.generation, 1);
      expect(controller.consoleStale, isFalse);
      expect(
        client.calls.where((call) => call == 'console.subscribe'),
        hasLength(2),
      );
    },
  );

  test(
    'console decoding preserves Unicode and ANSI split across envelopes',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [_snapshot()];
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agents.single);
      final split = utf8.encode('👩🏽‍💻 \x1b[31mred\x1b[0m');

      client.eventController.add(
        _consoleOutputBytes(sequence: 1, bytes: split.sublist(0, 2)),
      );
      client.eventController.add(
        _consoleOutputBytes(sequence: 2, bytes: split.sublist(2, 11)),
      );
      client.eventController.add(
        _consoleOutputBytes(sequence: 3, bytes: split.sublist(11)),
      );
      await Future<void>.delayed(Duration.zero);

      expect(
        controller.consoleRenderer.normalizedText,
        contains('👩🏽‍💻 red'),
      );
      expect(controller.consoleRenderer.normalizedText, isNot(contains('�')));
      expect(
        client.calls,
        containsAll(['ack:stream-01:1', 'ack:stream-01:2', 'ack:stream-01:3']),
      );
    },
  );

  test(
    'host projection invalidation refreshes metadata without dropping the console target',
    () async {
      final client = FakePortalClient();
      _queueInitialJourney(client);
      _queueInitialJourney(client);
      client.queued['console.subscribe'] = [_snapshot()];
      final controller = _controller(client);
      await controller.connect();
      await controller.openProject('project-01');
      await controller.openAgent(controller.agents.single);

      client.eventController.add({
        'protocolVersion': 1,
        'sessionId': 'session-new',
        'kind': 'event',
        'type': 'project.updated',
        'revision': 3,
        'payload': {
          'projectId': 'project-01',
          'baseRevision': 2,
          'revision': 3,
        },
      });
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      expect(controller.selectedAgent?.panelId, 'panel-01');
      expect(
        client.calls.where((call) => call == 'project.open'),
        hasLength(2),
      );
      expect(
        client.calls.where((call) => call == 'console.subscribe'),
        hasLength(1),
      );
    },
  );
}

PortalController _controller(
  FakePortalClient client, {
  Duration launchConsoleRecoveryDelay = const Duration(seconds: 2),
  Duration launchTargetRetryDelay = const Duration(milliseconds: 250),
  int launchTargetRetryAttempts = 8,
}) {
  final values = MemoryProtectedValues();
  return PortalController(
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
    identityStore: DeviceIdentityStore(values),
    client: client,
    launchConsoleRecoveryDelay: launchConsoleRecoveryDelay,
    launchTargetRetryDelay: launchTargetRetryDelay,
    launchTargetRetryAttempts: launchTargetRetryAttempts,
  );
}

void _queueInitialJourney(
  FakePortalClient client, {
  bool degraded = false,
  String continuity = 'live',
}) {
  (client.queued['projects.list'] ??= []).add(
    _response('projects.list', {
      'projects': [
        {
          'id': 'project-01',
          'name': 'Daintree',
          'status': 'active',
          'attention': {'waiting': 1, 'working': 1, 'completed': 0},
          'order': 0,
        },
      ],
      'revision': 1,
      'degraded': degraded,
      'lastSuccessfulAt': 100,
    }),
  );
  (client.queued['project.open'] ??= []).add(
    _response('project.snapshot', {
      'project': {
        'id': 'project-01',
        'name': 'Daintree',
        'status': 'active',
        'attention': {'waiting': 1, 'working': 1, 'completed': 0},
        'order': 0,
      },
      'worktrees': [
        {
          'id': 'worktree-01',
          'name': 'Portal',
          'branch': 'feature/portal',
          'isMain': false,
          'isCurrent': true,
          'availability': 'available',
        },
      ],
      'agents': [
        {
          'panelId': 'panel-01',
          'launchGeneration': 1,
          'projectId': 'project-01',
          'worktreeId': 'worktree-01',
          'agentId': 'codex',
          'displayName': 'Codex',
          'title': 'Portal task',
          'state': continuity == 'live' ? 'working' : 'restored',
          'connectionState': continuity == 'live' ? 'live' : 'restored',
          'continuityState': continuity,
          'resumeState': 'resumable-by-cli',
          'spawnedRemotely': true,
          'resumable': true,
        },
      ],
      'revision': 2,
      'projectionState': 'available',
      'degraded': degraded,
      'lastSuccessfulAt': 100,
    }),
  );
}

Map<String, dynamic> _snapshot({
  String mode = 'snapshot',
  int throughSeq = 0,
  String streamId = 'stream-01',
  String data = 'screen\n',
}) => _response('console.snapshot', {
  'projectId': 'project-01',
  'worktreeId': 'worktree-01',
  'panelId': 'panel-01',
  'launchGeneration': 1,
  'streamId': streamId,
  'mode': mode,
  'throughSeq': throughSeq,
  'snapshot': mode == 'snapshot'
      ? {'data': data, 'cols': 80, 'rows': 24}
      : null,
  'chunks': <Object>[],
});

Map<String, dynamic> _consoleOutput({
  required int sequence,
  required String data,
}) => _consoleOutputBytes(sequence: sequence, bytes: utf8.encode(data));

Map<String, dynamic> _consoleOutputBytes({
  required int sequence,
  required List<int> bytes,
}) => {
  'protocolVersion': 1,
  'sessionId': 'session-new',
  'kind': 'event',
  'type': 'console.output',
  'streamId': 'stream-01',
  'seq': sequence,
  'payload': {
    'streamId': 'stream-01',
    'panelId': 'panel-01',
    'launchGeneration': 1,
    'seq': sequence,
    'data': base64.encode(bytes),
    'encoding': 'base64',
    'bytes': bytes.length,
  },
};

Map<String, dynamic> _response(String type, Map<String, Object?> payload) => {
  'protocolVersion': 1,
  'sessionId': 'session-new',
  'kind': 'response',
  'type': type,
  'requestId': 'request-01',
  'payload': payload,
};
