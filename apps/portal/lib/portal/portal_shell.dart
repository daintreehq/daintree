import 'dart:async';

import 'package:flutter/material.dart';
import '../console/portal_terminal.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'portal_controller.dart';

class PortalShell extends StatefulWidget {
  const PortalShell({required this.controller, super.key});

  final PortalController controller;

  @override
  State<PortalShell> createState() => _PortalShellState();
}

class _PortalShellState extends State<PortalShell> with WidgetsBindingObserver {
  final composerController = TextEditingController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(_refresh);
    unawaited(widget.controller.connect());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(_refresh);
    widget.controller.dispose();
    composerController.dispose();
    super.dispose();
  }

  void _refresh() {
    if (composerController.text != widget.controller.composerText) {
      composerController.value = TextEditingValue(
        text: widget.controller.composerText,
        selection: TextSelection.collapsed(
          offset: widget.controller.composerText.length,
        ),
      );
    }
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(widget.controller.resume());
    } else if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      unawaited(widget.controller.pause());
    }
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return Scaffold(
      appBar: AppBar(
        title: Text(controller.credential.displayName),
        actions: [
          Semantics(
            label: 'Connection ${_connectionLabel(controller.connectionState)}',
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  Icon(_connectionIcon(controller.connectionState), size: 18),
                  const SizedBox(width: 7),
                  Text(_connectionLabel(controller.connectionState)),
                ],
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (controller.statusMessage != null)
              _StatusBanner(
                message: controller.statusMessage!,
                canRetry:
                    controller.connectionState == PortalConnectionState.offline,
                onRetry: controller.connect,
              ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  if (constraints.maxWidth >= 980) {
                    return Row(
                      children: [
                        SizedBox(
                          width: 280,
                          child: _ProjectsPane(controller: controller),
                        ),
                        const VerticalDivider(width: 1),
                        SizedBox(
                          width: 330,
                          child: _AgentsPane(controller: controller),
                        ),
                        const VerticalDivider(width: 1),
                        Expanded(
                          child: _ConsolePane(
                            controller: controller,
                            composer: composerController,
                          ),
                        ),
                      ],
                    );
                  }
                  if (controller.selectedAgent != null) {
                    return _ConsolePane(
                      controller: controller,
                      composer: composerController,
                      onBack: () {
                        unawaited(controller.closeAgent());
                      },
                    );
                  }
                  if (controller.selectedProject != null) {
                    return _AgentsPane(
                      controller: controller,
                      onBack: () {
                        unawaited(controller.closeProject());
                      },
                    );
                  }
                  return _ProjectsPane(controller: controller);
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _connectionLabel(PortalConnectionState state) => switch (state) {
    PortalConnectionState.offline => 'Offline',
    PortalConnectionState.connecting => 'Connecting',
    PortalConnectionState.loading => 'Loading',
    PortalConnectionState.ready => 'Live',
    PortalConnectionState.degraded => 'Degraded',
    PortalConnectionState.incompatible => 'Update required',
    PortalConnectionState.revoked => 'Revoked',
  };

  IconData _connectionIcon(PortalConnectionState state) => switch (state) {
    PortalConnectionState.ready => Icons.link_rounded,
    PortalConnectionState.connecting ||
    PortalConnectionState.loading => Icons.sync_rounded,
    PortalConnectionState.degraded => Icons.warning_amber_rounded,
    PortalConnectionState.revoked => Icons.block_rounded,
    PortalConnectionState.incompatible => Icons.system_update_rounded,
    PortalConnectionState.offline => Icons.link_off_rounded,
  };
}

class _ProjectsPane extends StatefulWidget {
  const _ProjectsPane({required this.controller});

  final PortalController controller;

  @override
  State<_ProjectsPane> createState() => _ProjectsPaneState();
}

class _ProjectsPaneState extends State<_ProjectsPane> {
  String query = '';

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final filtered = controller.projects
        .where(
          (project) => project.name.toLowerCase().contains(query.toLowerCase()),
        )
        .toList();
    return _Pane(
      eyebrow: 'PROJECTS',
      title: 'Choose a project',
      child: Column(
        children: [
          if (controller.projects.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
              child: TextField(
                onChanged: (value) => setState(() => query = value),
                textInputAction: TextInputAction.search,
                decoration: const InputDecoration(
                  labelText: 'Search projects',
                  prefixIcon: Icon(Icons.search_rounded),
                  isDense: true,
                ),
              ),
            ),
          Expanded(
            child: switch (controller.connectionState) {
              PortalConnectionState.connecting || PortalConnectionState.loading
                  when controller.projects.isEmpty =>
                const _LoadingRows(),
              _ when controller.projects.isEmpty => const _EmptyMessage(
                icon: Icons.folder_open_rounded,
                message: 'Open or add a project on the desktop host',
              ),
              _ when filtered.isEmpty => const _EmptyMessage(
                icon: Icons.search_off_rounded,
                message: 'Try a different project name',
              ),
              _ => ListView.separated(
                itemCount: filtered.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (context, index) {
                  final project = filtered[index];
                  return Semantics(
                    button: true,
                    selected: controller.selectedProject?.id == project.id,
                    label:
                        '${project.name}, ${project.status}, ${project.waiting} waiting',
                    child: ListTile(
                      minTileHeight: 60,
                      selected: controller.selectedProject?.id == project.id,
                      leading: _ProjectIcon(project: project),
                      title: Text(
                        project.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(project.status),
                      trailing: project.waiting > 0
                          ? Badge(
                              label: Text('${project.waiting}'),
                              child: const Icon(Icons.more_horiz_rounded),
                            )
                          : const Icon(Icons.chevron_right_rounded),
                      onTap: () => controller.openProject(project.id),
                    ),
                  );
                },
              ),
            },
          ),
        ],
      ),
    );
  }
}

class _ProjectIcon extends StatelessWidget {
  const _ProjectIcon({required this.project});

  final PortalProject project;

  @override
  Widget build(BuildContext context) {
    if (project.iconKind == 'emoji' && project.iconValue != null) {
      return Text(project.iconValue!, style: const TextStyle(fontSize: 24));
    }
    if (project.iconKind == 'sanitized-svg' && project.iconValue != null) {
      return SvgPicture.string(
        project.iconValue!,
        width: 24,
        height: 24,
        semanticsLabel: '${project.name} project icon',
        placeholderBuilder: (_) => const Icon(Icons.folder_outlined),
      );
    }
    return const Icon(Icons.folder_outlined);
  }
}

class _AgentsPane extends StatelessWidget {
  const _AgentsPane({required this.controller, this.onBack});

  final PortalController controller;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final project = controller.selectedProject;
    return _Pane(
      eyebrow: 'WORKTREES / AGENTS',
      title: project?.name ?? 'Select a project',
      onBack: onBack,
      child: project == null
          ? const _EmptyMessage(
              icon: Icons.arrow_back_rounded,
              message: 'Choose a project to see its worktrees',
            )
          : controller.worktrees.isEmpty
          ? const _EmptyMessage(
              icon: Icons.account_tree_outlined,
              message: 'Create a worktree on the desktop host',
            )
          : ListView.builder(
              itemCount: controller.worktrees.length,
              itemBuilder: (context, index) {
                final worktree = controller.worktrees[index];
                final agents = controller.agents
                    .where((agent) => agent.worktreeId == worktree.id)
                    .toList();
                return ExpansionTile(
                  initiallyExpanded:
                      worktree.isCurrent ||
                      controller.selectedWorktree?.id == worktree.id,
                  leading: Icon(
                    worktree.availability == 'available'
                        ? Icons.account_tree_rounded
                        : Icons.cloud_off_rounded,
                  ),
                  title: Text(worktree.name),
                  subtitle: Text(
                    [
                      if (worktree.branch != null) worktree.branch!,
                      if (worktree.isMain) 'Main worktree',
                      '${agents.length} ${agents.length == 1 ? 'agent' : 'agents'}',
                      if (worktree.availability != 'available')
                        worktree.availability,
                    ].join(' · '),
                  ),
                  onExpansionChanged: (expanded) {
                    if (expanded) controller.selectWorktree(worktree);
                  },
                  children: [
                    if (agents.isEmpty)
                      const ListTile(
                        minTileHeight: 56,
                        title: Text('Launch an agent to start work'),
                      ),
                    for (final agent in agents)
                      ListTile(
                        minTileHeight: 60,
                        selected:
                            controller.selectedAgent?.panelId == agent.panelId,
                        leading: Icon(_agentIcon(agent.state)),
                        title: Text(
                          agent.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: Text(_agentDetails(agent)),
                        trailing: const Icon(Icons.chevron_right_rounded),
                        onTap: () => controller.openAgent(agent),
                      ),
                    if (worktree.availability == 'available')
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
                        child: OutlinedButton.icon(
                          onPressed: controller.readOnly
                              ? null
                              : () => _showLaunch(context, worktree),
                          icon: const Icon(Icons.add_rounded),
                          label: const Text('Launch agent'),
                          style: OutlinedButton.styleFrom(
                            minimumSize: const Size.fromHeight(48),
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
    );
  }

  IconData _agentIcon(String state) => switch (state) {
    'waiting' => Icons.pause_circle_outline_rounded,
    'completed' => Icons.check_circle_outline_rounded,
    'exited' || 'unavailable' => Icons.cancel_outlined,
    _ => Icons.terminal_rounded,
  };

  String _agentState(PortalAgent agent) => switch (agent.continuityState) {
    'restored-screen' => 'Restored screen',
    'unavailable' => 'Unavailable',
    _ => agent.state,
  };

  String _agentDetails(PortalAgent agent) {
    final details = <String>[agent.displayName, _agentState(agent)];
    if (agent.waitingReason != null) details.add(agent.waitingReason!);
    if (agent.spawnedRemotely) details.add('Opened from Portal');
    if (agent.stateSince != null) {
      final age = DateTime.now().difference(
        DateTime.fromMillisecondsSinceEpoch(agent.stateSince!),
      );
      if (!age.isNegative) details.add(_shortAge(age));
    }
    return details.join(' · ');
  }

  String _shortAge(Duration age) {
    if (age.inDays > 0) return '${age.inDays}d';
    if (age.inHours > 0) return '${age.inHours}h';
    if (age.inMinutes > 0) return '${age.inMinutes}m';
    return 'Now';
  }

  Future<void> _showLaunch(
    BuildContext context,
    PortalWorktree worktree,
  ) async {
    final choices = await controller.launchableAgents(worktree);
    if (!context.mounted) return;
    if (choices.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('No supported agents are configured on this host'),
        ),
      );
      return;
    }
    final prompt = TextEditingController();
    final name = TextEditingController();
    var selected = choices.first;
    String? selectedModel = (selected['modelIds'] as List)
        .cast<String>()
        .firstOrNull;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) => AlertDialog(
          title: const Text('Launch agent?'),
          content: SizedBox(
            width: 430,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${controller.selectedProject!.name} / ${worktree.name}',
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<Map<String, dynamic>>(
                    initialValue: selected,
                    decoration: const InputDecoration(labelText: 'Agent'),
                    items: [
                      for (final choice in choices)
                        DropdownMenuItem(
                          value: choice,
                          child: Text(choice['displayName'] as String),
                        ),
                    ],
                    onChanged: (value) => setState(() {
                      selected = value!;
                      selectedModel = (selected['modelIds'] as List)
                          .cast<String>()
                          .firstOrNull;
                    }),
                  ),
                  const SizedBox(height: 12),
                  InputDecorator(
                    decoration: const InputDecoration(labelText: 'Preset'),
                    child: const Text('Host default'),
                  ),
                  if ((selected['modelIds'] as List).isNotEmpty) ...[
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: selectedModel,
                      decoration: const InputDecoration(labelText: 'Model'),
                      items: [
                        for (final modelId
                            in (selected['modelIds'] as List).cast<String>())
                          DropdownMenuItem(
                            value: modelId,
                            child: Text(modelId),
                          ),
                      ],
                      onChanged: (value) =>
                          setState(() => selectedModel = value),
                    ),
                  ],
                  const SizedBox(height: 12),
                  TextField(
                    controller: name,
                    maxLength: 256,
                    decoration: const InputDecoration(
                      labelText: 'Name (optional)',
                    ),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: prompt,
                    minLines: 2,
                    maxLines: 5,
                    decoration: const InputDecoration(
                      labelText: 'Initial prompt (optional)',
                    ),
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Launch agent'),
            ),
          ],
        ),
      ),
    );
    if (confirmed == true) {
      await controller.launchAgent(
        worktree: worktree,
        agentId: selected['agentId'] as String,
        prompt: prompt.text,
        modelId: selectedModel,
        name: name.text,
      );
      await controller.openProject(controller.selectedProject!.id);
    }
    prompt.dispose();
    name.dispose();
  }
}

extension _FirstOrNull<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

class _ConsolePane extends StatelessWidget {
  const _ConsolePane({
    required this.controller,
    required this.composer,
    this.onBack,
  });

  final PortalController controller;
  final TextEditingController composer;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final agent = controller.selectedAgent;
    return _Pane(
      eyebrow: 'LIVE CONSOLE',
      title: agent?.title ?? 'Select an agent',
      onBack: onBack,
      child: agent == null
          ? const _EmptyMessage(
              icon: Icons.terminal_rounded,
              message: 'Open an agent to observe its console',
            )
          : Column(
              children: [
                if (controller.consoleStale)
                  const MaterialBanner(
                    content: Text(
                      'Showing the last received console. Sending is disabled until resync completes',
                    ),
                    actions: [SizedBox.shrink()],
                  ),
                Expanded(
                  child: PortalTerminalView(
                    model: controller.consoleRenderer,
                    semanticsLabel:
                        'Read-only console output for ${agent.title}',
                    emptyMessage: 'Waiting for console output…',
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Expanded(
                        child: TextField(
                          controller: composer,
                          enabled: !controller.readOnly && agent.acceptsPrompts,
                          minLines: 1,
                          maxLines: 5,
                          onChanged: controller.updateComposer,
                          decoration: InputDecoration(
                            labelText: 'Prompt ${agent.displayName}',
                            hintText: agent.acceptsPrompts
                                ? 'Send one complete prompt'
                                : 'This agent is not live',
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Semantics(
                        button: true,
                        label: 'Send prompt exactly once',
                        child: IconButton.filled(
                          onPressed:
                              controller.mutationPending ||
                                  controller.readOnly ||
                                  composer.text.trim().isEmpty
                              ? null
                              : controller.submitPrompt,
                          icon: controller.mutationPending
                              ? MediaQuery.disableAnimationsOf(context)
                                    ? const Icon(Icons.hourglass_top_rounded)
                                    : const SizedBox.square(
                                        dimension: 20,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                              : const Icon(Icons.arrow_upward_rounded),
                          tooltip: 'Send prompt',
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
    );
  }
}

class _Pane extends StatelessWidget {
  const _Pane({
    required this.eyebrow,
    required this.title,
    required this.child,
    this.onBack,
  });

  final String eyebrow;
  final String title;
  final Widget child;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        child: Row(
          children: [
            if (onBack != null)
              IconButton(
                onPressed: onBack,
                icon: const Icon(Icons.arrow_back_rounded),
                tooltip: 'Back',
              ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    eyebrow,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.4,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    title,
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      const Divider(height: 1),
      Expanded(child: child),
    ],
  );
}

class _StatusBanner extends StatelessWidget {
  const _StatusBanner({
    required this.message,
    required this.canRetry,
    required this.onRetry,
  });

  final String message;
  final bool canRetry;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Material(
    color: const Color(0xFFFFE7BE),
    child: SafeArea(
      bottom: false,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            const Icon(Icons.info_outline_rounded, size: 20),
            const SizedBox(width: 10),
            Expanded(child: Text(message)),
            if (canRetry)
              TextButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    ),
  );
}

class _LoadingRows extends StatelessWidget {
  const _LoadingRows();

  @override
  Widget build(BuildContext context) {
    final reducedMotion = MediaQuery.disableAnimationsOf(context);
    return ListView.builder(
      itemCount: 4,
      itemBuilder: (_, index) => ListTile(
        minTileHeight: 62,
        leading: reducedMotion
            ? const Icon(Icons.hourglass_top_rounded)
            : const SizedBox.square(
                dimension: 22,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
        title: const Text('Loading from host…'),
      ),
    );
  }
}

class _EmptyMessage extends StatelessWidget {
  const _EmptyMessage({required this.icon, required this.message});

  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 34),
          const SizedBox(height: 14),
          Text(message, textAlign: TextAlign.center),
        ],
      ),
    ),
  );
}
