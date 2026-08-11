import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:nsd/nsd.dart' as nsd;

import 'discovered_host.dart';

enum DiscoveryEventStatus { found, lost }

class DiscoveryEvent {
  const DiscoveryEvent(this.service, this.status);

  final RawDiscoveredService service;
  final DiscoveryEventStatus status;
}

abstract interface class DiscoverySession {
  Future<void> stop();
}

abstract interface class DiscoveryAdapter {
  Future<DiscoverySession> start(void Function(DiscoveryEvent event) onEvent);
}

class DiscoveryPermissionException implements Exception {
  const DiscoveryPermissionException();
}

typedef StartNsdDiscovery = Future<nsd.Discovery> Function(String serviceType);
typedef StopNsdDiscovery = Future<void> Function(nsd.Discovery discovery);

class NsdDiscoveryAdapter implements DiscoveryAdapter {
  NsdDiscoveryAdapter({
    StartNsdDiscovery? startDiscovery,
    StopNsdDiscovery? stopDiscovery,
  }) : _startDiscovery = startDiscovery ?? nsd.startDiscovery,
       _stopDiscovery = stopDiscovery ?? nsd.stopDiscovery;

  final StartNsdDiscovery _startDiscovery;
  final StopNsdDiscovery _stopDiscovery;

  @override
  Future<DiscoverySession> start(
    void Function(DiscoveryEvent event) onEvent,
  ) async {
    try {
      final discovery = await _startDiscovery(daintreePortalServiceType);
      FutureOr<void> listener(nsd.Service service, nsd.ServiceStatus status) {
        onEvent(
          DiscoveryEvent(
            RawDiscoveredService(
              name: service.name,
              type: service.type,
              host: service.host,
              port: service.port,
              txt: service.txt,
              addresses:
                  service.addresses
                      ?.map((address) => address.address)
                      .toList() ??
                  const [],
            ),
            status == nsd.ServiceStatus.found
                ? DiscoveryEventStatus.found
                : DiscoveryEventStatus.lost,
          ),
        );
      }

      discovery.addServiceListener(listener);
      return _NsdDiscoverySession(discovery, listener, _stopDiscovery);
    } on nsd.NsdError catch (error) {
      if (error.cause == nsd.ErrorCause.securityIssue) {
        throw const DiscoveryPermissionException();
      }
      rethrow;
    }
  }
}

class _NsdDiscoverySession implements DiscoverySession {
  _NsdDiscoverySession(this.discovery, this.listener, this.stopDiscovery);

  final nsd.Discovery discovery;
  final nsd.ServiceListener listener;
  final StopNsdDiscovery stopDiscovery;

  @override
  Future<void> stop() async {
    discovery.removeServiceListener(listener);
    await stopDiscovery(discovery);
  }
}

class HostDiscoveryController extends ChangeNotifier {
  HostDiscoveryController(this.adapter);

  final DiscoveryAdapter adapter;
  final Map<String, DiscoveredHost> _hosts = {};
  DiscoverySession? _session;

  DiscoveryPhase phase = DiscoveryPhase.idle;
  String? recoveryMessage;

  List<DiscoveredHost> get hosts {
    final values = _hosts.values.toList();
    values.sort((a, b) {
      final reachability = a.reachability.index.compareTo(b.reachability.index);
      if (reachability != 0) return reachability;
      return a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase());
    });
    return List.unmodifiable(values);
  }

  Future<void> start() async {
    await _session?.stop();
    _session = null;
    phase = DiscoveryPhase.scanning;
    recoveryMessage = null;
    notifyListeners();
    try {
      _session = await adapter.start(_handleEvent);
    } on DiscoveryPermissionException {
      phase = DiscoveryPhase.permissionDenied;
      recoveryMessage =
          'Allow local network access in Settings, then try again';
      notifyListeners();
    } catch (_) {
      phase = DiscoveryPhase.failed;
      recoveryMessage = 'Check this network connection, then retry discovery';
      notifyListeners();
    }
  }

  Future<void> restartForNetworkChange() async {
    await pause();
    await start();
  }

  Future<void> pause() async {
    await _session?.stop();
    _session = null;
    for (final entry in _hosts.entries.toList()) {
      if (!entry.value.manual) {
        _hosts[entry.key] = entry.value.copyWith(
          reachability: HostReachability.stale,
        );
      }
    }
    phase = DiscoveryPhase.idle;
    notifyListeners();
  }

  DiscoveredHost addManual(String value) {
    final host = ManualEndpointParser.parse(value);
    _hosts[host.id] = host;
    notifyListeners();
    return host;
  }

  void markUnreachable(String id) {
    final host = _hosts[id];
    if (host == null) return;
    _hosts[id] = host.copyWith(reachability: HostReachability.unreachable);
    notifyListeners();
  }

  void _handleEvent(DiscoveryEvent event) {
    final host = DiscoveredHost.fromService(event.service);
    if (host == null) return;
    if (event.status == DiscoveryEventStatus.lost) {
      final existing = _hosts[host.id];
      if (existing != null) {
        _hosts[host.id] = existing.copyWith(
          reachability: HostReachability.stale,
        );
      }
    } else {
      _hosts[host.id] = host;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    unawaited(_session?.stop());
    _session = null;
    super.dispose();
  }
}
