import 'dart:convert';

import 'package:daintree_portal/discovery/discovered_host.dart';
import 'package:daintree_portal/discovery/host_discovery_controller.dart';
import 'package:flutter_test/flutter_test.dart';

RawDiscoveredService service({
  String name = 'Studio Mac',
  String id = 'host-1',
  String minimum = '1',
  String maximum = '1',
  List<String> addresses = const ['192.168.1.8'],
}) => RawDiscoveredService(
  name: name,
  type: daintreePortalServiceType,
  host: 'studio.local',
  port: 45123,
  txt: {
    'name': utf8.encode(name),
    'id': utf8.encode(id),
    'pmin': utf8.encode(minimum),
    'pmax': utf8.encode(maximum),
    'ver': utf8.encode('0.30.1'),
    'os': utf8.encode('macos'),
    'port': utf8.encode('45123'),
    'fp': utf8.encode('abcdefghijklmnop'),
  },
  addresses: addresses,
);

class FakeSession implements DiscoverySession {
  var stopped = false;

  @override
  Future<void> stop() async => stopped = true;
}

class FakeAdapter implements DiscoveryAdapter {
  void Function(DiscoveryEvent event)? listener;
  Object? failure;
  final sessions = <FakeSession>[];

  @override
  Future<DiscoverySession> start(
    void Function(DiscoveryEvent event) onEvent,
  ) async {
    final error = failure;
    if (error != null) throw error;
    listener = onEvent;
    final session = FakeSession();
    sessions.add(session);
    return session;
  }

  void emit(RawDiscoveredService value, DiscoveryEventStatus status) {
    listener!(DiscoveryEvent(value, status));
  }
}

void main() {
  test(
    'deduplicates by stable identity while retaining duplicate display names',
    () async {
      final adapter = FakeAdapter();
      final controller = HostDiscoveryController(adapter);
      await controller.start();
      adapter.emit(
        service(id: 'host-a', addresses: const ['10.0.0.1']),
        DiscoveryEventStatus.found,
      );
      adapter.emit(
        service(id: 'host-a', addresses: const ['10.0.0.2']),
        DiscoveryEventStatus.found,
      );
      adapter.emit(
        service(id: 'host-b', addresses: const ['10.0.0.3']),
        DiscoveryEventStatus.found,
      );

      expect(controller.hosts, hasLength(2));
      expect(
        controller.hosts.where((host) => host.displayName == 'Studio Mac'),
        hasLength(2),
      );
      expect(
        controller.hosts.firstWhere((host) => host.id == 'host-a').host,
        '10.0.0.2',
      );
    },
  );

  test(
    'marks lost, unreachable, incompatible, and network-change states honestly',
    () async {
      final adapter = FakeAdapter();
      final controller = HostDiscoveryController(adapter);
      await controller.start();
      adapter.emit(service(id: 'host-a'), DiscoveryEventStatus.found);
      adapter.emit(
        service(id: 'host-b', minimum: '2', maximum: '2'),
        DiscoveryEventStatus.found,
      );
      adapter.emit(service(id: 'host-a'), DiscoveryEventStatus.lost);
      expect(
        controller.hosts.firstWhere((host) => host.id == 'host-a').reachability,
        HostReachability.stale,
      );
      expect(
        controller.hosts.firstWhere((host) => host.id == 'host-b').reachability,
        HostReachability.incompatible,
      );

      adapter.emit(service(id: 'host-a'), DiscoveryEventStatus.found);
      controller.markUnreachable('host-a');
      expect(
        controller.hosts.firstWhere((host) => host.id == 'host-a').reachability,
        HostReachability.unreachable,
      );

      await controller.restartForNetworkChange();
      expect(adapter.sessions.first.stopped, isTrue);
      expect(
        controller.hosts
            .where((host) => !host.manual)
            .every((host) => host.reachability == HostReachability.stale),
        isTrue,
      );
    },
  );

  test('preserves manual endpoints across discovery restart', () async {
    final adapter = FakeAdapter();
    final controller = HostDiscoveryController(adapter);
    await controller.start();
    final manual = controller.addManual('vpn-host.internal:46000');
    await controller.restartForNetworkChange();
    expect(controller.hosts.single.id, manual.id);
    expect(controller.hosts.single.manual, isTrue);
  });

  test(
    'surfaces permission denial and generic discovery failure with actionable recovery',
    () async {
      final deniedAdapter = FakeAdapter()
        ..failure = const DiscoveryPermissionException();
      final denied = HostDiscoveryController(deniedAdapter);
      await denied.start();
      expect(denied.phase, DiscoveryPhase.permissionDenied);
      expect(denied.recoveryMessage, contains('Settings'));

      final failedAdapter = FakeAdapter()
        ..failure = StateError('network changed');
      final failed = HostDiscoveryController(failedAdapter);
      await failed.start();
      expect(failed.phase, DiscoveryPhase.failed);
      expect(failed.recoveryMessage, contains('retry discovery'));
    },
  );
}
