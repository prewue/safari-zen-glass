// Native Liquid Glass behind the pinned sidebar panel. native/SafariZenGlass.dylib
// puts an NSGlassEffectView under Gecko's view at the panel's rect; this side
// keeps it in step with layout and sets [safari-native-glass] on :root, which
// chrome.css section 12 keys the transparent panel off. DEV.md §12.

const PREF = "mod.safari.native-glass";
const PREF_STYLE = "mod.safari.native-glass.style";
const PREF_PANEL = "mod.safari.pinned-panel";
const PREF_DEBUG = "mod.safari.native-glass.debug";
// Zen swaps the window's content view on this; the native side re-mounts.
const PREF_VIBRANCY = "zen.widget.macos.window-vibrancy";
const ATTR = "safari-native-glass";
// On :root from attach to detach: section 12 gives the root a corner under it,
// which is what keeps Gecko from setting the window opaque again.
const ATTR_HOST = "safari-native-glass-host";
const VAR_HOLE = "--safari-glass-hole";
const TAG = "[Safari-like Zen / glass]";
const LIB = "native/SafariZenGlass.dylib";

// Apple's continuous corner: three cubics per corner, extent 1.528665 r.
const K = [1.528665, 1.08849, 0.868407, 0.631494, 0.372824, 0.16906, 0.074911];

const root = document.documentElement;
const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");

let lib = null;
let fn = null;
let handle = null;
let kind = 0;
let started = false;
let shown = false;
let frame = 0;
let resizeObserver = null;
let rootObserver = null;
let toolboxObserver = null;

function pref(name, fallback) {
  try {
    return Services.prefs.getBoolPref(name, fallback);
  } catch (e) {
    return fallback;
  }
}

// chrome.css keys off -moz-pref(), which is false for a pref that does not
// exist yet; Sine only writes defaults from its settings page.
function ensurePrefs() {
  if (!Services.prefs.prefHasUserValue(PREF)) Services.prefs.setBoolPref(PREF, true);
  if (!Services.prefs.prefHasUserValue(PREF_STYLE)) Services.prefs.setStringPref(PREF_STYLE, "regular");
}

function debug(...args) {
  if (pref(PREF_DEBUG, false)) console.log(TAG, ...args);
}

// The dylib sits next to this script; chrome://sine/content/<id>/ maps to the
// profile's sine-mods folder.
function libraryPath() {
  const base = import.meta.url.split("?")[0].replace(/[^/]+$/, "") + LIB;
  const registry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(Ci.nsIChromeRegistry);
  const url = registry.convertChromeURL(Services.io.newURI(base));
  return url.QueryInterface(Ci.nsIFileURL).file.path;
}

function open() {
  if (fn) return true;
  const path = libraryPath();
  lib = ctypes.open(path);
  const abi = ctypes.default_abi;
  const ptr = ctypes.voidptr_t;
  const d = ctypes.double;
  fn = {
    version: lib.declare("szg_version", abi, ctypes.int32_t),
    attach: lib.declare("szg_attach", abi, ctypes.int32_t, ptr),
    detach: lib.declare("szg_detach", abi, ctypes.void_t, ptr),
    frames: lib.declare("szg_set_frames", abi, ctypes.int32_t, ptr, d, d, d, d, d, d, ctypes.int32_t),
    style: lib.declare("szg_set_style", abi, ctypes.void_t, ptr, ctypes.int32_t),
    visible: lib.declare("szg_set_visible", abi, ctypes.void_t, ptr, ctypes.int32_t),
    dump: lib.declare("szg_dump", abi, ctypes.int32_t, ptr, ctypes.char.ptr),
  };
  const raw = window.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
  handle = ctypes.cast(ctypes.uintptr_t(ctypes.UInt64(raw)), ptr);
  debug("library", path, "version", fn.version(), "window", raw);
  return true;
}

// ---- geometry
function panel() {
  return document.getElementById("zen-toolbar-background");
}

function toolbox() {
  return document.getElementById("navigator-toolbox");
}

function rightSide() {
  return root.getAttribute("zen-right-side") === "true";
}

// A continuous-corner rounded rect as SVG path data, for clip-path: path().
function roundedPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const [k, a, b, c, d, e, f] = K.map(v => v * r);
  const n = v => Math.round(v * 100) / 100;
  const X = x + w;
  const Y = y + h;
  return [
    `M${n(x + k)} ${n(y)}`,
    `L${n(X - k)} ${n(y)}`,
    `C${n(X - a)} ${n(y)} ${n(X - b)} ${n(y)} ${n(X - c)} ${n(y + f)}`,
    `C${n(X - d)} ${n(y + e)} ${n(X - e)} ${n(y + d)} ${n(X - f)} ${n(y + c)}`,
    `C${n(X)} ${n(y + b)} ${n(X)} ${n(y + a)} ${n(X)} ${n(y + k)}`,
    `L${n(X)} ${n(Y - k)}`,
    `C${n(X)} ${n(Y - a)} ${n(X)} ${n(Y - b)} ${n(X - f)} ${n(Y - c)}`,
    `C${n(X - e)} ${n(Y - d)} ${n(X - d)} ${n(Y - e)} ${n(X - c)} ${n(Y - f)}`,
    `C${n(X - b)} ${n(Y)} ${n(X - a)} ${n(Y)} ${n(X - k)} ${n(Y)}`,
    `L${n(x + k)} ${n(Y)}`,
    `C${n(x + a)} ${n(Y)} ${n(x + b)} ${n(Y)} ${n(x + c)} ${n(Y - f)}`,
    `C${n(x + d)} ${n(Y - e)} ${n(x + e)} ${n(Y - d)} ${n(x + f)} ${n(Y - c)}`,
    `C${n(x)} ${n(Y - b)} ${n(x)} ${n(Y - a)} ${n(x)} ${n(Y - k)}`,
    `L${n(x)} ${n(y + k)}`,
    `C${n(x)} ${n(y + a)} ${n(x)} ${n(y + b)} ${n(x + f)} ${n(y + c)}`,
    `C${n(x + e)} ${n(y + d)} ${n(x + d)} ${n(y + e)} ${n(x + c)} ${n(y + f)}`,
    `C${n(x + b)} ${n(y)} ${n(x + a)} ${n(y)} ${n(x + k)} ${n(y)}`,
    "Z",
  ].join(" ");
}

// The panel's corner: concentric with the native window radius when that is
// on (DEV.md §1), otherwise the panel's own CSS radius.
function radius(panelRect, columnRect) {
  const windowRadius = parseFloat(getComputedStyle(root).getPropertyValue("--safari-window-radius"));
  if (root.hasAttribute("safari-window-radius") && windowRadius > 0) {
    const gap = rightSide() ? columnRect.right - panelRect.right : panelRect.left - columnRect.left;
    return Math.max(0, windowRadius - gap);
  }
  return parseFloat(getComputedStyle(panel()).borderRadius) || 0;
}

function wanted() {
  if (!pref(PREF, true) || !pref(PREF_PANEL, true)) return false;
  if (root.getAttribute("zen-compact-mode") === "true") return false;
  if (root.hasAttribute("customizing") || root.getAttribute("inDOMFullscreen") === "true") return false;
  const p = panel();
  if (!p || getComputedStyle(p).display === "none") return false;
  const t = toolbox();
  if (!t || getComputedStyle(t).visibility === "collapse") return false;
  return true;
}

function schedule() {
  if (frame) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    update();
  });
}

function update() {
  if (!started) return;
  if (!wanted()) {
    hide();
    return;
  }
  const p = panel().getBoundingClientRect();
  const c = toolbox().getBoundingClientRect();
  if (!p.width || !p.height) {
    hide();
    return;
  }
  const r = radius(p, c);
  fn.frames(handle, p.x, p.y, p.width, p.height, r, window.devicePixelRatio, rightSide() ? 1 : 0);

  // The workspace gradient is clipped out of the panel so it does not tint the
  // glass; the path is in the gradient element's own box.
  const gradient = document.getElementById("zen-browser-background");
  if (gradient) {
    const g = gradient.getBoundingClientRect();
    const hole = roundedPath(p.x - g.x, p.y - g.y, p.width, p.height, r);
    root.style.setProperty(
      VAR_HOLE,
      `path(evenodd, "M0 0 H${Math.ceil(g.width)} V${Math.ceil(g.height)} H0 Z ${hole}")`
    );
  }
  if (!shown) {
    shown = true;
    fn.style(handle, Services.prefs.getStringPref(PREF_STYLE, "regular") === "clear" ? 1 : 0);
    fn.visible(handle, 1);
    root.setAttribute(ATTR, kind === 2 ? "glass" : "material");
    debug("shown", kind === 2 ? "NSGlassEffectView" : "NSVisualEffectView");
  }
}

function hide() {
  if (!shown) return;
  shown = false;
  root.removeAttribute(ATTR);
  root.style.removeProperty(VAR_HOLE);
  try {
    fn.visible(handle, 0);
  } catch (e) {}
  debug("hidden");
}

function onStyle() {
  if (shown) fn.style(handle, Services.prefs.getStringPref(PREF_STYLE, "regular") === "clear" ? 1 : 0);
}

// ---- lifecycle
function start() {
  if (started) return;
  if (!open()) return;
  kind = fn.attach(handle);
  if (!kind) {
    console.warn(TAG, "could not attach to the window");
    return;
  }
  started = true;
  root.setAttribute(ATTR_HOST, "");

  resizeObserver = new window.ResizeObserver(schedule);
  resizeObserver.observe(panel());
  resizeObserver.observe(toolbox());
  rootObserver = new window.MutationObserver(schedule);
  rootObserver.observe(root, {
    attributes: true,
    attributeFilter: [
      "zen-compact-mode",
      "zen-compact-animating",
      "zen-right-side",
      "customizing",
      "inDOMFullscreen",
      "safari-window-radius",
      "zen-sidebar-expanded",
    ],
  });
  toolboxObserver = new window.MutationObserver(schedule);
  toolboxObserver.observe(toolbox(), { attributes: true, attributeFilter: ["zen-sidebar-expanded", "style"] });
  window.addEventListener("resize", schedule);
  Services.prefs.addObserver(PREF_STYLE, onStyle);
  Services.prefs.addObserver(PREF_VIBRANCY, schedule);
  update();
}

function stop() {
  if (!started) return;
  started = false;
  hide();
  resizeObserver?.disconnect();
  rootObserver?.disconnect();
  toolboxObserver?.disconnect();
  window.removeEventListener("resize", schedule);
  Services.prefs.removeObserver(PREF_STYLE, onStyle);
  Services.prefs.removeObserver(PREF_VIBRANCY, schedule);
  if (frame) window.cancelAnimationFrame(frame);
  frame = 0;
  root.removeAttribute(ATTR_HOST);
  // Gecko makes the window opaque again on the next style flush; the native
  // side restores the window colour after that, or Gecko's white would stay.
  const detach = () => {
    try {
      fn.detach(handle);
    } catch (e) {}
  };
  if (window.closed) {
    detach();
  } else {
    window.requestAnimationFrame(() => window.setTimeout(detach, 50));
  }
}

function sync() {
  if (pref(PREF, true) && pref(PREF_PANEL, true)) {
    start();
  } else {
    stop();
  }
}

function init() {
  if (Services.appinfo.OS !== "Darwin") return;
  if (!panel() || !toolbox()) {
    console.warn(TAG, "sidebar panel not found");
    return;
  }
  // a re-run of this script (Sine refresh) replaces the previous instance
  window.__safariGlass?.stop();
  window.__safariGlass = { stop };

  try {
    ensurePrefs();
    sync();
  } catch (e) {
    console.error(TAG, "failed:", e);
    return;
  }
  Services.prefs.addObserver(PREF, sync);
  Services.prefs.addObserver(PREF_PANEL, sync);
  window.addEventListener(
    "unload",
    () => {
      try {
        Services.prefs.removeObserver(PREF, sync);
        Services.prefs.removeObserver(PREF_PANEL, sync);
        stop();
      } catch (e) {}
    },
    { once: true }
  );
}

if (document.readyState === "complete") {
  window.setTimeout(init, 800);
} else {
  window.addEventListener("load", () => window.setTimeout(init, 800), { once: true });
}
