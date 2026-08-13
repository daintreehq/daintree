import 'dart:convert';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:daintree_portal/security/device_identity_store.dart';
import 'package:daintree_portal/theme/generated_daintree_appearance.dart';
import 'package:daintree_portal/theme/portal_appearance.dart';
import 'package:daintree_portal/theme/portal_theme.dart';
import 'package:daintree_portal/transport/remote_protocol_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> mutableGeneratedAppearance() =>
    jsonDecode(jsonEncode(generatedDaintreeAppearanceJson))
        as Map<String, Object?>;

void main() {
  group('PortalAppearance', () {
    test('the generated default parses into the shared semantic model', () {
      final appearance = generatedDaintreeAppearance;

      expect(appearance.themeId, isNotEmpty);
      expect(appearance.brightness, Brightness.dark);
      expect(appearance.surfaces.canvas, isNot(appearance.surfaces.panel));
      expect(
        appearance.terminal.background,
        isNot(appearance.terminal.foreground),
      );
      expect(appearance.terminal.red, isNot(appearance.terminal.brightRed));
    });

    test(
      'valid remote data uses the same model and preserves its semantic values',
      () {
        final json = mutableGeneratedAppearance();
        json['revision'] = 12;
        json['themeId'] = 'host-theme';
        json['displayName'] = 'Host theme';
        (json['surfaces']! as Map<String, dynamic>)['canvas'] = '#123456ff';
        (json['accent']! as Map<String, dynamic>)['primary'] = '#abcdef80';

        final appearance = PortalAppearance.parse(json);

        expect(appearance.revision, 12);
        expect(appearance.themeId, 'host-theme');
        expect(appearance.surfaces.canvas, const Color(0xFF123456));
        expect(appearance.accent.primary, const Color(0x80ABCDEF));
      },
    );

    test(
      'missing, unknown, malformed, partial, and extended snapshots retain the fallback',
      () {
        final validJson = mutableGeneratedAppearance()..['revision'] = 8;
        final lastValid = PortalAppearance.parse(validJson);
        final unknownVersion = mutableGeneratedAppearance()..['version'] = 99;
        final malformedColor = mutableGeneratedAppearance();
        (malformedColor['text']! as Map<String, dynamic>)['primary'] =
            'var(--secret)';
        final partial = mutableGeneratedAppearance()..remove('terminal');
        final extended = mutableGeneratedAppearance()
          ..['rendererState'] = <String, Object?>{};

        for (final invalid in [
          null,
          unknownVersion,
          malformedColor,
          partial,
          extended,
          'not a map',
        ]) {
          expect(
            identical(
              PortalAppearance.resolve(invalid, fallback: lastValid),
              lastValid,
            ),
            isTrue,
          );
        }
      },
    );
  });

  group('RemoteAuthenticationResult', () {
    test('accepts a valid additive welcome appearance', () {
      final payload = <String, dynamic>{
        'capabilities': ['observe-projects'],
        'appearance': mutableGeneratedAppearance()..['revision'] = 5,
      };

      final result = RemoteAuthenticationResult.fromWelcomePayload(payload);

      expect(result.capabilities, ['observe-projects']);
      expect(result.appearance?.revision, 5);
    });

    test('supports an old host with no appearance', () {
      final result = RemoteAuthenticationResult.fromWelcomePayload({
        'capabilities': ['observe-projects'],
      });

      expect(result.capabilities, ['observe-projects']);
      expect(result.appearance, isNull);
    });

    test(
      'discards malformed appearance without discarding authenticated capabilities',
      () {
        final diagnostics = <String>[];
        final malformed = mutableGeneratedAppearance();
        (malformed['surfaces']! as Map<String, dynamic>)['canvas'] =
            'url(secret)';

        final result = RemoteAuthenticationResult.fromWelcomePayload({
          'capabilities': ['observe-projects', 'prompt-agents'],
          'appearance': malformed,
        }, onDiagnostic: diagnostics.add);

        expect(result.capabilities, contains('prompt-agents'));
        expect(result.appearance, isNull);
        expect(diagnostics, ['Ignored invalid host appearance snapshot']);
        expect(diagnostics.single, isNot(contains('url(secret)')));
      },
    );
  });

  group('RemoteProtocolClient authentication', () {
    test(
      'applies appearance only after host verification and readiness',
      () async {
        final hostPair = await Ed25519().newKeyPair();
        final hostPublic = await hostPair.extractPublicKey();
        final hostPem = _publicKeyPem(hostPublic.bytes);
        final client = _AuthenticationProbeClient(
          hostPair: hostPair,
          appearance: mutableGeneratedAppearance(),
        );
        expect(client.appearanceEventsTrusted, isFalse);

        final result = await client.authenticate(
          identity: await _deviceIdentity(),
          hostPublicKey: hostPem,
          hostFingerprint: _hostFingerprint(hostPem),
        );

        expect(client.requests, ['session.hello', 'session.ready']);
        expect(client.readyObserved, isTrue);
        expect(client.appearanceEventsTrusted, isTrue);
        expect(result.appearance?.themeId, generatedDaintreeAppearance.themeId);
        expect(
          result.appearance?.surfaces.canvas,
          generatedDaintreeAppearance.surfaces.canvas,
        );
        expect(result.capabilities, ['observe-projects']);
      },
    );

    test(
      'rejects appearance-bearing welcome with an invalid host signature',
      () async {
        final hostPair = await Ed25519().newKeyPair();
        final hostPublic = await hostPair.extractPublicKey();
        final hostPem = _publicKeyPem(hostPublic.bytes);
        final client = _AuthenticationProbeClient(
          hostPair: hostPair,
          appearance: {'version': 999},
          validSignature: false,
        );

        await expectLater(
          client.authenticate(
            identity: await _deviceIdentity(),
            hostPublicKey: hostPem,
            hostFingerprint: _hostFingerprint(hostPem),
          ),
          throwsA(
            isA<RemoteProtocolException>().having(
              (error) => error.code,
              'code',
              'HOST_IDENTITY_MISMATCH',
            ),
          ),
        );
        expect(client.requests, ['session.hello']);
        expect(client.readyObserved, isFalse);
        expect(client.appearanceEventsTrusted, isFalse);
        expect(client.diagnostics, isEmpty);
      },
    );

    test('does not parse appearance until readiness succeeds', () async {
      final hostPair = await Ed25519().newKeyPair();
      final hostPublic = await hostPair.extractPublicKey();
      final hostPem = _publicKeyPem(hostPublic.bytes);
      final client = _AuthenticationProbeClient(
        hostPair: hostPair,
        appearance: {'version': 999},
        failReadiness: true,
      );

      await expectLater(
        client.authenticate(
          identity: await _deviceIdentity(),
          hostPublicKey: hostPem,
          hostFingerprint: _hostFingerprint(hostPem),
        ),
        throwsA(
          isA<RemoteProtocolException>().having(
            (error) => error.code,
            'code',
            'SESSION_NOT_READY',
          ),
        ),
      );
      expect(client.requests, ['session.hello', 'session.ready']);
      expect(client.diagnostics, isEmpty);
    });

    test('keeps an old-host welcome usable without appearance', () async {
      final hostPair = await Ed25519().newKeyPair();
      final hostPublic = await hostPair.extractPublicKey();
      final hostPem = _publicKeyPem(hostPublic.bytes);
      final client = _AuthenticationProbeClient(hostPair: hostPair);

      final result = await client.authenticate(
        identity: await _deviceIdentity(),
        hostPublicKey: hostPem,
        hostFingerprint: _hostFingerprint(hostPem),
      );

      expect(result.appearance, isNull);
      expect(client.requests, ['session.hello', 'session.ready']);
    });
  });

  group('buildPortalTheme', () {
    test('maps supplied semantic colors directly into Material roles', () {
      final appearance = PortalAppearance.parse(mutableGeneratedAppearance());
      final theme = buildPortalTheme(appearance);

      expect(theme.colorScheme.primary, appearance.accent.primary);
      expect(theme.colorScheme.onPrimary, appearance.accent.foreground);
      expect(theme.colorScheme.surface, appearance.surfaces.canvas);
      expect(theme.colorScheme.surfaceContainer, appearance.surfaces.panel);
      expect(theme.colorScheme.error, appearance.status.danger.foreground);
      expect(theme.scaffoldBackgroundColor, appearance.surfaces.canvas);
      expect(
        theme.extension<PortalAppearanceTheme>()?.appearance,
        same(appearance),
      );
    });

    test(
      'high contrast strengthens structural borders without replacing semantic colors',
      () {
        final appearance = generatedDaintreeAppearance;
        final standard = buildPortalTheme(appearance);
        final highContrast = buildPortalTheme(appearance, highContrast: true);

        expect(highContrast.colorScheme.primary, standard.colorScheme.primary);
        expect(highContrast.colorScheme.surface, standard.colorScheme.surface);
        expect(highContrast.colorScheme.outline, appearance.borders.strong);
        expect(
          highContrast.dividerTheme.thickness,
          greaterThan(standard.dividerTheme.thickness!),
        );
      },
    );

    testWidgets(
      'theme application leaves device accessibility inputs authoritative',
      (tester) async {
        late MediaQueryData observed;
        await tester.pumpWidget(
          MaterialApp(
            theme: buildPortalTheme(generatedDaintreeAppearance),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(
                highContrast: true,
                disableAnimations: true,
                textScaler: const TextScaler.linear(1.8),
              ),
              child: Builder(
                builder: (context) {
                  observed = MediaQuery.of(context);
                  return const SizedBox();
                },
              ),
            ),
          ),
        );

        expect(observed.highContrast, isTrue);
        expect(observed.disableAnimations, isTrue);
        expect(observed.textScaler.scale(10), 18);
      },
    );
  });
}

class _AuthenticationProbeClient extends RemoteProtocolClient {
  factory _AuthenticationProbeClient({
    required KeyPair hostPair,
    Object? appearance,
    bool validSignature = true,
    bool failReadiness = false,
  }) {
    final diagnostics = <String>[];
    return _AuthenticationProbeClient._(
      hostPair: hostPair,
      appearance: appearance,
      validSignature: validSignature,
      failReadiness: failReadiness,
      diagnostics: diagnostics,
    );
  }

  _AuthenticationProbeClient._({
    required this.hostPair,
    required this.appearance,
    required this.validSignature,
    required this.failReadiness,
    required this.diagnostics,
  }) : super(diagnosticSink: diagnostics.add);

  final List<String> diagnostics;
  final KeyPair hostPair;
  final Object? appearance;
  final bool validSignature;
  final bool failReadiness;
  final requests = <String>[];
  bool readyObserved = false;

  @override
  Future<Map<String, dynamic>> request(
    String type,
    Map<String, Object?> payload, {
    Duration timeout = const Duration(seconds: 12),
  }) async {
    requests.add(type);
    if (type == 'session.ready') {
      if (failReadiness) {
        throw const RemoteProtocolException(
          'SESSION_NOT_READY',
          'Readiness rejected',
        );
      }
      readyObserved = true;
      return {
        'payload': const {'ready': true},
      };
    }
    final challenge = payload['challenge']! as String;
    final signature = validSignature
        ? await Ed25519().sign(utf8.encode(challenge), keyPair: hostPair)
        : Signature(
            List<int>.filled(64, 0),
            publicKey: await hostPair.extractPublicKey(),
          );
    return {
      'payload': {
        'sessionId': 'authenticated-session',
        'signature': base64Url.encode(signature.bytes).replaceAll('=', ''),
        'capabilities': ['observe-projects'],
        if (appearance != null) 'appearance': appearance,
      },
    };
  }
}

Future<DeviceIdentity> _deviceIdentity() async {
  final pair = await Ed25519().newKeyPair();
  final publicKey = await pair.extractPublicKey();
  return DeviceIdentity(
    deviceId: 'device-01',
    privateKey: await pair.extractPrivateKeyBytes(),
    publicKey: publicKey.bytes,
  );
}

String _publicKeyPem(List<int> publicKey) {
  const prefix = <int>[
    0x30,
    0x2a,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x03,
    0x21,
    0x00,
  ];
  return '-----BEGIN PUBLIC KEY-----\n${base64.encode([...prefix, ...publicKey])}\n-----END PUBLIC KEY-----\n';
}

String _hostFingerprint(String pem) {
  final digest = crypto.sha256.convert(utf8.encode(pem)).bytes;
  return 'sha256:${base64Url.encode(digest).replaceAll('=', '')}';
}
