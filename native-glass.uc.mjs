// Native Liquid Glass behind the sidebar panel. native/SafariZenGlass.dylib
// puts an NSGlassEffectView under Gecko's view at the panel's rect; this side
// keeps it in step with layout and sets [safari-native-glass] on :root, which
// chrome.css section 12 keys the transparent panel off. DEV.md §12.

const PREF = "mod.safari.native-glass";
const PREF_STYLE = "mod.safari.native-glass.style";
const PREF_PANEL = "mod.safari.pinned-panel";
const PREF_DEBUG = "mod.safari.native-glass.debug";
// "blur": Gecko blurs the page behind the compact panel, which a native view
// under Gecko cannot do. "native": the same NSGlassEffectView as pinned, over
// the page's colour, with the page clipped back to the panel. DEV.md §12.
const PREF_COMPACT = "mod.safari.native-glass.compact";
// Zen swaps the window's content view on this; the native side re-mounts.
const PREF_VIBRANCY = "zen.widget.macos.window-vibrancy";
const ATTR = "safari-native-glass";
// The band Gecko must stop painting so the native layer shows through.
const VAR_BAND = "--safari-glass-band";
const VAR_BAND_CONTENT = "--safari-glass-band-content";
// The colour Gecko would have painted the column, resolved in CSS.
const VAR_COLOUR = "--safari-glass-backdrop";
const TAG = "[Safari-like Zen / glass]";
const LIB = "native/SafariZenGlass.dylib";
// Long enough for the compact toggle's slide, with a margin.
const FOLLOW_MS = 700;

const root = document.documentElement;
const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

let lib = null;
let fn = null;
let handle = null;
let kind = 0;
let started = false;
let starting = false;
let shown = false;
let frame = 0;
let followUntil = 0;
let lastColour = "";
let styleObserver = null;
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

function debug(...args) {
  if (pref(PREF_DEBUG, false)) console.log(TAG, ...args);
}

// chrome.css keys off -moz-pref(), which is false for a pref that does not
// exist yet; Sine only writes defaults from its settings page.
function ensurePrefs() {
  if (!Services.prefs.prefHasUserValue(PREF)) Services.prefs.setBoolPref(PREF, true);
  if (!Services.prefs.prefHasUserValue(PREF_STYLE)) Services.prefs.setStringPref(PREF_STYLE, "regular");
  if (!Services.prefs.prefHasUserValue(PREF_COMPACT)) Services.prefs.setStringPref(PREF_COMPACT, "blur");
}

// The dylib sits next to this script; chrome://sine/content/<id>/ maps to the
// profile's sine-mods folder.
function libraryPath() {
  const base = import.meta.url.split("?")[0].replace(/[^/]+$/, "") + LIB;
  const registry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(Ci.nsIChromeRegistry);
  const url = registry.convertChromeURL(Services.io.newURI(base));
  return url.QueryInterface(Ci.nsIFileURL).file.path;
}

// Zen has LSFileQuarantineEnabled, so everything it writes - Sine's unpacked
// dylib included - is quarantined, and Gatekeeper refuses to dlopen it.
async function unquarantine(path) {
  try {
    const proc = await Subprocess.call({
      command: "/usr/bin/xattr",
      arguments: ["-d", "com.apple.quarantine", path],
    });
    await proc.wait();
  } catch (e) {
    debug("xattr failed", e?.message ?? e);
  }
}

function open(path) {
  if (fn) return;
  lib = ctypes.open(path);
  const abi = ctypes.default_abi;
  const ptr = ctypes.voidptr_t;
  const d = ctypes.double;
  fn = {
    version: lib.declare("szg_version", abi, ctypes.int32_t),
    attach: lib.declare("szg_attach", abi, ctypes.int32_t, ptr),
    detach: lib.declare("szg_detach", abi, ctypes.void_t, ptr),
    frames: lib.declare("szg_set_frames", abi, ctypes.int32_t, ptr, d, d, d, d, d, d, d, d, d, d, ctypes.int32_t),
    colour: lib.declare("szg_set_colour", abi, ctypes.void_t, ptr, d, d, d, d),
    style: lib.declare("szg_set_style", abi, ctypes.void_t, ptr, ctypes.int32_t),
    visible: lib.declare("szg_set_visible", abi, ctypes.void_t, ptr, ctypes.int32_t),
    dump: lib.declare("szg_dump", abi, ctypes.int32_t, ptr, ctypes.char.ptr),
  };
  const raw = window.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).nativeHandle;
  handle = ctypes.cast(ctypes.uintptr_t(ctypes.UInt64(raw)), ptr);
  debug("library", path, "version", fn.version(), "window", raw);
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

function compact() {
  return root.getAttribute("zen-compact-mode") === "true";
}

function nativeInCompact() {
  try {
    return Services.prefs.getStringPref(PREF_COMPACT, "blur") === "native";
  } catch (e) {
    return false;
  }
}

// Keeps `element` off the sidebar band, in its own box. A rect clip, because
// that is the only shape Gecko applies to a remote page (DEV.md §12).
function bandFor(element, edge) {
  const g = element.getBoundingClientRect();
  const inset = Math.ceil(Math.max(0, rightSide() ? g.right - edge : edge - g.left));
  return rightSide() ? `inset(0 ${inset}px 0 0)` : `inset(0 0 0 ${inset}px)`;
}

// The colour Gecko would have painted the column with, from section 12.
function backdropColour() {
  const raw = getComputedStyle(toolbox()).getPropertyValue(VAR_COLOUR).trim();
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.%]+))?\s*\)$/.exec(raw);
  if (!m) return null;
  let alpha = 1;
  if (m[4] !== undefined) alpha = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [+m[1], +m[2], +m[3], alpha];
}

// The panel's corner: concentric with the native window radius when that is
// on (DEV.md §1) - the window radius less the panel's distance from the window
// edge, which compact's off-screen toolbox does not change - otherwise the
// panel's own CSS radius.
function radius(panelRect) {
  const windowRadius = parseFloat(getComputedStyle(root).getPropertyValue("--safari-window-radius"));
  if (root.hasAttribute("safari-window-radius") && windowRadius > 0) {
    const gap = rightSide() ? window.innerWidth - panelRect.right : panelRect.left;
    return Math.max(0, windowRadius - Math.max(0, gap));
  }
  return parseFloat(getComputedStyle(panel()).borderRadius) || 0;
}

function wanted() {
  if (!pref(PREF, true)) return false;
  if (!compact() && !pref(PREF_PANEL, true)) return false;
  // In compact the page runs *behind* the panel, and a native view under Gecko
  // cannot blur Gecko's own pixels; the glass there is a choice between the
  // real blur (Gecko's) and the real glass (over the page's colour).
  if (compact() && !nativeInCompact()) return false;
  if (root.hasAttribute("zen-compact-animating")) return false;
  if (root.hasAttribute("customizing") || root.getAttribute("inDOMFullscreen") === "true") return false;
  const p = panel();
  if (!p || getComputedStyle(p).display === "none") return false;
  const t = toolbox();
  if (!t) return false;
  const visibility = getComputedStyle(t).visibility;
  if (visibility === "collapse" || visibility === "hidden") return false;
  return true;
}

function schedule() {
  if (frame) return;
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    update();
    if (window.performance.now() < followUntil) schedule();
  });
}

// The compact toggle animates the toolbox's inline margin; keep updating every
// frame until it settles, so the panel is in place the moment it is shown.
function follow(ms = FOLLOW_MS) {
  followUntil = Math.max(followUntil, window.performance.now() + ms);
  schedule();
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
  const r = radius(p);

  // The band Gecko stops painting and the native layer takes over: the whole
  // sidebar column pinned, gap included, so it keeps its square corners
  // against the window; up to the panel's outer edge in compact, where the
  // panel floats over the page.
  const edge = compact()
    ? (rightSide() ? p.left : p.right)
    : (rightSide() ? c.left : c.right);
  const backdrop = rightSide()
    ? { x: edge, y: 0, width: Math.max(0, window.innerWidth - edge), height: window.innerHeight }
    : { x: 0, y: 0, width: Math.max(0, edge), height: window.innerHeight };

  fn.frames(
    handle,
    p.x, p.y, p.width, p.height,
    backdrop.x, backdrop.y, backdrop.width, backdrop.height,
    r, window.devicePixelRatio, rightSide() ? 1 : 0
  );
  pushColour();

  const gradient = document.getElementById("zen-browser-background");
  if (gradient) root.style.setProperty(VAR_BAND, bandFor(gradient, edge));

  // Compact only: pinned, the page already starts after the column.
  const content = document.getElementById("zen-appcontent-wrapper");
  if (compact() && content) {
    root.style.setProperty(VAR_BAND_CONTENT, bandFor(content, edge));
  } else {
    root.style.removeProperty(VAR_BAND_CONTENT);
  }

  if (!shown) {
    shown = true;
    fn.style(handle, Services.prefs.getStringPref(PREF_STYLE, "regular") === "clear" ? 1 : 0);
    fn.visible(handle, 1);
    root.setAttribute(ATTR, kind === 2 ? "glass" : "material");
    debug("shown", kind === 2 ? "NSGlassEffectView" : "NSVisualEffectView");
  }
}

// The page canvas colour, straight through on every change: page-canvas.uc.mjs
// writes it on :root, so this runs in that same turn, not a frame later.
function pushColour() {
  if (!started) return;
  const c = backdropColour();
  if (!c) return;
  const key = c.join();
  if (key === lastColour) return;
  lastColour = key;
  fn.colour(handle, c[0], c[1], c[2], c[3]);
  debug("colour", key);
}

function hide() {
  if (!shown) return;
  shown = false;
  root.removeAttribute(ATTR);
  root.style.removeProperty(VAR_BAND);
  root.style.removeProperty(VAR_BAND_CONTENT);
  try {
    fn.visible(handle, 0);
  } catch (e) {}
  debug("hidden");
}

function onStyle() {
  if (shown) fn.style(handle, Services.prefs.getStringPref(PREF_STYLE, "regular") === "clear" ? 1 : 0);
}

// ---- lifecycle
async function start() {
  if (started || starting) return;
  starting = true;
  try {
    if (!fn) {
      const path = libraryPath();
      await unquarantine(path);
      open(path);
    }
  } catch (e) {
    console.error(TAG, "native library unavailable, glass off:", e?.message ?? e);
    starting = false;
    return;
  }
  starting = false;
  if (!pref(PREF, true)) return;
  kind = fn.attach(handle);
  if (!kind) {
    console.warn(TAG, "could not attach to the window");
    return;
  }
  started = true;
  lastColour = "";

  const t = toolbox();
  resizeObserver = new window.ResizeObserver(schedule);
  resizeObserver.observe(panel());
  resizeObserver.observe(t);
  rootObserver = new window.MutationObserver(() => follow());
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
      "zen-has-empty-tab",
    ],
  });
  toolboxObserver = new window.MutationObserver(() => (compact() ? follow() : schedule()));
  toolboxObserver.observe(t, {
    attributes: true,
    // Zen's compact reveal conditions, from zen-compact-mode.css, plus the
    // inline left/right it slides with.
    attributeFilter: [
      "zen-has-hover",
      "zen-user-show",
      "zen-has-empty-tab",
      "flash-popup",
      "has-popup-menu",
      "movingtab",
      "zen-compact-mode-active",
      "zen-sidebar-expanded",
      "animate",
      "style",
    ],
  });
  // page-canvas.uc.mjs writes --safari-pin-canvas inline on :root.
  styleObserver = new window.MutationObserver(pushColour);
  styleObserver.observe(root, { attributes: true, attributeFilter: ["style", "zen-has-empty-tab"] });
  window.addEventListener("resize", schedule);
  Services.prefs.addObserver(PREF_STYLE, onStyle);
  Services.prefs.addObserver(PREF_VIBRANCY, schedule);
  Services.prefs.addObserver(PREF_COMPACT, schedule);
  update();
}

function stop() {
  if (!started) return;
  started = false;
  hide();
  resizeObserver?.disconnect();
  rootObserver?.disconnect();
  toolboxObserver?.disconnect();
  styleObserver?.disconnect();
  window.removeEventListener("resize", schedule);
  Services.prefs.removeObserver(PREF_STYLE, onStyle);
  Services.prefs.removeObserver(PREF_VIBRANCY, schedule);
  Services.prefs.removeObserver(PREF_COMPACT, schedule);
  if (frame) window.cancelAnimationFrame(frame);
  frame = 0;
  followUntil = 0;
  lastColour = "";
  try {
    fn.detach(handle);
  } catch (e) {}
}

function sync() {
  if (pref(PREF, true)) {
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
  Services.prefs.addObserver(PREF_PANEL, schedule);
  window.addEventListener(
    "unload",
    () => {
      try {
        Services.prefs.removeObserver(PREF, sync);
        Services.prefs.removeObserver(PREF_PANEL, schedule);
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
