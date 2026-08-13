import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import '../console/portal_terminal.dart';
import '../security/device_identity_store.dart';
import '../theme/portal_appearance.dart';
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

class PortalLaunchableAgent {
  const PortalLaunchableAgent({
    required this.agentId,
    required this.displayName,
    required this.iconId,
    required this.brandColor,
  });

  final String agentId;
  final String displayName;
  final String? iconId;
  final String? brandColor;

  factory PortalLaunchableAgent.fromJson(Map<String, dynamic> value) =>
      PortalLaunchableAgent(
        agentId: value['agentId'] as String,
        displayName: value['displayName'] as String,
        iconId: value['iconId'] as String?,
        brandColor: value['brandColor'] as String?,
      );
}

class PortalController extends ChangeNotifier {
  PortalController({
    required this.credential,
    required this.identityStore,
    required this.client,
    Uuid? uuid,
    PortalTerminalModel? consoleRenderer,
    this.launchConsoleRecoveryDelay = const Duration(seconds: 2),
    this.launchTargetRetryDelay = const Duration(milliseconds: 250),
    this.launchTargetRetryAttempts = 8,
    this.onAccessRevoked,
  }) : _uuid = uuid ?? const Uuid(),
       consoleRenderer =
           consoleRenderer ??
           PortalTerminalModel(
             platform: terminalPlatformFor(defaultTargetPlatform),
           ) {
    if (credential.accessRevoked) {
      connectionState = PortalConnectionState.revoked;
      statusMessage =
          'This device was revoked on the host · pair it again to reconnect';
      _revocationNotified = true;
    }
  }

  final PairedHostCredential credential;
  final DeviceIdentityStore identityStore;
  final RemoteProtocolClient client;
  final Uuid _uuid;
  final Duration launchConsoleRecoveryDelay;
  final Duration launchTargetRetryDelay;
  final int launchTargetRetryAttempts;
  final PortalTerminalModel consoleRenderer;
  final VoidCallback? onAccessRevoked;
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
  PortalAppearance? hostAppearance;
  PortalAppearance? _sessionAppearance;
  String? _resumeSessionId;
  bool _refreshingProjection = false;
  bool _resyncingConsole = false;
  int _automaticConsoleResyncs = 0;
  int _consoleSubscriptionEpoch = 0;
  String? _subscribingPanelId;
  final List<Map<String, dynamic>> _subscriptionBoundaryEvents = [];
  final Set<String> _closingAgentKeys = {};
  Timer? _launchConsoleRecoveryTimer;
  bool _revocationNotified = false;

  bool get readOnly =>
      connectionState != PortalConnectionState.ready || consoleStale;

  bool get canCloseAgents =>
      connectionState == PortalConnectionState.ready &&
      credential.capabilities.contains('launch-agents') &&
      !mutationPending;

  bool isClosingAgent(PortalAgent agent) =>
      mutationPending && _closingAgentKeys.contains(_agentKey(agent));

  Future<void> connect() async {
    if (credential.accessRevoked) {
      connectionState = PortalConnectionState.revoked;
      statusMessage =
          'This device was revoked on the host · pair it again to reconnect';
      notifyListeners();
      return;
    }
    final targetProjectId = selectedProject?.id;
    final targetPanelId = selectedAgent?.panelId;
    final targetGeneration = selectedAgent?.generation;
    _sessionAppearance = null;
    connectionState = PortalConnectionState.connecting;
    statusMessage = null;
    notifyListeners();
    try {
      final identity = await identityStore.loadOrCreate();
      await client.open(
        Uri(scheme: 'wss', host: credential.host, port: credential.port),
        credential.tlsFingerprint,
      );
      await _events?.cancel();
      _events = client.events.listen(_handleEvent);
      final authentication = await client.authenticate(
        identity: identity,
        hostPublicKey: credential.hostPublicKey,
        hostFingerprint: credential.hostFingerprint,
        resumeSessionId: _resumeSessionId,
      );
      _resumeSessionId = client.sessionId;
      if (authentication.appearance != null &&
          (_sessionAppearance == null ||
              authentication.appearance!.revision >
                  _sessionAppearance!.revision)) {
        hostAppearance = authentication.appearance;
        _sessionAppearance = authentication.appearance;
        notifyListeners();
      }
      if (!authentication.capabilities.contains('observe-projects')) {
        connectionState = PortalConnectionState.degraded;
        statusMessage = 'This device can no longer observe projects';
        notifyListeners();
        return;
      }
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
      if (error.code == 'DEVICE_REVOKED') {
        hostAppearance = null;
        _notifyAccessRevoked();
      }
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
    try {
      final response = await client.request('project.open', {
        'projectId': projectId,
      }, timeout: const Duration(seconds: 90));
      final payload = RemoteProtocolClient.payloadOf(response);
      worktrees = (payload['worktrees'] as List)
          .map(
            (value) =>
                PortalWorktree.fromJson((value as Map).cast<String, dynamic>()),
          )
          .toList();
      final projectedAgents = (payload['agents'] as List)
          .map(
            (value) =>
                PortalAgent.fromJson((value as Map).cast<String, dynamic>()),
          )
          .toList();
      final projectedKeys = projectedAgents.map(_agentKey).toSet();
      _closingAgentKeys.removeWhere((key) => !projectedKeys.contains(key));
      agents = projectedAgents
          .where((agent) => !_closingAgentKeys.contains(_agentKey(agent)))
          .toList(growable: false);
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
    } on RemoteProtocolException catch (error) {
      connectionState = PortalConnectionState.degraded;
      statusMessage = '${error.message} · tap Retry to try again';
    } catch (_) {
      connectionState = PortalConnectionState.degraded;
      statusMessage =
          'Project details could not be loaded · tap Retry to try again';
    }
    notifyListeners();
  }

  void selectWorktree(PortalWorktree worktree) {
    selectedWorktree = worktree;
    selectedAgent = null;
    notifyListeners();
  }

  Future<void> leaveAgentConsole() async {
    await _unsubscribeCurrent();
    selectedAgent = null;
    notifyListeners();
  }

  Future<bool> closeAgentPane(PortalAgent agent) async {
    if (!canCloseAgents || selectedProject == null) return false;
    _closingAgentKeys.add(_agentKey(agent));
    mutationPending = true;
    notifyListeners();
    final idempotencyKey = _uuid.v4();
    try {
      var result = RemoteProtocolClient.payloadOf(
        await client.request('agent.close', {
          'projectId': selectedProject!.id,
          'worktreeId': agent.worktreeId,
          'panelId': agent.panelId,
          'launchGeneration': agent.generation,
          'idempotencyKey': idempotencyKey,
        }),
      );
      if (result['disposition'] == 'unknown') {
        result = RemoteProtocolClient.payloadOf(
          await client.request('request.status', {
            'idempotencyKey': idempotencyKey,
          }),
        );
      }
      final closed =
          result['disposition'] == 'closed' ||
          result['disposition'] == 'committed';
      if (!closed) {
        _closingAgentKeys.remove(_agentKey(agent));
        statusMessage =
            'The host could not confirm that this pane was closed. Retry before closing it again';
        return false;
      }
      if (selectedAgent?.panelId == agent.panelId &&
          selectedAgent?.generation == agent.generation) {
        await _unsubscribeCurrent();
        selectedAgent = null;
        consoleRenderer.replace('');
        consoleSequence = 0;
        consoleStale = false;
      }
      agents = agents
          .where(
            (candidate) =>
                candidate.panelId != agent.panelId ||
                candidate.generation != agent.generation,
          )
          .toList(growable: false);
      statusMessage = null;
      unawaited(refreshSelectedProject());
      return true;
    } catch (_) {
      _closingAgentKeys.remove(_agentKey(agent));
      rethrow;
    } finally {
      mutationPending = false;
      notifyListeners();
    }
  }

  String _agentKey(PortalAgent agent) => '${agent.panelId}:${agent.generation}';

  Future<void> closeProject() async {
    await _unsubscribeCurrent();
    selectedProject = null;
    selectedWorktree = null;
    selectedAgent = null;
    notifyListeners();
  }

  Future<void> openAgent(PortalAgent agent, {bool forceResync = false}) async {
    if (!forceResync) {
      _automaticConsoleResyncs = 0;
      _launchConsoleRecoveryTimer?.cancel();
      _launchConsoleRecoveryTimer = null;
    }
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
    final subscriptionEpoch = ++_consoleSubscriptionEpoch;
    _subscribingPanelId = agent.panelId;
    _subscriptionBoundaryEvents.clear();
    try {
      final response = await client.request('console.subscribe', {
        'projectId': selectedProject!.id,
        'worktreeId': agent.worktreeId,
        'panelId': agent.panelId,
        'launchGeneration': agent.generation,
        if (!forceResync && consoleSequence > 0) 'afterSeq': consoleSequence,
      });
      final payload = RemoteProtocolClient.payloadOf(response);
      if (subscriptionEpoch != _consoleSubscriptionEpoch) return;
      streamId = payload['streamId'] as String;
      final mode = payload['mode'] as String;
      if (mode == 'snapshot') {
        final snapshot = (payload['snapshot'] as Map).cast<String, dynamic>();
        consoleRenderer.replace(
          snapshot['data'] as String,
          columns: snapshot['cols'] as int,
          rows: snapshot['rows'] as int,
        );
      }
      for (final raw in payload['chunks'] as List) {
        _appendChunk((raw as Map).cast<String, dynamic>());
      }
      consoleSequence = payload['throughSeq'] as int;
      consoleStale = mode == 'resync';
      if (mode == 'resync') {
        statusMessage = 'Console resync paused · tap Retry to try again';
      }
      final boundaryEvents = List<Map<String, dynamic>>.of(
        _subscriptionBoundaryEvents,
      );
      _subscriptionBoundaryEvents.clear();
      _subscribingPanelId = null;
      for (final event in boundaryEvents) {
        _handleEvent(event);
      }
      notifyListeners();
    } finally {
      if (subscriptionEpoch == _consoleSubscriptionEpoch) {
        _subscribingPanelId = null;
        _subscriptionBoundaryEvents.clear();
      }
    }
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

  Future<Map<String, dynamic>> launchAgentAndOpen({
    required PortalWorktree worktree,
    required PortalLaunchableAgent agent,
  }) async {
    final result = await launchAgent(
      worktree: worktree,
      agentId: agent.agentId,
    );
    if (result['disposition'] != 'created' &&
        result['disposition'] != 'existing') {
      return result;
    }
    final launched = PortalAgent(
      panelId: result['panelId'] as String,
      generation: result['launchGeneration'] as int,
      worktreeId: worktree.id,
      agentId: agent.agentId,
      displayName: agent.displayName,
      title: agent.displayName,
      state: 'starting',
      continuityState: 'live',
      resumeState: 'not-ready',
      waitingReason: null,
      stateSince: DateTime.now().millisecondsSinceEpoch,
      spawnedRemotely: true,
    );
    agents = [
      ...agents.where(
        (candidate) =>
            candidate.panelId != launched.panelId ||
            candidate.generation != launched.generation,
      ),
      launched,
    ];
    await _openLaunchedAgent(launched);
    _scheduleLaunchConsoleRecovery(launched);
    return result;
  }

  Future<void> _openLaunchedAgent(PortalAgent agent) async {
    for (var attempt = 0; attempt < launchTargetRetryAttempts; attempt += 1) {
      try {
        await openAgent(agent);
        return;
      } on RemoteProtocolException catch (error) {
        final targetIsStillPublishing =
            error.code == 'NOT_FOUND' || error.code == 'STALE_GENERATION';
        if (!targetIsStillPublishing ||
            attempt == launchTargetRetryAttempts - 1) {
          rethrow;
        }
        await Future<void>.delayed(launchTargetRetryDelay);
      }
    }
  }

  Future<List<PortalLaunchableAgent>> launchableAgents(
    PortalWorktree worktree,
  ) async {
    final response = await client.request('agents.launchable', {
      'projectId': selectedProject!.id,
      'worktreeId': worktree.id,
    });
    final payload = RemoteProtocolClient.payloadOf(response);
    return (payload['agents'] as List)
        .map(
          (value) => PortalLaunchableAgent.fromJson(
            (value as Map).cast<String, dynamic>(),
          ),
        )
        .toList(growable: false);
  }

  Future<void> refreshSelectedProject() async {
    final projectId = selectedProject?.id;
    if (projectId == null) return;
    await openProject(projectId, preserveConsoleTarget: true);
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
    _launchConsoleRecoveryTimer?.cancel();
    _launchConsoleRecoveryTimer = null;
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

  void retryConsole() {
    final agent = selectedAgent;
    if (agent == null || _resyncingConsole) return;
    _automaticConsoleResyncs = 1;
    _startConsoleResync(agent);
  }

  void _handleEvent(Map<String, dynamic> envelope) {
    final type = envelope['type'];
    if (type == 'appearance.updated') {
      if (!client.appearanceEventsTrusted) return;
      final payload = envelope['payload'];
      final next = client.parseAppearance(payload);
      if (next != null &&
          next.revision > (_sessionAppearance?.revision ?? -1)) {
        hostAppearance = next;
        _sessionAppearance = next;
        notifyListeners();
      }
      return;
    }
    if (type == 'projects.updated' || type == 'project.updated') {
      if (!_refreshingProjection) {
        unawaited(_refreshProjection(type));
      }
      return;
    }
    if (type == 'session.disconnected') {
      final error = envelope['error'];
      final revoked =
          error is RemoteProtocolException && error.code == 'DEVICE_REVOKED';
      connectionState = revoked
          ? PortalConnectionState.revoked
          : PortalConnectionState.offline;
      consoleStale = selectedAgent != null;
      statusMessage = revoked
          ? 'This device was revoked on the host · pair it again to reconnect'
          : 'Connection lost · showing the last received state';
      if (revoked) hostAppearance = null;
      if (revoked) _notifyAccessRevoked();
      notifyListeners();
      return;
    }
    if (type == 'session.revoked') {
      connectionState = PortalConnectionState.revoked;
      hostAppearance = null;
      consoleStale = true;
      statusMessage = 'This device was revoked on the host';
      _notifyAccessRevoked();
      notifyListeners();
      return;
    }
    if (type == 'console.resyncRequired') {
      final payload = RemoteProtocolClient.payloadOf(envelope);
      if (_subscribingPanelId != null && payload['streamId'] != streamId) {
        _subscriptionBoundaryEvents.add(envelope);
        return;
      }
      consoleStale = true;
      statusMessage = 'Console continuity was interrupted · resync required';
      final agent = selectedAgent;
      if (agent != null &&
          !_resyncingConsole &&
          _automaticConsoleResyncs == 0) {
        _automaticConsoleResyncs += 1;
        _startConsoleResync(agent);
      } else {
        statusMessage = 'Console resync paused · tap Retry to try again';
        notifyListeners();
      }
      return;
    }
    if (type == 'console.output') {
      final payload = RemoteProtocolClient.payloadOf(envelope);
      if (payload['panelId'] == _subscribingPanelId &&
          payload['streamId'] != streamId) {
        _subscriptionBoundaryEvents.add(envelope);
        return;
      }
      if (payload['streamId'] != streamId ||
          payload['panelId'] != selectedAgent?.panelId) {
        return;
      }
      final sequence = payload['seq'] as int;
      if (sequence != consoleSequence + 1) {
        consoleStale = true;
        statusMessage = 'Console output has a gap · resyncing';
        final agent = selectedAgent;
        if (agent != null) _startConsoleResync(agent);
        notifyListeners();
        return;
      }
      _appendChunk(payload);
      consoleSequence = sequence;
      _automaticConsoleResyncs = 0;
      _launchConsoleRecoveryTimer?.cancel();
      _launchConsoleRecoveryTimer = null;
      client.acknowledge(streamId!, sequence);
    }
  }

  void _notifyAccessRevoked() {
    if (_revocationNotified) return;
    _revocationNotified = true;
    onAccessRevoked?.call();
  }

  void _scheduleLaunchConsoleRecovery(PortalAgent agent) {
    if (consoleSequence > 0 ||
        consoleRenderer.normalizedText.trim().isNotEmpty) {
      return;
    }
    _launchConsoleRecoveryTimer?.cancel();
    _launchConsoleRecoveryTimer = Timer(launchConsoleRecoveryDelay, () {
      if (selectedAgent?.panelId != agent.panelId ||
          selectedAgent?.generation != agent.generation ||
          consoleSequence > 0 ||
          consoleRenderer.normalizedText.trim().isNotEmpty ||
          !client.connected ||
          _resyncingConsole) {
        return;
      }
      _resyncingConsole = true;
      unawaited(_recoverSilentLaunch(agent));
    });
  }

  Future<void> _recoverSilentLaunch(PortalAgent agent) async {
    try {
      await _unsubscribeCurrent();
      await openAgent(agent, forceResync: true);
    } on RemoteProtocolException catch (error) {
      consoleStale = true;
      statusMessage = '${error.message} · tap Retry to try again';
      notifyListeners();
    } catch (_) {
      consoleStale = true;
      statusMessage = 'Console could not be loaded · tap Retry to try again';
      notifyListeners();
    } finally {
      _resyncingConsole = false;
    }
  }

  void _startConsoleResync(PortalAgent agent) {
    if (_resyncingConsole) return;
    _resyncingConsole = true;
    unawaited(_resyncConsole(agent));
  }

  Future<void> _resyncConsole(PortalAgent agent) async {
    try {
      await _unsubscribeCurrent();
      await openAgent(agent, forceResync: true);
    } on RemoteProtocolException catch (error) {
      consoleStale = true;
      statusMessage = '${error.message} · tap Retry to try again';
      notifyListeners();
    } catch (_) {
      consoleStale = true;
      statusMessage = 'Console could not be resynced · tap Retry to try again';
      notifyListeners();
    } finally {
      _resyncingConsole = false;
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
    _launchConsoleRecoveryTimer?.cancel();
    _events?.cancel();
    client.close();
    consoleRenderer.dispose();
    super.dispose();
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
