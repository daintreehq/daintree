import 'package:flutter/foundation.dart';

import '../discovery/discovered_host.dart';
import '../security/device_identity_store.dart';
import '../transport/remote_protocol_client.dart';
import 'pairing_bootstrap.dart';

enum PairingPhase {
  idle,
  connecting,
  verifyIdentity,
  awaitingApproval,
  paired,
  failed,
}

class PairingController extends ChangeNotifier {
  PairingController({
    required this.identityStore,
    required this.hostStore,
    required this.client,
    required this.platform,
  });

  final DeviceIdentityStore identityStore;
  final PairedHostStore hostStore;
  final RemoteProtocolClient client;
  final String platform;

  PairingPhase phase = PairingPhase.idle;
  PairingBootstrap? bootstrap;
  String? errorMessage;
  Uri? _endpoint;
  DeviceIdentity? _identity;

  String? get verificationCode => bootstrap?.verificationCode;

  Future<void> scan(
    String raw, {
    String deviceName = 'My Portal device',
  }) async {
    phase = PairingPhase.connecting;
    errorMessage = null;
    notifyListeners();
    try {
      final parsed = PairingBootstrap.parse(raw);
      if (parsed.expired) {
        throw const FormatException('This pairing code has expired');
      }
      final endpoint = _selectEndpoint(parsed.endpointHints);
      final identity = await identityStore.loadOrCreate();
      await client.open(endpoint, parsed.tlsFingerprint);
      final response = await client.request('hosts.pair.begin', {
        'pairingId': parsed.pairingId,
        'oneTimeSecret': parsed.oneTimeSecret,
        'deviceId': identity.deviceId,
        'deviceName': deviceName,
        'platform': platform,
        'devicePublicKey': identity.publicKeyPem,
      });
      final payload = RemoteProtocolClient.payloadOf(response);
      if (payload['state'] != 'match-required' ||
          payload['pairingId'] != parsed.pairingId ||
          payload['verificationCode'] != parsed.verificationCode) {
        throw const RemoteProtocolException(
          'HOST_IDENTITY_MISMATCH',
          'The code shown by the host does not match this phone',
        );
      }
      bootstrap = parsed;
      _endpoint = endpoint;
      _identity = identity;
      phase = PairingPhase.verifyIdentity;
    } catch (error) {
      phase = PairingPhase.failed;
      errorMessage = _message(error);
      await client.close();
    }
    notifyListeners();
  }

  Future<void> confirmMatchingCode() async {
    final parsed = bootstrap;
    final identity = _identity;
    if (parsed == null ||
        identity == null ||
        phase != PairingPhase.verifyIdentity) {
      return;
    }
    phase = PairingPhase.connecting;
    notifyListeners();
    try {
      final proof = await identity.sign(
        '${parsed.pairingId}.${identity.deviceId}.${parsed.verificationCode}',
      );
      final response = await client.request('hosts.pair.verify', {
        'pairingId': parsed.pairingId,
        'verificationProof': proof,
      });
      final payload = RemoteProtocolClient.payloadOf(response);
      if (payload['state'] != 'awaiting-approval' ||
          payload['pairingId'] != parsed.pairingId) {
        throw const RemoteProtocolException(
          'PAIRING_REJECTED',
          'The host rejected this pairing request',
        );
      }
      phase = PairingPhase.awaitingApproval;
    } catch (error) {
      phase = PairingPhase.failed;
      errorMessage = _message(error);
    }
    notifyListeners();
  }

  Future<PairedHostCredential?> checkApproval({
    String displayName = 'Daintree host',
  }) async {
    final parsed = bootstrap;
    final endpoint = _endpoint;
    final identity = _identity;
    if (parsed == null || endpoint == null || identity == null) return null;
    try {
      await client.close();
      await client.open(endpoint, parsed.tlsFingerprint);
      final capabilities = await client.authenticate(
        identity: identity,
        hostPublicKey: parsed.hostPublicKey,
        hostFingerprint: parsed.hostFingerprint,
      );
      final credential = PairedHostCredential(
        hostId: parsed.hostId,
        displayName: displayName,
        host: endpoint.host,
        port: endpoint.port,
        hostPublicKey: parsed.hostPublicKey,
        hostFingerprint: parsed.hostFingerprint,
        tlsFingerprint: parsed.tlsFingerprint,
        capabilities: capabilities,
      );
      await hostStore.save(credential);
      phase = PairingPhase.paired;
      errorMessage = null;
      notifyListeners();
      return credential;
    } on RemoteProtocolException catch (error) {
      if (error.code == 'AUTHENTICATION_FAILED') {
        phase = PairingPhase.awaitingApproval;
        errorMessage = null;
      } else if (error.code == 'DEVICE_REVOKED') {
        phase = PairingPhase.failed;
        errorMessage = 'This device was revoked on the host';
      } else {
        phase = PairingPhase.failed;
        errorMessage = error.message;
      }
      notifyListeners();
      return null;
    }
  }

  Uri _selectEndpoint(List<String> hints) {
    for (final hint in hints) {
      final uri = Uri.tryParse(hint);
      if (uri != null &&
          uri.scheme == 'wss' &&
          uri.host.isNotEmpty &&
          uri.hasPort) {
        try {
          final endpoint = uri.host.contains(':')
              ? '[${uri.host}]:${uri.port}'
              : '${uri.host}:${uri.port}';
          ManualEndpointParser.parse(endpoint);
          return uri;
        } on FormatException {
          continue;
        }
      }
    }
    throw const FormatException(
      'The host did not provide a secure private-network endpoint',
    );
  }

  String _message(Object error) => switch (error) {
    FormatException(:final message) => message.toString(),
    RemoteProtocolException(:final message) => message,
    _ => 'Pairing could not be completed. Check both devices and try again',
  };

  @override
  void dispose() {
    client.close();
    super.dispose();
  }
}
