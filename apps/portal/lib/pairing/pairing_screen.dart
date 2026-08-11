import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../security/device_identity_store.dart';
import 'pairing_controller.dart';

class PairingScreen extends StatefulWidget {
  const PairingScreen({
    required this.controller,
    required this.onPaired,
    super.key,
  });

  final PairingController controller;
  final ValueChanged<PairedHostCredential> onPaired;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final scanner = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
  );
  final manualController = TextEditingController();
  bool handledScan = false;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_refresh);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_refresh);
    widget.controller.dispose();
    scanner.dispose();
    manualController.dispose();
    super.dispose();
  }

  void _refresh() => setState(() {});

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return Scaffold(
      appBar: AppBar(title: const Text('Pair a host')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 620),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: switch (controller.phase) {
                PairingPhase.idle => _scanner(),
                PairingPhase.connecting => const _PairingMessage(
                  icon: Icons.sync_rounded,
                  title: 'Verifying host identity',
                  body:
                      'Portal is checking the certificate and one-time pairing material',
                  progress: true,
                ),
                PairingPhase.verifyIdentity => _verification(),
                PairingPhase.awaitingApproval => _awaitingApproval(),
                PairingPhase.paired => const _PairingMessage(
                  icon: Icons.check_circle_outline_rounded,
                  title: 'Host paired',
                  body:
                      'Protected device credentials are ready for future connections',
                ),
                PairingPhase.failed => _failed(),
              },
            ),
          ),
        ),
      ),
    );
  }

  Widget _scanner() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        'Scan the code shown by Daintree',
        style: Theme.of(
          context,
        ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 8),
      const Text('On the desktop, open Settings → Remote access → Pair device'),
      const SizedBox(height: 20),
      Expanded(
        child: ClipRRect(
          borderRadius: BorderRadius.circular(24),
          child: Semantics(
            label: 'QR code scanner',
            child: MobileScanner(
              controller: scanner,
              onDetect: (capture) {
                if (handledScan) return;
                final value = capture.barcodes.firstOrNull?.rawValue;
                if (value == null) return;
                handledScan = true;
                unawaited(scanner.stop());
                unawaited(widget.controller.scan(value));
              },
            ),
          ),
        ),
      ),
      const SizedBox(height: 16),
      ExpansionTile(
        title: const Text('Enter pairing data manually'),
        children: [
          TextField(
            controller: manualController,
            minLines: 2,
            maxLines: 5,
            decoration: const InputDecoration(labelText: 'Pairing data'),
          ),
          const SizedBox(height: 10),
          FilledButton(
            onPressed: () => widget.controller.scan(manualController.text),
            child: const Text('Verify pairing data'),
          ),
        ],
      ),
    ],
  );

  Widget _verification() => Column(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      const Icon(Icons.verified_user_outlined, size: 52),
      const SizedBox(height: 20),
      Text(
        'Do both screens show this code?',
        style: Theme.of(
          context,
        ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 18),
      Semantics(
        label: 'Verification code ${widget.controller.verificationCode}',
        child: SelectableText(
          widget.controller.verificationCode!,
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 42,
            fontWeight: FontWeight.w700,
            letterSpacing: 8,
          ),
        ),
      ),
      const SizedBox(height: 16),
      const Text(
        'If the codes differ, cancel. A mismatch can mean another device intercepted the connection.',
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 28),
      FilledButton(
        onPressed: widget.controller.confirmMatchingCode,
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
        child: const Text('Codes match'),
      ),
      const SizedBox(height: 8),
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel pairing'),
      ),
    ],
  );

  Widget _awaitingApproval() => Column(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      const Icon(Icons.phonelink_lock_rounded, size: 52),
      const SizedBox(height: 20),
      Text(
        'Approve this device on the host',
        style: Theme.of(
          context,
        ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 10),
      const Text(
        'Daintree will show the same code and the capabilities requested by this device.',
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 26),
      FilledButton.icon(
        onPressed: () async {
          final credential = await widget.controller.checkApproval();
          if (credential != null && mounted) widget.onPaired(credential);
        },
        icon: const Icon(Icons.refresh_rounded),
        label: const Text('Check approval'),
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
      ),
    ],
  );

  Widget _failed() => _PairingMessage(
    icon: Icons.error_outline_rounded,
    title: 'Pairing failed',
    body: widget.controller.errorMessage ?? 'Try a fresh code from the host',
    action: TextButton(
      onPressed: () => Navigator.pop(context),
      child: const Text('Try another code'),
    ),
  );
}

class _PairingMessage extends StatelessWidget {
  const _PairingMessage({
    required this.icon,
    required this.title,
    required this.body,
    this.progress = false,
    this.action,
  });

  final IconData icon;
  final String title;
  final String body;
  final bool progress;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      Icon(icon, size: 52),
      const SizedBox(height: 20),
      Text(
        title,
        style: Theme.of(
          context,
        ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 10),
      Text(body, textAlign: TextAlign.center),
      if (progress) ...[
        const SizedBox(height: 22),
        if (MediaQuery.disableAnimationsOf(context))
          const Icon(Icons.hourglass_top_rounded, size: 30)
        else
          const CircularProgressIndicator(),
      ],
      if (action != null) ...[const SizedBox(height: 18), action!],
    ],
  );
}

extension _FirstOrNull<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
