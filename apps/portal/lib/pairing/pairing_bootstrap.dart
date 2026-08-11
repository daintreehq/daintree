import 'dart:convert';

class PairingBootstrap {
  const PairingBootstrap({
    required this.pairingId,
    required this.oneTimeSecret,
    required this.expiresAt,
    required this.hostId,
    required this.hostPublicKey,
    required this.hostFingerprint,
    required this.tlsFingerprint,
    required this.endpointHints,
    required this.protocolMin,
    required this.protocolMax,
    required this.verificationCode,
  });

  final String pairingId;
  final String oneTimeSecret;
  final DateTime expiresAt;
  final String hostId;
  final String hostPublicKey;
  final String hostFingerprint;
  final String tlsFingerprint;
  final List<String> endpointHints;
  final int protocolMin;
  final int protocolMax;
  final String verificationCode;

  bool get expired => !DateTime.now().isBefore(expiresAt);

  factory PairingBootstrap.parse(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! Map) {
      throw const FormatException('This is not a Daintree pairing code');
    }
    final value = decoded.cast<String, dynamic>();
    final host = (value['host'] as Map?)?.cast<String, dynamic>();
    final protocol = (value['protocol'] as Map?)?.cast<String, dynamic>();
    final endpoints = (value['endpointHints'] as List?)?.cast<String>();
    if (!_hasOnlyKeys(value, const {
          'pairingId',
          'oneTimeSecret',
          'expiresAt',
          'host',
          'tlsCertificateFingerprint',
          'endpointHints',
          'protocol',
          'verificationCode',
        }) ||
        !_hasOnlyKeys(host, const {
          'hostId',
          'publicKey',
          'fingerprint',
          'createdAt',
        }) ||
        !_hasOnlyKeys(protocol, const {'min', 'max'})) {
      throw const FormatException('Pairing code contains unsupported fields');
    }
    final result = PairingBootstrap(
      pairingId: _requiredString(value, 'pairingId'),
      oneTimeSecret: _requiredString(value, 'oneTimeSecret'),
      expiresAt: DateTime.fromMillisecondsSinceEpoch(
        _requiredInt(value, 'expiresAt'),
      ),
      hostId: _requiredString(host, 'hostId'),
      hostPublicKey: _requiredString(host, 'publicKey'),
      hostFingerprint: _requiredString(host, 'fingerprint'),
      tlsFingerprint: _requiredString(value, 'tlsCertificateFingerprint'),
      endpointHints: endpoints ?? const [],
      protocolMin: _requiredInt(protocol, 'min'),
      protocolMax: _requiredInt(protocol, 'max'),
      verificationCode: _requiredString(value, 'verificationCode'),
    );
    if (result.oneTimeSecret.length < 32 ||
        result.endpointHints.isEmpty ||
        result.endpointHints.length > 8 ||
        !RegExp(r'^\d{6}$').hasMatch(result.verificationCode) ||
        !RegExp(
          r'^sha256:[A-Za-z0-9_-]{43}$',
        ).hasMatch(result.hostFingerprint) ||
        !RegExp(
          r'^sha256:[A-Za-z0-9_-]{43}$',
        ).hasMatch(result.tlsFingerprint) ||
        result.protocolMin > 1 ||
        result.protocolMax < 1) {
      throw const FormatException(
        'This pairing code is invalid or incompatible',
      );
    }
    return result;
  }

  static String _requiredString(Map<String, dynamic>? value, String key) {
    final result = value?[key];
    if (result is! String || result.isEmpty) {
      throw const FormatException('Pairing code is incomplete');
    }
    return result;
  }

  static int _requiredInt(Map<String, dynamic>? value, String key) {
    final result = value?[key];
    if (result is! int) {
      throw const FormatException('Pairing code is incomplete');
    }
    return result;
  }

  static bool _hasOnlyKeys(Map<String, dynamic>? value, Set<String> allowed) =>
      value != null && value.keys.every(allowed.contains);
}
