import 'dart:convert';
import 'dart:typed_data';

import 'package:daintree_portal/discovery/discovered_host.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Uint8List?> txt({
  String name = 'Studio Mac',
  String id = 'host-1',
  String minimum = '1',
  String maximum = '1',
  String port = '45123',
}) => {
  'name': utf8.encode(name),
  'id': utf8.encode(id),
  'pmin': utf8.encode(minimum),
  'pmax': utf8.encode(maximum),
  'ver': utf8.encode('0.30.1'),
  'os': utf8.encode('macos'),
  'port': utf8.encode(port),
  'fp': utf8.encode('abcdefghijklmnop'),
};

RawDiscoveredService service({
  String name = 'Studio Mac',
  String id = 'host-1',
  String minimum = '1',
  String maximum = '1',
  String port = '45123',
  String? host = 'studio.local',
  List<String> addresses = const ['192.168.1.8'],
}) => RawDiscoveredService(
  name: name,
  type: daintreePortalServiceType,
  host: host,
  port: int.tryParse(port),
  txt: txt(name: name, id: id, minimum: minimum, maximum: maximum, port: port),
  addresses: addresses,
);

void main() {
  group('DNS-SD advertisement parsing', () {
    test('accepts the strict compatible host contract', () {
      final host = DiscoveredHost.fromService(service());
      expect(host, isNotNull);
      expect(host!.id, 'host-1');
      expect(host.host, '192.168.1.8');
      expect(host.reachability, HostReachability.available);
      expect(host.fingerprintPrefix, 'abcdefghijklmnop');
    });

    test('accepts Android NSD service-type normalization', () {
      final raw = service();
      final host = DiscoveredHost.fromService(
        RawDiscoveredService(
          name: raw.name,
          type: daintreePortalServiceType.substring(1),
          host: raw.host,
          port: raw.port,
          txt: raw.txt,
          addresses: raw.addresses,
        ),
      );

      expect(host?.id, 'host-1');
      expect(host?.reachability, HostReachability.available);
    });

    test('marks incompatible protocol ranges without hiding the host', () {
      final host = DiscoveredHost.fromService(
        service(minimum: '2', maximum: '3'),
      );
      expect(host?.reachability, HostReachability.incompatible);
      expect(host?.isCompatible, isFalse);
    });

    test(
      'rejects unknown TXT fields, port disagreement, malformed UTF-8, and wrong types',
      () {
        final unknown = txt()..['project'] = utf8.encode('secret');
        expect(
          DiscoveredHost.fromService(
            RawDiscoveredService(
              name: 'Studio Mac',
              type: daintreePortalServiceType,
              host: 'studio.local',
              port: 45123,
              txt: unknown,
              addresses: const [],
            ),
          ),
          isNull,
        );
        expect(DiscoveredHost.fromService(service(port: '45124')), isNotNull);
        expect(
          DiscoveredHost.fromService(
            RawDiscoveredService(
              name: 'Studio Mac',
              type: daintreePortalServiceType,
              host: 'studio.local',
              port: 45123,
              txt: txt(port: '45124'),
              addresses: const [],
            ),
          ),
          isNull,
        );
        final malformed = txt()..['name'] = Uint8List.fromList([0xff]);
        expect(
          DiscoveredHost.fromService(
            RawDiscoveredService(
              name: 'Studio Mac',
              type: daintreePortalServiceType,
              host: 'studio.local',
              port: 45123,
              txt: malformed,
              addresses: const [],
            ),
          ),
          isNull,
        );
        expect(
          DiscoveredHost.fromService(
            RawDiscoveredService(
              name: 'Studio Mac',
              type: '_http._tcp',
              host: 'studio.local',
              port: 45123,
              txt: txt(),
              addresses: const [],
            ),
          ),
          isNull,
        );
      },
    );
  });

  group('manual private endpoint parsing', () {
    test(
      'accepts private DNS, IPv4, and bracketed IPv6 with explicit ports',
      () {
        expect(
          ManualEndpointParser.parse('host.internal').port,
          defaultRemotePort,
        );
        expect(ManualEndpointParser.parse('10.0.0.8:46000').host, '10.0.0.8');
        final ipv6 = ManualEndpointParser.parse('[fd00::8]:46000');
        expect(ipv6.host, 'fd00::8');
        expect(ipv6.port, 46000);
      },
    );

    test('rejects public IPs, URL syntax, whitespace, and invalid ports', () {
      for (final value in [
        '8.8.8.8:45123',
        'https://host.internal:45123',
        'host internal',
        'host.internal:0',
        'host.internal:65536',
      ]) {
        expect(
          () => ManualEndpointParser.parse(value),
          throwsFormatException,
          reason: value,
        );
      }
    });
  });
}
