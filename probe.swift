import CoreGraphics
import Foundation

let args = CommandLine.arguments
func out(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }

switch args[1] {
case "hover":
  let x = Double(args[2])!
  let y = Double(args[3])!
  // Walk up to the edge: AppKit reveals the fullscreen title bar on movement into the top strip.
  for step in 0...20 {
    let yy = y + Double(20 - step) * 10
    let p = CGPoint(x: x, y: yy)
    CGWarpMouseCursorPosition(p)
    if let e = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) {
      e.post(tap: .cghidEventTap)
    }
    usleep(30_000)
  }
case "away":
  let p = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
  CGWarpMouseCursorPosition(p)
  if let e = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) {
    e.post(tap: .cghidEventTap)
  }
case "list":
  let pid = Int(args[2])!
  let info = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
  for w in info {
    guard let owner = w[kCGWindowOwnerPID as String] as? Int, owner == pid else { continue }
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let num = w[kCGWindowNumber as String] ?? 0
    let layer = w[kCGWindowLayer as String] ?? 0
    let onscreen = w[kCGWindowIsOnscreen as String] ?? false
    let alpha = w[kCGWindowAlpha as String] ?? 0
    let name = w[kCGWindowName as String] ?? ""
    out("win=\(num) layer=\(layer) onscreen=\(onscreen) alpha=\(alpha) x=\(b["X"] ?? "") y=\(b["Y"] ?? "") w=\(b["Width"] ?? "") h=\(b["Height"] ?? "") name=\(name)")
  }
default:
  out("unknown")
}
