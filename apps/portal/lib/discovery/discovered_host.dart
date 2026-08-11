import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

const daintreePortalServiceType = '_daintree-portal._tcp';
const remoteProtocolVersion = 1;
const defaultRemotePort = 45123;

enum HostReachability { available, stale, unreachable, incompatible }

enum DiscoveryPhase { idle, scanning, permissionDenied, failed }

class RawDiscoveredService {
  const RawDiscoveredService({
    required this.name,
    required this.type,
    required this.host,
    required this.port,
    required this.txt,
    required this.addresses,
  });

  final String? name;
  final String? type;
  final String? host;
  final int? port;
  final Map<String, Uint8List?>? txt;
  final List<String> addresses;
}

class DiscoveredHost {
  const DiscoveredHost({
    required this.id,
    required this.displayName,
    required this.host,
    required this.port,
    required this.platform,
    required this.appVersion,
    required this.fingerprintPrefix,
    required this.protocolMin,
    required this.protocolMax,
    required this.reachability,
    required this.manual,
  });

  final String id;
  final String displayName;
  final String host;
  final int port;
  final String platform;
  final String appVersion;
  final String fingerprintPrefix;
  final int protocolMin;
  final int protocolMax;
  final HostReachability reachability;
  final bool manual;

  bool get isCompatible =>
      protocolMin <= remoteProtocolVersion &&
      protocolMax >= remoteProtocolVersion;

  DiscoveredHost copyWith({HostReachability? reachability}) => DiscoveredHost(
    id: id,
    displayName: displayName,
    host: host,
    port: port,
    platform: platform,
    appVersion: appVersion,
    fingerprintPrefix: fingerprintPrefix,
    protocolMin: protocolMin,
    protocolMax: protocolMax,
    reachability: reachability ?? this.reachability,
    manual: manual,
  );

  static DiscoveredHost? fromService(RawDiscoveredService service) {
    final type = service.type?.replaceFirst(RegExp(r'\.$'), '');
    if (type != daintreePortalServiceType) return null;
    final txt = _decodeTxt(service.txt);
    if (txt == null) return null;
    final id = txt['id'];
    final name = txt['name'];
    final platform = txt['os'];
    final appVersion = txt['ver'];
    final fingerprint = txt['fp'];
    final protocolMin = int.tryParse(txt['pmin'] ?? '');
    final protocolMax = int.tryParse(txt['pmax'] ?? '');
    final txtPort = int.tryParse(txt['port'] ?? '');
    final resolvedPort = service.port ?? txtPort;
    final resolvedHost = service.addresses.firstOrNull ?? service.host;
    if (id == null ||
        id.isEmpty ||
        name == null ||
        name.isEmpty ||
        platform == null ||
        appVersion == null ||
        fingerprint == null ||
        fingerprint.length < 8 ||
        protocolMin == null ||
        protocolMax == null ||
        resolvedPort == null ||
        resolvedPort < 1 ||
        resolvedPort > 65535 ||
        txtPort != resolvedPort ||
        resolvedHost == null ||
        resolvedHost.isEmpty) {
      return null;
    }
    final compatible =
        protocolMin <= remoteProtocolVersion &&
        protocolMax >= remoteProtocolVersion;
    return DiscoveredHost(
      id: id,
      displayName: name,
      host: resolvedHost,
      port: resolvedPort,
      platform: platform,
      appVersion: appVersion,
      fingerprintPrefix: fingerprint,
      protocolMin: protocolMin,
      protocolMax: protocolMax,
      reachability: compatible
          ? HostReachability.available
          : HostReachability.incompatible,
      manual: false,
    );
  }
}

Map<String, String>? _decodeTxt(Map<String, Uint8List?>? source) {
  if (source == null) return null;
  const allowed = {'name', 'id', 'pmin', 'pmax', 'ver', 'os', 'port', 'fp'};
  if (source.keys.any((key) => !allowed.contains(key))) return null;
  final result = <String, String>{};
  try {
    for (final entry in source.entries) {
      if (entry.value == null) return null;
      result[entry.key] = utf8.decode(entry.value!, allowMalformed: false);
    }
  } on FormatException {
    return null;
  }
  return result;
}

extension _FirstOrNull<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

class ManualEndpointParser {
  static DiscoveredHost parse(String input) {
    final value = input.trim();
    if (value.isEmpty ||
        value.contains(RegExp(r'[\s/?#]')) ||
        value.contains('://')) {
      throw const FormatException('Enter a host name or private IP address');
    }
    String host;
    var port = defaultRemotePort;
    if (value.startsWith('[')) {
      final close = value.indexOf(']');
      if (close < 2) throw const FormatException('Enter a valid IPv6 address');
      host = value.substring(1, close);
      final suffix = value.substring(close + 1);
      if (suffix.isNotEmpty) {
        if (!suffix.startsWith(':')) {
          throw const FormatException('Enter a valid host and port');
        }
        port = _parsePort(suffix.substring(1));
      }
    } else if (RegExp(':').allMatches(value).length == 1) {
      final separator = value.lastIndexOf(':');
      host = value.substring(0, separator);
      port = _parsePort(value.substring(separator + 1));
    } else {
      host = value;
    }
    if (!_validHost(host)) {
      throw const FormatException('Enter a valid private host');
    }
    return DiscoveredHost(
      id: 'manual:${host.toLowerCase()}:$port',
      displayName: host,
      host: host,
      port: port,
      platform: 'unknown',
      appVersion: 'unknown',
      fingerprintPrefix: '',
      protocolMin: remoteProtocolVersion,
      protocolMax: remoteProtocolVersion,
      reachability: HostReachability.unreachable,
      manual: true,
    );
  }

  static int _parsePort(String value) {
    final port = int.tryParse(value);
    if (port == null || port < 1 || port > 65535) {
      throw const FormatException('Enter a port from 1 to 65535');
    }
    return port;
  }

  static bool _validHost(String host) {
    final address = InternetAddress.tryParse(host);
    if (address != null) return _isPrivate(address);
    return host.length <= 253 &&
        RegExp(
          r'^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$',
        ).hasMatch(host);
  }

  static bool _isPrivate(InternetAddress address) {
    if (address.isLoopback || address.isLinkLocal) return true;
    final bytes = address.rawAddress;
    if (address.type == InternetAddressType.IPv4) {
      return bytes[0] == 10 ||
          (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
          (bytes[0] == 192 && bytes[1] == 168);
    }
    return (bytes[0] & 0xfe) == 0xfc;
  }
}
