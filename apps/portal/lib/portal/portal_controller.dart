import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../console/portal_terminal.dart';
import '../security/device_identity_store.dart';
import '../transport/remote_protocol_client.dart';

enum PortalConnectionState {
  offline,
  connecting,
  loading,
  ready,
  degraded,
  incompatible,
  revoked,
}

class PortalProject {
  const PortalProject({
    required this.id,
    required this.name,
    required this.status,
    required this.waiting,
    required this.order,
    required this.iconKind,
    required this.iconValue,
  });

  final String id;
  final String name;
  final String status;
  final int waiting;
  final int order;
  final String? iconKind;
  final String? iconValue;

  factory PortalProject.fromJson(Map<String, dynamic> value) {
    final attention = (value['attention'] as Map).cast<String, dynamic>();
    final icon = (value['icon'] as Map?)?.cast<String, dynamic>();
    return PortalProject(
      id: value['id'] as String,
      name: value['name'] as String,
      status: value['status'] as String,
      waiting: attention['waiting'] as int,
      order: value['order'] as int,
      iconKind: icon?['kind'] as String?,
      iconValue: icon?['value'] as String?,
    );
  }
}

class PortalWorktree {
  const PortalWorktree({
    required this.id,
    required this.name,
    required this.branch,
    required this.availability,
    required this.isCurrent,
    required this.isMain,
  });

  final String id;
  final String name;
  final String? branch;
  final String availability;
  final bool isCurrent;
  final bool isMain;

  factory PortalWorktree.fromJson(Map<String, dynamic> value) => PortalWorktree(
    id: value['id'] as String,
    name: value['name'] as String,
    branch: value['branch'] as String?,
    availability: value['availability'] as String,
    isCurrent: value['isCurrent'] as bool,
    isMain: value['isMain'] as bool,
  );
}

class PortalAgent {
  const PortalAgent({
    required this.panelId,
    required this.generation,
    required this.worktreeId,
    required this.agentId,
    required this.displayName,
    required this.title,
    required this.state,
    required this.continuityState,
    required this.resumeState,
    required this.waitingReason,
    required this.stateSince,
    required this.spawnedRemotely,
  });

  final String panelId;
  final int generation;
  final String worktreeId;
  final String agentId;
  final String displayName;
  final String title;
  final String state;
  final String continuityState;
  final String resumeState;
  final String? waitingReason;
  final int? stateSince;
  final bool spawnedRemotely;

  bool get acceptsPrompts => continuityState == 'live' && state != 'exited';

  factory PortalAgent.fromJson(Map<String, dynamic> value) => PortalAgent(
    panelId: value['panelId'] as String,
    generation: value['launchGeneration'] as int,
    worktreeId: value['worktreeId'] as String,
    agentId: value['agentId'] as String,
    displayName: value['displayName'] as String,
    title: value['title'] as String,
    state: value['state'] as String,
    continuityState: value['continuityState'] as String,
    resumeState: value['resumeState'] as String,
    waitingReason: value['waitingReason'] as String?,
    stateSince: value['stateSince'] as int?,
    spawnedRemotely: value['spawnedRemotely'] as bool,
  );
}

class PortalController extends ChangeNotifier {
  PortalController({
    required this.credential,
    required this.identityStore,
    required this.client,
    Uuid? uuid,
    PortalTerminalModel? consoleRenderer,
  }) : _uuid = uuid ?? const Uuid(),
       consoleRenderer =
           consoleRenderer ??
           PortalTerminalModel(
             platform: terminalPlatformFor(defaultTargetPlatform),
           );

  final PairedHostCredential credential;
  final DeviceIdentityStore identityStore;
  final RemoteProtocolClient client;
  final Uuid _uuid;
  final PortalTerminalModel consoleRenderer;
  StreamSubscription<Map<String, dynamic>>? _events;

  PortalConnectionState connectionState = PortalConnectionState.offline;
  List<PortalProject> projects = const [];
  List<PortalWorktree> worktrees = const [];
  List<PortalAgent> agents = const [];
  PortalProject? selectedProject;
  PortalWorktree? selectedWorktree;
  PortalAgent? selectedAgent;
  String composerText = '';
  String? streamId;
  int consoleSequence = 0;
  bool consoleStale = false;
  bool mutationPending = false;
  String? statusMessage;
  String? _resumeSessionId;
  bool _refreshingProjection = false;

  bool get readOnly =>
      connectionState != PortalConnectionState.ready || consoleStale;

  Future<void> connect() async {
    final targetProjectId = selectedProject?.id;
    final targetPanelId = selectedAgent?.panelId;
    final targetGeneration = selectedAgent?.generation;
    connectionState = PortalConnectionState.connecting;
    statusMessage = null;
    notifyListeners();
    try {
      final identity = await identityStore.loadOrCreate();
      await client.open(
        Uri(scheme: 'wss', host: credential.host, port: credential.port),
        credential.tlsFingerprint,
      );
      final capabilities = await client.authenticate(
        identity: identity,
        hostPublicKey: credential.hostPublicKey,
        hostFingerprint: credential.hostFingerprint,
        resumeSessionId: _resumeSessionId,
      );
      _resumeSessionId = client.sessionId;
      if (!capabilities.contains('observe-projects')) {
        connectionState = PortalConnectionState.degraded;
        statusMessage = 'This device can no longer observe projects';
        notifyListeners();
        return;
      }
      await _events?.cancel();
      _events = client.events.listen(_handleEvent);
      await loadProjects();
      if (targetProjectId != null &&
          projects.any((project) => project.id == targetProjectId)) {
        await openProject(targetProjectId, preserveConsoleTarget: true);
      }
      if (targetPanelId != null && targetGeneration != null) {
        final target = agents
            .where(
              (agent) =>
                  agent.panelId == targetPanelId &&
                  agent.generation == targetGeneration,
            )
            .firstOrNull;
        if (target != null) {
          await openAgent(target);
        } else {
          consoleStale = true;
          statusMessage =
              'The selected agent is no longer available on the host';
          notifyListeners();
        }
      }
    } on RemoteProtocolException catch (error) {
      connectionState = switch (error.code) {
        'DEVICE_REVOKED' => PortalConnectionState.revoked,
        'UNSUPPORTED_VERSION' => PortalConnectionState.incompatible,
        _ => PortalConnectionState.offline,
      };
      statusMessage = error.message;
      consoleStale = selectedAgent != null;
      notifyListeners();
    } catch (_) {
      connectionState = PortalConnectionState.offline;
      statusMessage =
          'Check that this host is awake and on the private network';
      consoleStale = selectedAgent != null;
      notifyListeners();
    }
  }

  Future<void> loadProjects() async {
    connectionState = PortalConnectionState.loading;
    notifyListeners();
    final response = await client.request('projects.list', const {});
    final payload = RemoteProtocolClient.payloadOf(response);
    projects =
        (payload['projects'] as List)
            .map(
              (value) => PortalProject.fromJson(
                (value as Map).cast<String, dynamic>(),
              ),
            )
            .toList()
          ..sort((a, b) => a.order.compareTo(b.order));
    connectionState = payload['degraded'] == true
        ? PortalConnectionState.degraded
        : PortalConnectionState.ready;
    statusMessage = payload['degraded'] == true
        ? 'Showing the host’s last successful project state'
        : null;
    notifyListeners();
  }

  Future<void> openProject(
    String projectId, {
    bool preserveConsoleTarget = false,
  }) async {
    final preservedAgent = preserveConsoleTarget ? selectedAgent : null;
    if (!preserveConsoleTarget) {
      await _unsubscribeCurrent();
    }
    selectedProject = projects
        .where((project) => project.id == projectId)
        .firstOrNull;
    if (!preserveConsoleTarget) {
      selectedWorktree = null;
      selectedAgent = null;
    }
    worktrees = const [];
    agents = const [];
    connectionState = PortalConnectionState.loading;
    notifyListeners();
    final response = await client.request('project.open', {
      'projectId': projectId,
    });
    final payload = RemoteProtocolClient.payloadOf(response);
    worktrees = (payload['worktrees'] as List)
        .map(
          (value) =>
              PortalWorktree.fromJson((value as Map).cast<String, dynamic>()),
        )
        .toList();
    agents = (payload['agents'] as List)
        .map(
          (value) =>
              PortalAgent.fromJson((value as Map).cast<String, dynamic>()),
        )
        .toList();
    if (preservedAgent != null) {
      selectedAgent = agents
          .where(
            (agent) =>
                agent.panelId == preservedAgent.panelId &&
                agent.generation == preservedAgent.generation,
          )
          .firstOrNull;
      selectedWorktree = worktrees
          .where((worktree) => worktree.id == preservedAgent.worktreeId)
          .firstOrNull;
    }
    connectionState = payload['degraded'] == true
        ? PortalConnectionState.degraded
        : PortalConnectionState.ready;
    statusMessage = switch (payload['projectionState']) {
      'loading' => 'The desktop is preparing this project',
      'evicted' => 'The project view is waking up',
      'unavailable' => 'This project is temporarily unavailable',
      _ =>
        payload['degraded'] == true
            ? 'Showing the last successful project state'
            : null,
    };
    notifyListeners();
  }

  void selectWorktree(PortalWorktree worktree) {
    selectedWorktree = worktree;
    selectedAgent = null;
    notifyListeners();
  }

  Future<void> closeAgent() async {
    await _unsubscribeCurrent();
    selectedAgent = null;
    notifyListeners();
  }

  Future<void> closeProject() async {
    await _unsubscribeCurrent();
    selectedProject = null;
    selectedWorktree = null;
    selectedAgent = null;
    notifyListeners();
  }

  Future<void> openAgent(PortalAgent agent, {bool forceResync = false}) async {
    final previous = selectedAgent;
    if (!forceResync &&
        previous != null &&
        (previous.panelId != agent.panelId ||
            previous.generation != agent.generation)) {
      await _unsubscribeCurrent();
      consoleRenderer.replace('');
      consoleSequence = 0;
    }
    selectedAgent = agent;
    selectedWorktree = worktrees
        .where((worktree) => worktree.id == agent.worktreeId)
        .firstOrNull;
    consoleStale = connectionState != PortalConnectionState.ready;
    notifyListeners();
    if (!client.connected) return;
    final response = await client.request('console.subscribe', {
      'projectId': selectedProject!.id,
      'worktreeId': agent.worktreeId,
      'panelId': agent.panelId,
      'launchGeneration': agent.generation,
      if (!forceResync && consoleSequence > 0) 'afterSeq': consoleSequence,
    });
    final payload = RemoteProtocolClient.payloadOf(response);
    streamId = payload['streamId'] as String;
    final mode = payload['mode'] as String;
    if (mode == 'snapshot') {
      final snapshot = (payload['snapshot'] as Map).cast<String, dynamic>();
      consoleRenderer.replace(snapshot['data'] as String);
    } else if (mode == 'resync') {
      consoleRenderer.replace('');
    }
    for (final raw in payload['chunks'] as List) {
      _appendChunk((raw as Map).cast<String, dynamic>());
    }
    consoleSequence = payload['throughSeq'] as int;
    consoleStale = false;
    notifyListeners();
  }

  void updateComposer(String value) {
    composerText = value;
    notifyListeners();
  }

  Future<bool> submitPrompt() async {
    final agent = selectedAgent;
    final text = composerText;
    if (agent == null ||
        text.trim().isEmpty ||
        readOnly ||
        mutationPending ||
        !agent.acceptsPrompts) {
      return false;
    }
    mutationPending = true;
    notifyListeners();
    final key = _uuid.v4();
    try {
      var payload = RemoteProtocolClient.payloadOf(
        await client.request('prompt.submit', {
          'projectId': selectedProject!.id,
          'worktreeId': agent.worktreeId,
          'panelId': agent.panelId,
          'launchGeneration': agent.generation,
          'idempotencyKey': key,
          'text': text,
        }),
      );
      if (payload['disposition'] == 'unknown') {
        payload = RemoteProtocolClient.payloadOf(
          await client.request('request.status', {'idempotencyKey': key}),
        );
      }
      if (payload['disposition'] == 'committed') {
        if (composerText == text) composerText = '';
        statusMessage = null;
        return true;
      }
      statusMessage = payload['disposition'] == 'unknown'
          ? 'The host is still confirming this prompt. Check again before retrying'
          : 'The prompt was not sent. Your text is still here';
      return false;
    } finally {
      mutationPending = false;
      notifyListeners();
    }
  }

  Future<Map<String, dynamic>> launchAgent({
    required PortalWorktree worktree,
    required String agentId,
    String? prompt,
    String? modelId,
    String? name,
  }) async {
    if (!credential.capabilities.contains('launch-agents')) {
      throw const RemoteProtocolException(
        'FORBIDDEN',
        'This device cannot launch agents',
      );
    }
    mutationPending = true;
    notifyListeners();
    final idempotencyKey = _uuid.v4();
    try {
      var result = RemoteProtocolClient.payloadOf(
        await client.request('agent.launch', {
          'projectId': selectedProject!.id,
          'worktreeId': worktree.id,
          'agentId': agentId,
          'requestedPanelId': _uuid.v4(),
          'idempotencyKey': idempotencyKey,
          if (prompt?.trim().isNotEmpty == true) 'prompt': prompt!.trim(),
          'modelId': ?modelId,
          if (name?.trim().isNotEmpty == true) 'name': name!.trim(),
        }),
      );
      if (result['disposition'] == 'unknown') {
        result = RemoteProtocolClient.payloadOf(
          await client.request('request.status', {
            'idempotencyKey': idempotencyKey,
          }),
        );
      }
      if (result['disposition'] == 'unknown') {
        statusMessage =
            'The host is still confirming this launch. Check status before trying again';
      } else if (result['disposition'] == 'rejected' ||
          result['disposition'] == 'not-found') {
        statusMessage = 'The agent was not launched';
      } else {
        statusMessage = null;
      }
      return result;
    } finally {
      mutationPending = false;
      notifyListeners();
    }
  }

  Future<List<Map<String, dynamic>>> launchableAgents(
    PortalWorktree worktree,
  ) async {
    final response = await client.request('agents.launchable', {
      'projectId': selectedProject!.id,
      'worktreeId': worktree.id,
    });
    final payload = RemoteProtocolClient.payloadOf(response);
    return (payload['agents'] as List)
        .map((value) => (value as Map).cast<String, dynamic>())
        .toList(growable: false);
  }

  Future<void> pause() async {
    consoleStale = selectedAgent != null;
    connectionState = PortalConnectionState.offline;
    statusMessage = selectedAgent == null
        ? 'Connection paused'
        : 'Connection paused · console is read-only';
    notifyListeners();
    await client.close();
  }

  Future<void> _unsubscribeCurrent() async {
    final currentStreamId = streamId;
    streamId = null;
    if (currentStreamId == null || !client.connected) return;
    try {
      await client.request('console.unsubscribe', {
        'streamId': currentStreamId,
      });
    } on RemoteProtocolException {
      consoleStale = selectedAgent != null;
    }
  }

  Future<void> resume() => connect();

  void _handleEvent(Map<String, dynamic> envelope) {
    final type = envelope['type'];
    if (type == 'projects.updated' || type == 'project.updated') {
      if (!_refreshingProjection) {
        unawaited(_refreshProjection(type));
      }
      return;
    }
    if (type == 'session.disconnected') {
      connectionState = PortalConnectionState.offline;
      consoleStale = selectedAgent != null;
      statusMessage = 'Connection lost · showing the last received state';
      notifyListeners();
      return;
    }
    if (type == 'session.revoked') {
      connectionState = PortalConnectionState.revoked;
      consoleStale = true;
      statusMessage = 'This device was revoked on the host';
      notifyListeners();
      return;
    }
    if (type == 'console.resyncRequired') {
      consoleStale = true;
      statusMessage = 'Console continuity was interrupted · resync required';
      final agent = selectedAgent;
      if (agent != null) unawaited(openAgent(agent, forceResync: true));
      return;
    }
    if (type == 'console.output') {
      final payload = RemoteProtocolClient.payloadOf(envelope);
      if (payload['streamId'] != streamId ||
          payload['panelId'] != selectedAgent?.panelId) {
        return;
      }
      final sequence = payload['seq'] as int;
      if (sequence != consoleSequence + 1) {
        consoleStale = true;
        statusMessage = 'Console output has a gap · resyncing';
        final agent = selectedAgent;
        if (agent != null) unawaited(openAgent(agent, forceResync: true));
        return;
      }
      _appendChunk(payload);
      consoleSequence = sequence;
      client.acknowledge(streamId!, sequence);
    }
  }

  Future<void> _refreshProjection(Object? eventType) async {
    _refreshingProjection = true;
    try {
      if (eventType == 'projects.updated') {
        await loadProjects();
      }
      final projectId = selectedProject?.id;
      if (projectId != null) {
        await openProject(projectId, preserveConsoleTarget: true);
      }
    } on RemoteProtocolException {
      connectionState = PortalConnectionState.degraded;
      statusMessage = 'Project state changed but could not be refreshed';
      notifyListeners();
    } finally {
      _refreshingProjection = false;
    }
  }

  void _appendChunk(Map<String, dynamic> chunk) {
    final bytes = base64.decode(chunk['data'] as String);
    if (bytes.length != chunk['bytes']) {
      throw const FormatException('Console chunk length mismatch');
    }
    consoleRenderer.appendBytes(bytes);
  }

  @override
  void dispose() {
    _events?.cancel();
    client.close();
    consoleRenderer.dispose();
    super.dispose();
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
