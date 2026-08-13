import 'package:flutter/material.dart';

import 'generated_daintree_appearance.dart';

class PortalSurfaceColors {
  const PortalSurfaceColors({
    required this.grid,
    required this.chrome,
    required this.canvas,
    required this.toolbar,
    required this.panel,
    required this.elevatedPanel,
    required this.input,
    required this.inset,
    required this.hover,
    required this.active,
  });

  factory PortalSurfaceColors.parse(Object? value) {
    final map = _strictMap(value, const {
      'grid',
      'chrome',
      'canvas',
      'toolbar',
      'panel',
      'elevatedPanel',
      'input',
      'inset',
      'hover',
      'active',
    });
    return PortalSurfaceColors(
      grid: _color(map, 'grid'),
      chrome: _color(map, 'chrome'),
      canvas: _color(map, 'canvas'),
      toolbar: _color(map, 'toolbar'),
      panel: _color(map, 'panel'),
      elevatedPanel: _color(map, 'elevatedPanel'),
      input: _color(map, 'input'),
      inset: _color(map, 'inset'),
      hover: _color(map, 'hover'),
      active: _color(map, 'active'),
    );
  }

  final Color grid;
  final Color chrome;
  final Color canvas;
  final Color toolbar;
  final Color panel;
  final Color elevatedPanel;
  final Color input;
  final Color inset;
  final Color hover;
  final Color active;
}

class PortalTextColors {
  const PortalTextColors({
    required this.primary,
    required this.secondary,
    required this.muted,
    required this.placeholder,
    required this.inverse,
    required this.link,
  });

  factory PortalTextColors.parse(Object? value) {
    final map = _strictMap(value, const {
      'primary',
      'secondary',
      'muted',
      'placeholder',
      'inverse',
      'link',
    });
    return PortalTextColors(
      primary: _color(map, 'primary'),
      secondary: _color(map, 'secondary'),
      muted: _color(map, 'muted'),
      placeholder: _color(map, 'placeholder'),
      inverse: _color(map, 'inverse'),
      link: _color(map, 'link'),
    );
  }

  final Color primary;
  final Color secondary;
  final Color muted;
  final Color placeholder;
  final Color inverse;
  final Color link;
}

class PortalBorderColors {
  const PortalBorderColors({
    required this.defaultColor,
    required this.subtle,
    required this.strong,
    required this.divider,
    required this.interactive,
  });

  factory PortalBorderColors.parse(Object? value) {
    final map = _strictMap(value, const {
      'default',
      'subtle',
      'strong',
      'divider',
      'interactive',
    });
    return PortalBorderColors(
      defaultColor: _color(map, 'default'),
      subtle: _color(map, 'subtle'),
      strong: _color(map, 'strong'),
      divider: _color(map, 'divider'),
      interactive: _color(map, 'interactive'),
    );
  }

  final Color defaultColor;
  final Color subtle;
  final Color strong;
  final Color divider;
  final Color interactive;
}

class PortalAccentColors {
  const PortalAccentColors({
    required this.primary,
    required this.foreground,
    required this.soft,
    required this.muted,
    required this.focusRing,
  });

  factory PortalAccentColors.parse(Object? value) {
    final map = _strictMap(value, const {
      'primary',
      'foreground',
      'soft',
      'muted',
      'focusRing',
    });
    return PortalAccentColors(
      primary: _color(map, 'primary'),
      foreground: _color(map, 'foreground'),
      soft: _color(map, 'soft'),
      muted: _color(map, 'muted'),
      focusRing: _color(map, 'focusRing'),
    );
  }

  final Color primary;
  final Color foreground;
  final Color soft;
  final Color muted;
  final Color focusRing;
}

class PortalTonePair {
  const PortalTonePair({required this.foreground, required this.surface});

  factory PortalTonePair.parse(Object? value) {
    final map = _strictMap(value, const {'foreground', 'surface'});
    return PortalTonePair(
      foreground: _color(map, 'foreground'),
      surface: _color(map, 'surface'),
    );
  }

  final Color foreground;
  final Color surface;
}

class PortalStatusColors {
  const PortalStatusColors({
    required this.success,
    required this.warning,
    required this.danger,
    required this.info,
  });

  factory PortalStatusColors.parse(Object? value) {
    final map = _strictMap(value, const {
      'success',
      'warning',
      'danger',
      'info',
    });
    return PortalStatusColors(
      success: PortalTonePair.parse(map['success']),
      warning: PortalTonePair.parse(map['warning']),
      danger: PortalTonePair.parse(map['danger']),
      info: PortalTonePair.parse(map['info']),
    );
  }

  final PortalTonePair success;
  final PortalTonePair warning;
  final PortalTonePair danger;
  final PortalTonePair info;
}

class PortalActivityColors {
  const PortalActivityColors({
    required this.active,
    required this.idle,
    required this.working,
    required this.waiting,
    required this.completed,
  });

  factory PortalActivityColors.parse(Object? value) {
    final map = _strictMap(value, const {
      'active',
      'idle',
      'working',
      'waiting',
      'completed',
    });
    return PortalActivityColors(
      active: PortalTonePair.parse(map['active']),
      idle: PortalTonePair.parse(map['idle']),
      working: PortalTonePair.parse(map['working']),
      waiting: PortalTonePair.parse(map['waiting']),
      completed: PortalTonePair.parse(map['completed']),
    );
  }

  final PortalTonePair active;
  final PortalTonePair idle;
  final PortalTonePair working;
  final PortalTonePair waiting;
  final PortalTonePair completed;
}

class PortalTerminalColors {
  const PortalTerminalColors({
    required this.background,
    required this.foreground,
    required this.muted,
    required this.cursor,
    required this.cursorAccent,
    required this.selection,
    required this.black,
    required this.red,
    required this.green,
    required this.yellow,
    required this.blue,
    required this.magenta,
    required this.cyan,
    required this.white,
    required this.brightBlack,
    required this.brightRed,
    required this.brightGreen,
    required this.brightYellow,
    required this.brightBlue,
    required this.brightMagenta,
    required this.brightCyan,
    required this.brightWhite,
  });

  factory PortalTerminalColors.parse(Object? value) {
    final map = _strictMap(value, const {
      'background',
      'foreground',
      'muted',
      'cursor',
      'cursorAccent',
      'selection',
      'black',
      'red',
      'green',
      'yellow',
      'blue',
      'magenta',
      'cyan',
      'white',
      'brightBlack',
      'brightRed',
      'brightGreen',
      'brightYellow',
      'brightBlue',
      'brightMagenta',
      'brightCyan',
      'brightWhite',
    });
    return PortalTerminalColors(
      background: _color(map, 'background'),
      foreground: _color(map, 'foreground'),
      muted: _color(map, 'muted'),
      cursor: _color(map, 'cursor'),
      cursorAccent: _color(map, 'cursorAccent'),
      selection: _color(map, 'selection'),
      black: _color(map, 'black'),
      red: _color(map, 'red'),
      green: _color(map, 'green'),
      yellow: _color(map, 'yellow'),
      blue: _color(map, 'blue'),
      magenta: _color(map, 'magenta'),
      cyan: _color(map, 'cyan'),
      white: _color(map, 'white'),
      brightBlack: _color(map, 'brightBlack'),
      brightRed: _color(map, 'brightRed'),
      brightGreen: _color(map, 'brightGreen'),
      brightYellow: _color(map, 'brightYellow'),
      brightBlue: _color(map, 'brightBlue'),
      brightMagenta: _color(map, 'brightMagenta'),
      brightCyan: _color(map, 'brightCyan'),
      brightWhite: _color(map, 'brightWhite'),
    );
  }

  final Color background;
  final Color foreground;
  final Color muted;
  final Color cursor;
  final Color cursorAccent;
  final Color selection;
  final Color black;
  final Color red;
  final Color green;
  final Color yellow;
  final Color blue;
  final Color magenta;
  final Color cyan;
  final Color white;
  final Color brightBlack;
  final Color brightRed;
  final Color brightGreen;
  final Color brightYellow;
  final Color brightBlue;
  final Color brightMagenta;
  final Color brightCyan;
  final Color brightWhite;
}

class PortalAppearance {
  const PortalAppearance({
    required this.version,
    required this.revision,
    required this.themeId,
    required this.displayName,
    required this.brightness,
    required this.surfaces,
    required this.text,
    required this.borders,
    required this.accent,
    required this.status,
    required this.activity,
    required this.terminal,
    required this.radiusScale,
  });

  factory PortalAppearance.parse(Object? value) {
    final map = _strictMap(value, const {
      'version',
      'revision',
      'themeId',
      'displayName',
      'polarity',
      'surfaces',
      'text',
      'borders',
      'accent',
      'status',
      'activity',
      'terminal',
      'strategy',
    });
    if (map['version'] != 1) {
      throw const FormatException('Unsupported appearance version');
    }
    final revision = map['revision'];
    if (revision is! int || revision < 0) {
      throw const FormatException('Invalid revision');
    }
    final themeId = _boundedString(map['themeId'], opaque: true);
    final displayName = _boundedString(map['displayName']);
    final polarity = map['polarity'];
    if (polarity != 'dark' && polarity != 'light') {
      throw const FormatException('Invalid polarity');
    }
    final strategy = _strictMap(map['strategy'], const {'radiusScale'});
    final radiusScale = strategy['radiusScale'];
    if (radiusScale is! num || radiusScale < 0.5 || radiusScale > 2) {
      throw const FormatException('Invalid radius scale');
    }
    return PortalAppearance(
      version: 1,
      revision: revision,
      themeId: themeId,
      displayName: displayName,
      brightness: polarity == 'dark' ? Brightness.dark : Brightness.light,
      surfaces: PortalSurfaceColors.parse(map['surfaces']),
      text: PortalTextColors.parse(map['text']),
      borders: PortalBorderColors.parse(map['borders']),
      accent: PortalAccentColors.parse(map['accent']),
      status: PortalStatusColors.parse(map['status']),
      activity: PortalActivityColors.parse(map['activity']),
      terminal: PortalTerminalColors.parse(map['terminal']),
      radiusScale: radiusScale.toDouble(),
    );
  }

  static PortalAppearance resolve(Object? value, {PortalAppearance? fallback}) {
    final safeFallback = fallback ?? generatedDaintreeAppearance;
    if (value == null) return safeFallback;
    try {
      return PortalAppearance.parse(value);
    } on FormatException {
      return safeFallback;
    } on TypeError {
      return safeFallback;
    }
  }

  final int version;
  final int revision;
  final String themeId;
  final String displayName;
  final Brightness brightness;
  final PortalSurfaceColors surfaces;
  final PortalTextColors text;
  final PortalBorderColors borders;
  final PortalAccentColors accent;
  final PortalStatusColors status;
  final PortalActivityColors activity;
  final PortalTerminalColors terminal;
  final double radiusScale;
}

final PortalAppearance generatedDaintreeAppearance = PortalAppearance.parse(
  generatedDaintreeAppearanceJson,
);

final PortalAppearance generatedBondiAppearance = PortalAppearance.parse(
  generatedBondiAppearanceJson,
);

Map<String, Object?> _strictMap(Object? value, Set<String> expectedKeys) {
  if (value is! Map) throw const FormatException('Expected an object');
  final map = <String, Object?>{};
  for (final entry in value.entries) {
    if (entry.key is! String) {
      throw const FormatException('Expected string keys');
    }
    map[entry.key as String] = entry.value;
  }
  if (map.keys.toSet().difference(expectedKeys).isNotEmpty ||
      expectedKeys.difference(map.keys.toSet()).isNotEmpty) {
    throw const FormatException('Unexpected appearance fields');
  }
  return map;
}

String _boundedString(Object? value, {bool opaque = false}) {
  if (value is! String ||
      value.isEmpty ||
      value.length > 128 ||
      value.contains(RegExp(r'[\x00-\x1f\x7f]'))) {
    throw const FormatException('Invalid appearance string');
  }
  if (opaque && !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]*$').hasMatch(value)) {
    throw const FormatException('Invalid appearance identifier');
  }
  return value;
}

Color _color(Map<String, Object?> map, String key) {
  final value = map[key];
  if (value is! String || !RegExp(r'^#[0-9a-f]{8}$').hasMatch(value)) {
    throw const FormatException('Invalid appearance color');
  }
  final argb = '${value.substring(7, 9)}${value.substring(1, 7)}';
  return Color(int.parse(argb, radix: 16));
}
