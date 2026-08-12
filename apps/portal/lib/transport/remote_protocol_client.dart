import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../security/device_identity_store.dart';

class RemoteProtocolException implements Exception {
  const RemoteProtocolException(
    this.code,
    this.message, {
    this.retryable = false,
  });

  final String code;
  final String message;
  final bool retryable;

  @override
  String toString() => message;
}

abstract interface class PortalChannelFactory {
  Future<WebSocketChannel> connect(Uri endpoint, String tlsFingerprint);
}

class PinnedPortalChannelFactory implements PortalChannelFactory {
  const PinnedPortalChannelFactory();

  @override
  Future<WebSocketChannel> connect(Uri endpoint, String tlsFingerprint) async {
    var pinObserved = false;
    final client = HttpClient()
      ..badCertificateCallback = (certificate, _, _) {
        final digest = crypto.sha256.convert(certificate.der).bytes;
        final actual = 'sha256:${base64Url.encode(digest).replaceAll('=', '')}';
        pinObserved = actual == tlsFingerprint;
        return pinObserved;
      };
    final channel = IOWebSocketChannel.connect(
      endpoint,
      customClient: client,
      connectTimeout: const Duration(seconds: 8),
      pingInterval: const Duration(seconds: 20),
    );
    await channel.ready;
    if (!pinObserved) {
      await channel.sink.close(4001, 'CERTIFICATE_PIN_MISMATCH');
      throw const RemoteProtocolException(
        'CERTIFICATE_PIN_MISMATCH',
        'The host certificate does not match the trusted pairing code',
      );
    }
    return channel;
  }
}

class RemoteProtocolClient {
  RemoteProtocolClient({PortalChannelFactory? channelFactory, Uuid? uuid})
    : _channelFactory = channelFactory ?? const PinnedPortalChannelFactory(),
      _uuid = uuid ?? const Uuid();

  final PortalChannelFactory _channelFactory;
  final Uuid _uuid;
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  final _events = StreamController<Map<String, dynamic>>.broadcast();
  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  String _sessionId = 'opening';

  Stream<Map<String, dynamic>> get events => _events.stream;
  bool get connected => _channel != null;
  String get sessionId => _sessionId;

  Future<void> open(Uri endpoint, String tlsFingerprint) async {
    await close();
    final channel = await _channelFactory.connect(endpoint, tlsFingerprint);
    _channel = channel;
    _subscription = channel.stream.listen(
      _handleFrame,
      onError: (Object error, StackTrace stack) => _disconnect(error),
      onDone: () {
        final revoked =
            channel.closeCode == 4003 &&
            channel.closeReason == 'device-revoked';
        _disconnect(
          revoked
              ? const RemoteProtocolException(
                  'DEVICE_REVOKED',
                  'This device was revoked on the host',
                )
              : const RemoteProtocolException(
                  'DISCONNECTED',
                  'Host disconnected',
                  retryable: true,
                ),
        );
      },
    );
  }

  Future<Map<String, dynamic>> request(
    String type,
    Map<String, Object?> payload, {
    Duration timeout = const Duration(seconds: 12),
  }) async {
    final channel = _channel;
    if (channel == null) {
      throw const RemoteProtocolException(
        'DISCONNECTED',
        'Connect to a host first',
        retryable: true,
      );
    }
    final requestId = _uuid.v4();
    final completer = Completer<Map<String, dynamic>>();
    _pending[requestId] = completer;
    channel.sink.add(
      jsonEncode({
        'protocolVersion': 1,
        'sessionId': _sessionId,
        'kind': 'request',
        'type': type,
        'requestId': requestId,
        'payload': payload,
      }),
    );
    try {
      return await completer.future.timeout(timeout);
    } on TimeoutException {
      throw const RemoteProtocolException(
        'TIMEOUT',
        'The host did not respond in time',
        retryable: true,
      );
    } finally {
      _pending.remove(requestId);
    }
  }

  Future<List<String>> authenticate({
    required DeviceIdentity identity,
    required String hostPublicKey,
    required String hostFingerprint,
    String? resumeSessionId,
  }) async {
    if (_hostFingerprint(hostPublicKey) != hostFingerprint) {
      throw const RemoteProtocolException(
        'HOST_IDENTITY_MISMATCH',
        'The trusted host identity changed',
      );
    }
    final challenge = '${_uuid.v4()}${_uuid.v4()}';
    final response = await request('session.hello', {
      'supportedProtocol': {'min': 1, 'max': 1},
      'appVersion': '0.1.0',
      'deviceId': identity.deviceId,
      'challenge': challenge,
      'signature': await identity.sign(challenge),
      'resumeSessionId': ?resumeSessionId,
    });
    final payload = _payload(response);
    final publicKeyBytes = _ed25519PublicBytes(hostPublicKey);
    final signature = Signature(
      base64Url.decode(base64Url.normalize(payload['signature'] as String)),
      publicKey: SimplePublicKey(publicKeyBytes, type: KeyPairType.ed25519),
    );
    if (!await Ed25519().verify(utf8.encode(challenge), signature: signature)) {
      throw const RemoteProtocolException(
        'HOST_IDENTITY_MISMATCH',
        'The host identity signature is invalid',
      );
    }
    _sessionId = payload['sessionId'] as String;
    await request('session.ready', const {'ready': true});
    return (payload['capabilities'] as List).cast<String>();
  }

  void acknowledge(String streamId, int sequence) {
    _channel?.sink.add(
      jsonEncode({
        'protocolVersion': 1,
        'sessionId': _sessionId,
        'kind': 'ack',
        'type': 'stream.ack',
        'streamId': streamId,
        'ack': sequence,
      }),
    );
  }

  Future<void> close() async {
    final channel = _channel;
    _channel = null;
    _sessionId = 'opening';
    await _subscription?.cancel();
    _subscription = null;
    await channel?.sink.close(1000, 'client-close');
    _failPending(
      const RemoteProtocolException(
        'DISCONNECTED',
        'Host disconnected',
        retryable: true,
      ),
    );
  }

  void _handleFrame(Object? raw) {
    if (raw is! String || utf8.encode(raw).length > 6 * 1024 * 1024) {
      _disconnect(
        const RemoteProtocolException(
          'MALFORMED_FRAME',
          'Host sent an invalid frame',
        ),
      );
      return;
    }
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) throw const FormatException();
      final envelope = decoded.cast<String, dynamic>();
      if (envelope['protocolVersion'] != 1 ||
          envelope['sessionId'] is! String ||
          envelope['type'] is! String ||
          (_sessionId != 'opening' && envelope['sessionId'] != _sessionId)) {
        throw const FormatException();
      }
      final kind = envelope['kind'];
      if (kind == 'response') {
        final requestId = envelope['requestId'];
        if (requestId is! String) throw const FormatException();
        if (envelope['type'] == 'request.error') {
          final payload = _payload(envelope);
          _pending[requestId]?.completeError(
            RemoteProtocolException(
              payload['code'] as String,
              payload['message'] as String,
              retryable: payload['retryable'] == true,
            ),
          );
        } else {
          _pending[requestId]?.complete(envelope);
        }
      } else if (kind == 'event') {
        _events.add(envelope);
      } else {
        throw const FormatException();
      }
    } catch (error) {
      _disconnect(
        const RemoteProtocolException(
          'MALFORMED_FRAME',
          'Host sent an invalid frame',
        ),
      );
    }
  }

  void _disconnect(Object error) {
    _channel = null;
    _sessionId = 'opening';
    _failPending(error);
    if (!_events.isClosed) {
      _events.add({
        'kind': 'local',
        'type': 'session.disconnected',
        'error': error,
      });
    }
  }

  void _failPending(Object error) {
    for (final completer in _pending.values) {
      if (!completer.isCompleted) completer.completeError(error);
    }
    _pending.clear();
  }

  static Map<String, dynamic> _payload(Map<String, dynamic> envelope) {
    final payload = envelope['payload'];
    if (payload is! Map) {
      throw const FormatException('Response payload is invalid');
    }
    return payload.cast<String, dynamic>();
  }

  static String _hostFingerprint(String pem) {
    final digest = crypto.sha256.convert(utf8.encode(pem)).bytes;
    return 'sha256:${base64Url.encode(digest).replaceAll('=', '')}';
  }

  static List<int> _ed25519PublicBytes(String pem) {
    final body = pem
        .replaceAll('-----BEGIN PUBLIC KEY-----', '')
        .replaceAll('-----END PUBLIC KEY-----', '')
        .replaceAll(RegExp(r'\s'), '');
    final der = base64.decode(body);
    if (der.length != 44) {
      throw const FormatException('Host public key is invalid');
    }
    return der.sublist(12);
  }

  static Map<String, dynamic> payloadOf(Map<String, dynamic> envelope) =>
      _payload(envelope);
}
