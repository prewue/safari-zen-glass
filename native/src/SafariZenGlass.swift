// Native Liquid Glass for the pinned sidebar panel. Loaded into Zen by
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

/// What the window frame painted while the window was opaque, with the glass
/// cut out. Only needed when Zen's material view is not the content view.
final class BackingView: NSView {
  let base = CAShapeLayer()
  var onAppearanceChange: (() -> Void)?

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func makeBackingLayer() -> CALayer {
    let l = CALayer()
    base.fillRule = .evenOdd
    base.fillColor = NSColor.clear.cgColor
    l.addSublayer(base)
    return l
  }
  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    base.contentsScale = window?.backingScaleFactor ?? 2
  }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    onAppearanceChange?()
  }
}

/// One panel per NSWindow, inserted below Gecko's ChildView so Gecko's UI
/// paints over it. Behind-window sampling needs a non-opaque window, which
/// Gecko keeps for us while chrome.css section 12 gives :root a corner (see
/// PresShell::SyncWindowPropertiesIfNeeded), and a hole in Zen's material
/// view. The window stays non-opaque from attach to detach; hiding only
/// closes the hole.
final class Panel {
  let window: NSWindow
  var host: NSView
  var gecko: NSView
  let backing = BackingView()
  let glass: NSView
  let isGlass: Bool
  let wasOpaque: Bool
  let wasBackground: NSColor?
  var active = false
  var hole = CGRect.zero
  var radius: CGFloat = 0
  var closeObserver: NSObjectProtocol?

  init?(window: NSWindow) {
    guard let host = window.contentView,
      let gecko = host.subviews.first(where: { NSStringFromClass(type(of: $0)) == "ChildView" }) ?? host.subviews.first
    else { return nil }
    self.window = window
    self.host = host
    self.gecko = gecko
    wasOpaque = window.isOpaque
    wasBackground = window.backgroundColor

    if #available(macOS 26.0, *) {
      let g = PassthroughGlass()
      g.style = .regular
      glass = g
      isGlass = true
    } else {
      let v = PassthroughEffect()
      v.material = .sidebar
      v.blendingMode = .behindWindow
      v.state = .active
      glass = v
      isGlass = false
    }
    backing.wantsLayer = true
    backing.onAppearanceChange = { [weak self] in self?.paint() }
    glass.wantsLayer = true
    backing.isHidden = false
    glass.isHidden = true
    mount()
    setWindowOpaque(false)

    closeObserver = NotificationCenter.default.addObserver(
      forName: NSWindow.willCloseNotification, object: window, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      Registry.shared.remove(self.window)
    }
  }

  var material: NSVisualEffectView? { host as? NSVisualEffectView }

  /// Zen swaps the content view when its vibrancy pref flips; follow it.
  func mount() {
    if let current = window.contentView, current !== host {
      material?.maskImage = nil
      host = current
      gecko = current.subviews.first { NSStringFromClass(type(of: $0)) == "ChildView" }
        ?? current.subviews.first ?? gecko
    }
    if backing.superview !== host || glass.superview !== host {
      backing.removeFromSuperview()
      glass.removeFromSuperview()
      host.addSubview(backing, positioned: .below, relativeTo: gecko)
      host.addSubview(glass, positioned: .above, relativeTo: backing)
      backing.frame = host.bounds
      backing.autoresizingMask = [.width, .height]
      paint()
      maskMaterial()
    }
  }

  func detach() {
    if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
    closeObserver = nil
    active = false
    material?.maskImage = nil
    setWindowOpaque(true)
    backing.removeFromSuperview()
    glass.removeFromSuperview()
  }

  func setWindowOpaque(_ opaque: Bool) {
    if opaque {
      window.isOpaque = wasOpaque
      window.backgroundColor = wasBackground
    } else {
      window.isOpaque = false
      window.backgroundColor = NSColor.clear
    }
  }

  func holePath(in view: NSView) -> CGPath {
    let cut = view.convert(hole, from: host)
    return RoundedRectangle(cornerRadius: radius, style: .continuous).path(in: cut).cgPath
  }

  /// Rects are CSS pixels from the top-left of Gecko's view; `scale` is the
  /// chrome window's devicePixelRatio.
  func setFrames(panel: CGRect, radius: CGFloat, scale: CGFloat, rightSide: Bool) {
    mount()
    let toPoints = scale / max(window.backingScaleFactor, 1)
    let g = gecko.frame
    let frame = NSRect(
      x: g.minX + panel.origin.x * toPoints,
      y: g.maxY - (panel.origin.y + panel.height) * toPoints,
      width: panel.width * toPoints,
      height: panel.height * toPoints
    ).integral
    let r = radius * toPoints

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    glass.frame = frame
    glass.autoresizingMask = rightSide ? [.height, .minXMargin] : [.height, .maxXMargin]
    self.radius = r
    hole = frame.insetBy(dx: 0.5, dy: 0.5)
    if #available(macOS 26.0, *), let g = glass as? NSGlassEffectView {
      g.cornerRadius = r
    } else if let v = glass as? NSVisualEffectView {
      v.maskImage = roundedMask(size: frame.size, radius: r)
    }
    CATransaction.commit()
    paint()
    maskMaterial()
  }

  func setStyle(_ style: Int32) {
    if #available(macOS 26.0, *), let g = glass as? NSGlassEffectView {
      g.style = style == 1 ? .clear : .regular
    }
  }

  func setVisible(_ visible: Bool) {
    mount()
    active = visible
    glass.isHidden = !visible
    paint()
    maskMaterial()
  }

  /// The base layer: the frame's own window colour, which the frame no longer
  /// paints in a non-opaque window, everywhere but the hole. Nothing at all
  /// while Zen's material view is there to paint instead.
  func paint() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let bounds = backing.bounds
    backing.base.frame = bounds
    let path = CGMutablePath()
    path.addRect(bounds)
    if active { path.addPath(holePath(in: backing)) }
    backing.base.path = path
    backing.effectiveAppearance.performAsCurrentDrawingAppearance {
      let colour = material == nil ? NSColor.windowBackgroundColor : NSColor.clear
      backing.base.fillColor = colour.cgColor
    }
    CATransaction.commit()
  }

  /// The material samples behind the window itself and would be what the glass
  /// blurs; cut the hole out of it.
  func maskMaterial() {
    guard let material else { return }
    guard active, !hole.isEmpty else {
      material.maskImage = nil
      return
    }
    let size = material.bounds.size
    let path = holePath(in: material)
    let image = NSImage(size: size, flipped: false) { rect in
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      ctx.setFillColor(NSColor.black.cgColor)
      ctx.fill(rect)
      ctx.setBlendMode(.clear)
      ctx.addPath(path)
      ctx.fillPath()
      return true
    }
    let cut = material.convert(hole, from: host)
    image.resizingMode = .stretch
    image.capInsets = NSEdgeInsets(
      top: max(0, size.height - cut.maxY + radius + 1),
      left: max(0, cut.minX + radius + 1),
      bottom: max(0, cut.minY + radius + 1),
      right: max(0, size.width - cut.maxX + radius + 1))
    material.maskImage = image
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
      "window \(window.windowNumber) opaque=\(window.isOpaque) bg=\(window.backgroundColor.map { String(describing: $0) } ?? "nil") contentView=\(cv.map { NSStringFromClass(type(of: $0)) } ?? "nil") sameHost=\(cv === host) scale=\(window.backingScaleFactor)")
    for (i, v) in (cv?.subviews ?? []).enumerated() {
      lines.append("  [\(i)] \(NSStringFromClass(type(of: v))) frame=\(v.frame) hidden=\(v.isHidden)")
    }
    lines.append(
      "glass=\(NSStringFromClass(type(of: glass))) native=\(isGlass) frame=\(glass.frame) active=\(active) hole=\(hole) r=\(radius) material=\(material != nil) masked=\(material?.maskImage != nil)")
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
public func szg_version() -> Int32 { 1 }

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
  _ x: Double, _ y: Double, _ w: Double, _ h: Double,
  _ radius: Double, _ scale: Double, _ rightSide: Int32
) -> Int32 {
  onMain {
    guard let win = windowFrom(handle), let p = Registry.shared.panel(for: win) else { return 0 }
    p.setFrames(panel: CGRect(x: x, y: y, width: w, height: h), radius: radius, scale: scale, rightSide: rightSide != 0)
    return 1
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
    let text = Registry.shared.panel(for: w)?.describe()
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
