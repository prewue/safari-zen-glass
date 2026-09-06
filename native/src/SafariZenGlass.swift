// Native Liquid Glass for the sidebar panel. Loaded into Zen by
// native-glass.uc.mjs over js-ctypes; every entry point is a C symbol and runs
// on the main thread. DEV.md §12.

import AppKit
import QuartzCore
import SwiftUI

// Under Gecko's view, so none of these take mouse events.
@available(macOS 26.0, *)
final class PassthroughGlass: NSGlassEffectView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class PassthroughEffect: NSVisualEffectView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Clips the glass to its own rounded rect, so the shadow NSGlassEffectView
/// draws around itself never reaches the gap. DEV.md §12.
final class ClipView: NSView {
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func makeBackingLayer() -> CALayer {
    let l = CALayer()
    l.masksToBounds = true
    l.cornerCurve = .continuous
    return l
  }
}

/// The opaque surface the glass sits on: what Gecko used to paint in the
/// sidebar column, in the page's canvas colour.
final class BackdropView: NSView {
  var onAppearanceChange: (() -> Void)?
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    onAppearanceChange?()
  }
}

/// One panel per NSWindow, inserted below Gecko's ChildView so Gecko's own
/// sidebar UI paints on top of the glass. The window is left alone: it stays
/// opaque, and the glass never shows what is behind it.
final class Panel {
  let window: NSWindow
  var host: NSView
  var gecko: NSView
  let backdrop = BackdropView()
  let clip = ClipView()
  let glass: NSView
  let isGlass: Bool
  var colour = NSColor.clear
  var above = false
  var closeObserver: NSObjectProtocol?

  init?(window: NSWindow) {
    guard let host = window.contentView,
      let gecko = host.subviews.first(where: { NSStringFromClass(type(of: $0)) == "ChildView" })
        ?? host.subviews.first
    else { return nil }
    self.window = window
    self.host = host
    self.gecko = gecko

    if #available(macOS 26.0, *) {
      let g = PassthroughGlass()
      g.style = .regular
      glass = g
      isGlass = true
    } else {
      let v = PassthroughEffect()
      v.material = .sidebar
      v.blendingMode = .withinWindow
      v.state = .active
      glass = v
      isGlass = false
    }
    backdrop.wantsLayer = true
    backdrop.layer?.backgroundColor = NSColor.clear.cgColor
    backdrop.onAppearanceChange = { [weak self] in self?.paint() }
    glass.wantsLayer = true
    glass.layer?.shadowOpacity = 0
    clip.wantsLayer = true
    clip.addSubview(glass)
    backdrop.isHidden = true
    clip.isHidden = true
    mount()

    closeObserver = NotificationCenter.default.addObserver(
      forName: NSWindow.willCloseNotification, object: window, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      Registry.shared.remove(self.window)
    }
  }

  /// Zen swaps the window's content view when its vibrancy pref flips; follow.
  func mount() {
    if let current = window.contentView, current !== host {
      host = current
      gecko =
        current.subviews.first { NSStringFromClass(type(of: $0)) == "ChildView" }
        ?? current.subviews.first ?? gecko
    }
    if backdrop.superview !== host || clip.superview !== host {
      backdrop.removeFromSuperview()
      clip.removeFromSuperview()
      host.addSubview(backdrop, positioned: .below, relativeTo: gecko)
      host.addSubview(clip, positioned: above ? .above : .below, relativeTo: gecko)
    }
  }

  func detach() {
    if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
    closeObserver = nil
    backdrop.removeFromSuperview()
    clip.removeFromSuperview()
  }

  /// Rects are CSS pixels from the top-left of Gecko's view; `scale` is the
  /// chrome window's devicePixelRatio. `backdrop` is what Gecko leaves
  /// unpainted: the whole sidebar column pinned, the panel alone in compact.
  func setFrames(panel: CGRect, backdrop backdropRect: CGRect, radius: CGFloat, scale: CGFloat, rightSide: Bool) {
    mount()
    let toPoints = scale / max(window.backingScaleFactor, 1)
    let g = gecko.frame
    func convert(_ r: CGRect) -> NSRect {
      NSRect(
        x: g.minX + r.origin.x * toPoints,
        y: g.maxY - (r.origin.y + r.height) * toPoints,
        width: r.width * toPoints,
        height: r.height * toPoints
      ).integral
    }
    let r = radius * toPoints
    let mask: NSView.AutoresizingMask = rightSide ? [.height, .minXMargin] : [.height, .maxXMargin]

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    backdrop.frame = convert(backdropRect)
    backdrop.autoresizingMask = mask
    glass.frame = convert(panel)
    glass.autoresizingMask = mask
    if #available(macOS 26.0, *), let g = glass as? NSGlassEffectView {
      g.cornerRadius = r
    } else if let v = glass as? NSVisualEffectView {
      v.maskImage = roundedMask(size: glass.frame.size, radius: r)
    }
    CATransaction.commit()
  }

  func setColour(_ colour: NSColor) {
    self.colour = colour
    paint()
  }

  func paint() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    backdrop.effectiveAppearance.performAsCurrentDrawingAppearance {
      backdrop.layer?.backgroundColor = colour.cgColor
    }
    CATransaction.commit()
  }

  /// Debug: put the glass above Gecko's view, where it can sample the page.
  func setAbove(_ value: Bool) {
    guard value != above else { return }
    above = value
    clip.removeFromSuperview()
    host.addSubview(clip, positioned: above ? .above : .below, relativeTo: gecko)
  }

  func setStyle(_ style: Int32) {
    if #available(macOS 26.0, *), let g = glass as? NSGlassEffectView {
      g.style = style == 1 ? .clear : .regular
    }
  }

  func setVisible(_ visible: Bool) {
    mount()
    backdrop.isHidden = !visible
    clip.isHidden = !visible
  }

  func roundedMask(size: CGSize, radius: CGFloat) -> NSImage {
    let image = NSImage(size: size, flipped: false) { rect in
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      ctx.setFillColor(NSColor.black.cgColor)
      ctx.addPath(RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: rect).cgPath)
      ctx.fillPath()
      return true
    }
    image.resizingMode = .stretch
    image.capInsets = NSEdgeInsets(top: radius + 1, left: radius + 1, bottom: radius + 1, right: radius + 1)
    return image
  }

  func describe() -> String {
    var lines: [String] = []
    let cv = window.contentView
    lines.append(
      "window \(window.windowNumber) opaque=\(window.isOpaque) contentView=\(cv.map { NSStringFromClass(type(of: $0)) } ?? "nil") sameHost=\(cv === host) scale=\(window.backingScaleFactor)")
    for (i, v) in (cv?.subviews ?? []).enumerated() {
      lines.append("  [\(i)] \(NSStringFromClass(type(of: v))) frame=\(v.frame) hidden=\(v.isHidden)")
    }
    lines.append(
      "glass=\(NSStringFromClass(type(of: glass))) native=\(isGlass) clip=\(clip.frame) r=\(clip.layer?.cornerRadius ?? 0) hidden=\(clip.isHidden) backdrop=\(backdrop.frame) colour=\(colour)")
    return lines.joined(separator: "\n")
  }
}

final class Registry {
  static let shared = Registry()
  private var panels: [ObjectIdentifier: Panel] = [:]

  func panel(for window: NSWindow) -> Panel? { panels[ObjectIdentifier(window)] }

  func attach(_ window: NSWindow) -> Panel? {
    if let p = panels[ObjectIdentifier(window)] { return p }
    guard let p = Panel(window: window) else { return nil }
    panels[ObjectIdentifier(window)] = p
    return p
  }

  func remove(_ window: NSWindow) {
    panels.removeValue(forKey: ObjectIdentifier(window))?.detach()
  }
}

// ---- C ABI. `handle` is nsIBaseWindow.nativeHandle: the NSWindow, or a view in it.

private func windowFrom(_ handle: UnsafeMutableRawPointer?) -> NSWindow? {
  guard let handle else { return nil }
  let obj = Unmanaged<AnyObject>.fromOpaque(handle).takeUnretainedValue()
  if let w = obj as? NSWindow { return w }
  if let v = obj as? NSView { return v.window }
  return nil
}

private func onMain<T>(_ body: () -> T) -> T {
  if Thread.isMainThread { return body() }
  return DispatchQueue.main.sync(execute: body)
}

@_cdecl("szg_version")
public func szg_version() -> Int32 { 2 }

/// 2: NSGlassEffectView, 1: NSVisualEffectView fallback, 0: no window.
@_cdecl("szg_attach")
public func szg_attach(_ handle: UnsafeMutableRawPointer?) -> Int32 {
  onMain {
    guard let w = windowFrom(handle), let p = Registry.shared.attach(w) else { return 0 }
    return p.isGlass ? 2 : 1
  }
}

@_cdecl("szg_detach")
public func szg_detach(_ handle: UnsafeMutableRawPointer?) {
  onMain {
    guard let w = windowFrom(handle) else { return }
    Registry.shared.remove(w)
  }
}

@_cdecl("szg_set_frames")
public func szg_set_frames(
  _ handle: UnsafeMutableRawPointer?,
  _ px: Double, _ py: Double, _ pw: Double, _ ph: Double,
  _ bx: Double, _ by: Double, _ bw: Double, _ bh: Double,
  _ radius: Double, _ scale: Double, _ rightSide: Int32
) -> Int32 {
  onMain {
    guard let win = windowFrom(handle), let p = Registry.shared.panel(for: win) else { return 0 }
    p.setFrames(
      panel: CGRect(x: px, y: py, width: pw, height: ph),
      backdrop: CGRect(x: bx, y: by, width: bw, height: bh),
      radius: radius, scale: scale, rightSide: rightSide != 0)
    return 1
  }
}

/// The colour Gecko would have painted the column: the page's canvas colour.
@_cdecl("szg_set_colour")
public func szg_set_colour(
  _ handle: UnsafeMutableRawPointer?, _ r: Double, _ g: Double, _ b: Double, _ a: Double
) {
  onMain {
    guard let w = windowFrom(handle), let p = Registry.shared.panel(for: w) else { return }
    p.setColour(NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a))
  }
}

/// 0: regular, 1: clear.
@_cdecl("szg_set_style")
public func szg_set_style(_ handle: UnsafeMutableRawPointer?, _ style: Int32) {
  onMain {
    guard let w = windowFrom(handle), let p = Registry.shared.panel(for: w) else { return }
    p.setStyle(style)
  }
}

@_cdecl("szg_set_visible")
public func szg_set_visible(_ handle: UnsafeMutableRawPointer?, _ visible: Int32) {
  onMain {
    guard let w = windowFrom(handle), let p = Registry.shared.panel(for: w) else { return }
    p.setVisible(visible != 0)
  }
}

/// Debug: the view tree and our state, appended to `path`.
@_cdecl("szg_dump")
public func szg_dump(_ handle: UnsafeMutableRawPointer?, _ path: UnsafePointer<CChar>?) -> Int32 {
  onMain {
    guard let path, let w = windowFrom(handle) else { return 0 }
    let text =
      Registry.shared.panel(for: w)?.describe()
      ?? "window \(w.windowNumber) not attached; contentView=\(w.contentView.map { NSStringFromClass(type(of: $0)) } ?? "nil")"
    let url = URL(fileURLWithPath: String(cString: path))
    let data = (text + "\n").data(using: .utf8)!
    if let h = try? FileHandle(forWritingTo: url) {
      h.seekToEndOfFile()
      h.write(data)
      try? h.close()
    } else {
      try? data.write(to: url)
    }
    return 1
  }
}

@_cdecl("szg_set_above")
public func szg_set_above(_ handle: UnsafeMutableRawPointer?, _ value: Int32) {
  onMain {
    guard let w = windowFrom(handle), let p = Registry.shared.panel(for: w) else { return }
    p.setAbove(value != 0)
  }
}
