// content.js - Youtube Player Improved
// Minimal-footprint design: no whole-document polling; observers do cheap
// per-node checks; heavy scans are deferred and cached.
(function () {
"use strict";

const BUILD_TAG = "ypi-1.3.23";

const QUALITY_LABELS = {
  auto: "Auto", hd2160: "2160p", hd1440: "1440p", hd1080: "1080p",
  hd720: "720p", large: "480p", medium: "360p", small: "240p", tiny: "144p",
};
const QUALITY_NUM = { hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };

const KEY_GROUPS = {
  resolution: ["enabled", "resolutionEnabled", "preferredResolution", "blockPremiumPromos"],
  volume: ["enabled", "fixedVolumeEnabled", "fixedVolume"],
  wheel: ["enabled", "disableVolumeWheel"],
  hover: ["enabled", "muteHoverPreviews"],
  shorts: ["enabled", "stopShortsLoop"],
  expand: ["enabled", "autoExpandEnabled"],
  captions: ["enabled", "captionsControlEnabled", "captionsMode"],
  miniplayer: ["enabled", "miniplayerEnabled", "miniplayerCorner", "miniplayerSize"],
  cardsEndscreens: ["enabled", "hideCardsEndscreens"],
  translation: ["enabled", "noTranslationEnabled"],
};

const HOVER_PREVIEW_SELECTOR =
  "ytd-video-preview, #video-preview, .ytd-video-preview, ytd-video-preview-renderer, ytd-hover-card-view-model";
const REAL_PLAYER_SELECTOR = "#movie_player, #shorts-player, #c4-player, ytd-miniplayer";

let settings = {};
let navigateTimer = null;
let shortsSweepInterval = null;
let premiumSweepInterval = null;
let qualityAppliedId = null;
let qualityAttempts = 0;
let qualityRetryTimer = null;
let expandAppliedUrl = null;
let lastCaptionsToggle = 0;
let volumeWindowUntil = 0;
let lastNavigationTime = 0;
const shortsVolumeWindows = new WeakMap();
let lastNavVideoId = null;
let titleRescanTimer = null;
let titleRescanCount = 0;

// ---------- Settings ----------

function loadSettings() {
  return browser.storage.local.get(null).then((s) => { settings = s; return s; });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!settings) settings = {};
  const changedKeys = Object.keys(changes);
  for (const key of changedKeys) settings[key] = changes[key].newValue;

  if (changedKeys.some((k) => KEY_GROUPS.resolution.includes(k))) {
    qualityAppliedId = null; qualityAttempts = 0; applyResolution();
  }
  if (changedKeys.some((k) => KEY_GROUPS.volume.includes(k))) {
    volumeWindowUntil = Date.now() + 3500; applyVolumeNow();
  }
  if (changedKeys.some((k) => KEY_GROUPS.hover.includes(k))) {
    if (settings.enabled && settings.muteHoverPreviews) startHoverMute(); else stopHoverMute();
  }
  if (changedKeys.some((k) => KEY_GROUPS.shorts.includes(k))) { fixShortsLoop(); startShortsSweep(); }
  if (changedKeys.some((k) => KEY_GROUPS.expand.includes(k))) { expandAppliedUrl = null; autoExpandPlayer(); }
  if (changedKeys.some((k) => KEY_GROUPS.captions.includes(k))) { lastCaptionsToggle = 0; applyCaptions(); }
  if (changedKeys.some((k) => KEY_GROUPS.miniplayer.includes(k))) {
    const structural = changedKeys.includes("enabled") || changedKeys.includes("miniplayerEnabled");
    if (structural) startMiniplayerObserving();
    else {
      if (changedKeys.includes("miniplayerCorner")) updateMiniplayerCorner();
      if (changedKeys.includes("miniplayerSize")) updateMiniplayerSize();
    }
  }
  if (changedKeys.some((k) => KEY_GROUPS.cardsEndscreens.includes(k))) applyHideCardsEndscreens();
  if (changedKeys.some((k) => KEY_GROUPS.translation.includes(k))) applyNoTranslation();
});

// ---------- Helpers ----------

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitFor(checkFn, timeout = 1500, interval = 50) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function tick() {
      let result; try { result = checkFn(); } catch (e) { result = null; }
      if (result) return resolve(result);
      if (Date.now() - start >= timeout) return resolve(null);
      setTimeout(tick, interval);
    })();
  });
}

function getPlayer() { return document.getElementById("movie_player") || document.querySelector(".html5-video-player"); }
function getPopupContainer() { return document.querySelector("ytd-popup-container"); }

function getActiveVideoAmong(videos) {
  if (videos.length <= 1) return videos[0] || null;
  let best = null, bestArea = -1;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    const area = Math.max(0, w) * Math.max(0, h);
    if (area > bestArea) { bestArea = area; best = v; }
  }
  return best || videos[0];
}

function getVideo() {
  if (isShortsPage()) return getActiveVideoAmong(Array.from(document.querySelectorAll("video")));
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

function isShortsPage() { return location.pathname.startsWith("/shorts"); }
function isWatchPage() { return location.pathname.startsWith("/watch"); }
function isEmbedPage() { return location.pathname.startsWith("/embed"); }
function isAdShowing(p) { return !!p && p.classList.contains("ad-showing"); }
function isVolumePageAllowed() { return isWatchPage() || isShortsPage() || isEmbedPage(); }

function isPlayerReady() {
  const p = getPlayer();
  if (p && (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting"))) return false;
  const v = getVideo();
  return !!(v && v.readyState >= 1);
}

function isInRealPlayer(el) { return !!(el && el.closest && el.closest(REAL_PLAYER_SELECTOR)); }

function isMainVideoForVolume(v) {
  if (!(v instanceof HTMLVideoElement)) return false;
  if (v.closest(HOVER_PREVIEW_SELECTOR)) return false;
  if (isEmbedPage()) { const p = document.querySelector(".html5-video-player"); return !!(p && p.contains(v)); }
  for (const id of ["movie_player", "shorts-player", "c4-player"]) {
    const el = document.getElementById(id);
    if (el && el.contains(v)) return true;
  }
  const mini = document.querySelector("ytd-miniplayer");
  if (mini && mini.contains(v)) return true;
  return v.classList.contains("html5-main-video");
}

function volumeEnforcing(now) {
  if (volumeWindowUntil && now < volumeWindowUntil) return true;
  if (lastNavigationTime && now - lastNavigationTime < 5000) return true;
  return false;
}

function isOptionDisabled(el) {
  if (el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled")) return true;
  const cls = (el.className || "").toString().toLowerCase();
  if (/disabled|locked/.test(cls)) return true;
  if (el.querySelector('[class*="locked" i], [class*="lock-icon" i]')) return true;
  if (/pointer-events:\s*none/i.test(el.getAttribute("style") || "")) return true;
  return false;
}

function isPremiumRow(o) {
  return /premium/i.test(o.textContent || "") || !!o.querySelector('[class*="premium" i]');
}

// ---------- Premium upsell suppression ----------
const PREMIUM_DIALOG_SELECTOR = 'tp-yt-paper-dialog, [role="dialog"]';

function suppressPremiumDialogs(root) {
  if (!root || !root.querySelectorAll) return;
  const nodes = [];
  if (root.matches && root.matches(PREMIUM_DIALOG_SELECTOR)) nodes.push(root);
  root.querySelectorAll(PREMIUM_DIALOG_SELECTOR).forEach((n) => nodes.push(n));
  for (const dlg of nodes) {
    if (dlg.dataset.yccSuppressed) continue;
    if (!/premium/i.test(dlg.textContent || "")) continue;
    if (!dlg.querySelector("button, yt-button-shape, a")) continue;
    dlg.dataset.yccSuppressed = "1";
    dlg.style.display = "none";
    setTimeout(() => { try { dlg.remove(); } catch (e) {} }, 1000);
  }
}

let premiumSuppressObserver = null;
function startPremiumSuppressor() {
  if (premiumSuppressObserver) return;
  premiumSuppressObserver = new MutationObserver((muts) => {
    if (!settings || !settings.enabled || settings.blockPremiumPromos === false) return;
    for (const m of muts) m.addedNodes.forEach((node) => {
      if (node.nodeType === 1 && node.matches && node.matches(PREMIUM_DIALOG_SELECTOR)) suppressPremiumDialogs(node);
    });
  });
  premiumSuppressObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function startPremiumSweep() {
  if (premiumSweepInterval) return;
  premiumSweepInterval = setInterval(() => {
    if (!settings || !settings.enabled || settings.blockPremiumPromos === false) return;
    const pc = getPopupContainer();
    if (pc) suppressPremiumDialogs(pc);
  }, 2000);
}

// ---------- 1. Preferred quality ----------
let resolutionInFlight = false;
const MENU_ROOT_SELECTOR = '[role="menu"], .ytp-menu, .ytp-settings-menu, .ytp-panel, .ytp-panel-menu';
const ITEM_SELECTOR =
  '.ytp-settings-menu [role="menuitemradio"], .ytp-settings-menu [role="menuitem"], .ytp-settings-menu .ytp-menuitem, .ytp-panel-menu [role="menuitemradio"], .ytp-panel-menu [role="menuitem"], .ytp-panel-menu .ytp-menuitem, [role="menu"] [role="menuitemradio"], [role="menu"] [role="menuitem"], .ytp-menu [role="menuitemradio"], .ytp-menu .ytp-menuitem';
const RADIO_SELECTOR =
  '.ytp-panel-menu [role="menuitemradio"], .ytp-settings-menu [role="menuitemradio"], [role="menu"] [role="menuitemradio"], .ytp-menu [role="menuitemradio"]';
const RES_PATTERN = /\d{2,4}p(\d{1,3})?/i;

function queryMenuItems(player) {
  let items = Array.from(player.querySelectorAll(ITEM_SELECTOR));
  if (!items.length) { const pc = getPopupContainer(); if (pc) items = Array.from(pc.querySelectorAll(ITEM_SELECTOR)); }
  if (!items.length) items = Array.from(document.querySelectorAll(ITEM_SELECTOR));
  return items;
}
function queryMenuRadios(player) {
  let radios = Array.from(player.querySelectorAll(RADIO_SELECTOR));
  if (!radios.length) { const pc = getPopupContainer(); if (pc) radios = Array.from(pc.querySelectorAll(RADIO_SELECTOR)); }
  if (!radios.length) radios = Array.from(document.querySelectorAll(RADIO_SELECTOR));
  return radios;
}
function menuVisible(player, btn) {
  if (btn.getAttribute("aria-expanded") === "true") return true;
  let m = player.querySelector(MENU_ROOT_SELECTOR);
  if (!m) { const pc = getPopupContainer(); m = pc && pc.querySelector(MENU_ROOT_SELECTOR); }
  if (!m) m = document.querySelector(MENU_ROOT_SELECTOR);
  return !!(m && m.offsetParent !== null);
}

async function applyResolution() {
  if (!settings.enabled || !settings.resolutionEnabled) return;
  if (resolutionInFlight || isShortsPage()) return;
  const currentId = getVideoIdFromUrl(location.href);
  if (!currentId || qualityAppliedId === currentId || qualityAttempts >= 3) return;
  const player = getPlayer();
  if (!player || isAdShowing(player)) return;

  if (!isPlayerReady()) {
    if (!qualityRetryTimer) {
      let tries = 0;
      qualityRetryTimer = setInterval(() => {
        tries++;
        if (isPlayerReady() || tries >= 5) { clearInterval(qualityRetryTimer); qualityRetryTimer = null; applyResolution(); }
      }, 1500);
    }
    return;
  }

  const desired = settings.preferredResolution || "hd1080";
  const blockPromos = settings.blockPremiumPromos !== false;
  const settingsBtn = player.querySelector(".ytp-settings-button");
  if (!settingsBtn) return;

  for (let i = 0; i < 3 && menuVisible(player, settingsBtn); i++) { settingsBtn.click(); await wait(120); }

  if (!mpFloating) {
    const r = player.getBoundingClientRect();
    if (!(r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth)) return;
  }

  const hiddenRoots = [];
  function hideRoot(el) {
    if (!el) return;
    const root = (el.matches && el.matches(MENU_ROOT_SELECTOR)) ? el : el.closest(MENU_ROOT_SELECTOR);
    if (root && !hiddenRoots.includes(root)) { root.style.setProperty("display", "none", "important"); hiddenRoots.push(root); }
  }

  qualityAttempts++;
  resolutionInFlight = true;
  document.documentElement.classList.add("ycc-quiet-menus");
  player.querySelectorAll(MENU_ROOT_SELECTOR).forEach(hideRoot);
  const pc0 = getPopupContainer(); if (pc0) pc0.querySelectorAll(MENU_ROOT_SELECTOR).forEach(hideRoot);
  try {
    settingsBtn.click();
    const menuItems = await waitFor(() => { const i = queryMenuItems(player); return i.length ? i : null; }, 1500);
    if (!menuItems) return;
    hideRoot(menuItems[0]);
    const qualityItem = menuItems.find((mi) => {
      const t = mi.querySelector(".ytp-menuitem-content")?.textContent || mi.textContent || "";
      return RES_PATTERN.test(t) || /^\s*quality/i.test(mi.textContent || "");
    });
    if (!qualityItem) return;
    qualityAppliedId = currentId;

    const desiredLabel = QUALITY_LABELS[desired] || "1080p";
    const cur = (qualityItem.querySelector(".ytp-menuitem-content")?.textContent || qualityItem.textContent || "").trim();
    const isAuto = cur.includes("(");
    const correct = desired === "auto" ? isAuto : !isAuto && cur.startsWith(desiredLabel);
    if (!correct) {
      qualityItem.click();
      const options = await waitFor(() => {
        const radios = queryMenuRadios(player);
        const i = radios.length ? radios : queryMenuItems(player);
        return i.length ? i : null;
      }, 1500);
      if (options && options[0]) hideRoot(options[0]);
      if (options) {
        const selectable = options.filter((o) => !isOptionDisabled(o) && !(blockPromos && isPremiumRow(o)));
        const resOf = (o) => { const m = (o.textContent || "").match(/(\d{2,4})p/); return m ? parseInt(m[1], 10) : 0; };
        let target = null;
        if (desired === "auto") target = selectable.find((o) => !resOf(o)) || null;
        else {
          const dn = QUALITY_NUM[desired] || 1080;
          const numbered = selectable.map((o) => ({ o, n: resOf(o) })).filter((x) => x.n > 0);
          const low = numbered.filter((x) => x.n <= dn).sort((a, b) => b.n - a.n)[0];
          target = low ? low.o : null;
        }
        if (target) target.click();
      }
      await wait(150);
    }
  } catch (e) {}
  finally {
    for (let i = 0; i < 3 && menuVisible(player, settingsBtn); i++) { settingsBtn.click(); await wait(120); }
    document.documentElement.classList.remove("ycc-quiet-menus");
    hiddenRoots.forEach((r) => r.style.removeProperty("display"));
    if (blockPromos) setTimeout(() => suppressPremiumDialogs(getPopupContainer() || document.body), 300);
    resolutionInFlight = false;
  }
}

// ---------- 2. Default volume ----------
let volumeAppliedUrl = null;
const volumeAppliedVideos = new WeakSet();

function setVolumeTo(video, target) {
  let player = video && video.closest ? video.closest("#movie_player, #shorts-player, #c4-player, .html5-video-player, ytd-miniplayer") : null;
  if (!player) player = getPlayer();
  if (player && typeof player.setVolume === "function") {
    try {
      if (target > 0 && typeof player.isMuted === "function" && player.isMuted()) player.unMute();
      player.setVolume(target);
    } catch (e) {}
  }
  if (video) { try { video.volume = target / 100; if (video.muted && target > 0) video.muted = false; } catch (e) {} }
}

function scheduleVolumeReasserts(video, target) {
  [200, 1000, 2000, 3000, 4000, 5000].forEach((d) => setTimeout(() => {
    if (!settings || !settings.enabled || !settings.fixedVolumeEnabled || !isVolumePageAllowed()) return;
    const now = Date.now();
    if (isShortsPage()) { const u = shortsVolumeWindows.get(video); if (!((u && now < u) || volumeEnforcing(now))) return; }
    else if (!volumeEnforcing(now)) return;
    setVolumeTo(video, target);
  }, d));
}

function onVideoPlayCapture(e) {
  if (!settings || !settings.enabled || !settings.fixedVolumeEnabled || !isVolumePageAllowed()) return;
  const v = e.target; if (!(v instanceof HTMLVideoElement)) return;
  const target = Math.min(100, Math.max(0, Math.round(settings.fixedVolume ?? 50)));
  if (isShortsPage()) { if (!volumeAppliedVideos.has(v)) { volumeAppliedVideos.add(v); setVolumeTo(v, target); } return; }
  if (!isMainVideoForVolume(v) || volumeAppliedUrl === location.href) return;
  volumeAppliedUrl = location.href; setVolumeTo(v, target);
}

function onVideoPlayingCapture(e) {
  if (!settings || !settings.enabled || !settings.fixedVolumeEnabled || !isVolumePageAllowed()) return;
  const v = e.target; if (!(v instanceof HTMLVideoElement)) return;
  const target = Math.min(100, Math.max(0, Math.round(settings.fixedVolume ?? 50)));
  if (isShortsPage()) { setVolumeTo(v, target); shortsVolumeWindows.set(v, Date.now() + 3500); scheduleVolumeReasserts(v, target); return; }
  if (!isMainVideoForVolume(v)) return;
  setVolumeTo(v, target); volumeWindowUntil = Date.now() + 3500; scheduleVolumeReasserts(v, target);
}

function onVolumeChangeCapture(e) {
  if (!settings || !settings.enabled || !settings.fixedVolumeEnabled || !isVolumePageAllowed()) return;
  const v = e.target; if (!(v instanceof HTMLVideoElement)) return;
  const now = Date.now();
  const target = Math.min(100, Math.max(0, Math.round(settings.fixedVolume ?? 50)));
  if (isShortsPage()) { const u = shortsVolumeWindows.get(v); if ((u && now < u) || volumeEnforcing(now)) setVolumeTo(v, target); return; }
  if (!isMainVideoForVolume(v) || !volumeEnforcing(now)) return;
  setVolumeTo(v, target);
}

function applyVolumeNow() {
  if (!settings.enabled || !settings.fixedVolumeEnabled || !isVolumePageAllowed()) return;
  volumeAppliedUrl = location.href;
  setVolumeTo(getVideo(), Math.min(100, Math.max(0, Math.round(settings.fixedVolume ?? 50))));
}

// ---------- 3. Block volume scroll ----------
function handleVolumeWheel(e) {
  if (!settings || !settings.enabled || !settings.disableVolumeWheel) return;
  if (!(e.target instanceof Element)) return;
  if (e.target.closest(".ytp-volume-area, .ytp-volume-panel, .ytp-volume-control, .ytp-volume-bar")) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }
}

// ---------- 4. Mute hover previews ----------
const previewActed = new WeakSet();

function findPreviewMuteButton(container) {
  const buttons = Array.from(container.querySelectorAll("button, yt-button-shape, yt-icon-button, [role='button']"));
  for (const b of buttons) {
    const aria = (b.getAttribute("aria-label") || "").toLowerCase();
    const cls = (b.className || "").toString().toLowerCase();
    if (/mute|volume|sound|wycisz|dźwięk|stumm|lautlos|volumen|silencio|sourdine/i.test(aria)) return b;
    if (/volume|mute|sound/.test(cls)) return b;
  }
  for (const b of buttons) {
    const cls = (b.className || "").toString().toLowerCase();
    const aria = (b.getAttribute("aria-label") || "").toLowerCase();
    if (/subtitle|caption|\bcc\b|close|dismiss|expand|more|menu/.test(cls)) continue;
    if (/subtitle|caption|close|dismiss|expand|more|menu|zamknij|napisy/.test(aria)) continue;
    return b;
  }
  return null;
}

function previewIsUnmuted(btn, video) {
  const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
  if (aria) {
    if (/unmute|turn on sound|restore sound|sound on|wyłącz wyciszenie|włącz dźwięk|ton einschalten|activar son|activer le son/i.test(aria)) return false;
    if (/mute|wycisz|ton aus|silenciar|désactiver le son|silence/i.test(aria)) return true;
  }
  const pressed = btn.getAttribute("aria-pressed");
  if (pressed === "true") return false;
  if (pressed === "false") return true;
  if (video) return !video.muted;
  return true;
}

function ensurePreviewMuted(container) {
  if (previewActed.has(container) || isShortsPage() || isInRealPlayer(container)) return;
  const video = container.querySelector("video");
  if (isInRealPlayer(video)) return;
  previewActed.add(container);
  const doMute = () => {
    if (!container.isConnected) return;
    const b = findPreviewMuteButton(container);
    if (!b || isInRealPlayer(b)) return;
    if (previewIsUnmuted(b, video)) { try { b.click(); } catch (e) {} }
    setTimeout(() => {
      if (!container.isConnected) return;
      const b2 = findPreviewMuteButton(container);
      if (b2 && !isInRealPlayer(b2) && previewIsUnmuted(b2, video)) { try { b2.click(); } catch (e) {} }
    }, 300);
  };
  if (video) {
    let done = false;
    const onPlaying = () => { if (done) return; done = true; video.removeEventListener("playing", onPlaying, true); doMute(); };
    video.addEventListener("playing", onPlaying, true);
    setTimeout(() => { if (done) return; done = true; video.removeEventListener("playing", onPlaying, true); doMute(); }, 1200);
  } else setTimeout(doMute, 300);
}

let hoverPreviewObserver = null;
function startHoverPreviewObserver() {
  if (hoverPreviewObserver) return;
  hoverPreviewObserver = new MutationObserver((muts) => {
    if (!settings || !settings.enabled || !settings.muteHoverPreviews) return;
    for (const m of muts) m.addedNodes.forEach((n) => {
      if (n.nodeType === 1 && n.matches && n.matches(HOVER_PREVIEW_SELECTOR)) ensurePreviewMuted(n);
    });
  });
  hoverPreviewObserver.observe(document.documentElement, { childList: true, subtree: true });
}
function startHoverMute() { document.querySelectorAll(HOVER_PREVIEW_SELECTOR).forEach(ensurePreviewMuted); }
function stopHoverMute() {}

// ---------- 5. Prevent Shorts looping ----------
const shortsFixed = new WeakSet();
function stripLoop(v) { if (v.hasAttribute("loop")) v.removeAttribute("loop"); }
function neutralizeLoop(v) {
  stripLoop(v);
  if (shortsFixed.has(v)) return;
  shortsFixed.add(v);
  try { Object.defineProperty(v, "loop", { get() { return false; }, set() {}, configurable: true }); } catch (e) {}
}
function fixShortsLoop() {
  if (!settings.enabled || !settings.stopShortsLoop || !isShortsPage()) return;
  document.querySelectorAll("video").forEach(neutralizeLoop);
}
function startShortsSweep() {
  clearInterval(shortsSweepInterval);
  if (!settings.enabled || !settings.stopShortsLoop || !isShortsPage()) return;
  shortsSweepInterval = setInterval(fixShortsLoop, 500);
}

// ---------- 6. Auto-expand ----------
function isTheaterActive() {
  const f = document.querySelector("ytd-watch-flexy");
  if (f) return f.hasAttribute("theater");
  const b = document.querySelector(".ytp-size-button");
  const l = (b?.getAttribute("title") || b?.getAttribute("aria-label") || "").toLowerCase();
  if (l.includes("default")) return true;
  if (l.includes("theater")) return false;
  return false;
}
function autoExpandPlayer() {
  if (!settings.enabled || !settings.autoExpandEnabled || !isWatchPage() || expandAppliedUrl === location.href) return;
  const b = document.querySelector(".ytp-size-button");
  if (!b) return;
  if (isTheaterActive()) { expandAppliedUrl = location.href; return; }
  b.click(); expandAppliedUrl = location.href;
}

// ---------- 7. Captions ----------
function applyCaptions() {
  if (!settings.enabled || !settings.captionsControlEnabled) return;
  if (!isWatchPage() && !isShortsPage() && !isEmbedPage()) return;
  const p = getPlayer(); if (!p || !isPlayerReady()) return;
  const on = settings.captionsMode === "on";
  if (typeof p.isSubtitlesOn === "function") {
    try {
      if (p.isSubtitlesOn() !== on && Date.now() - lastCaptionsToggle >= 8000 && typeof p.toggleSubtitlesOn === "function") {
        p.toggleSubtitlesOn(on); lastCaptionsToggle = Date.now();
      }
    } catch (e) {}
    return;
  }
  const b = document.querySelector(".ytp-subtitles-button");
  if (b && (b.getAttribute("aria-pressed") === "true") !== on && Date.now() - lastCaptionsToggle >= 8000) { b.click(); lastCaptionsToggle = Date.now(); }
}

// ---------- 8. Mini player ----------
const MP_CORNER_CLASSES = ["ycc-mp-corner-tl", "ycc-mp-corner-tr", "ycc-mp-corner-bl", "ycc-mp-corner-br"];
const MP_CORNER_MAP = { "top-left": "ycc-mp-corner-tl", "top-right": "ycc-mp-corner-tr", "bottom-left": "ycc-mp-corner-bl", "bottom-right": "ycc-mp-corner-br" };
const MP_ORIGIN_MAP = { "top-left": "top left", "top-right": "top right", "bottom-left": "bottom left", "bottom-right": "bottom right" };
let mpObserver = null, mpObserverPlayerRef = null, mpObservedTarget = null;
let mpSpacer = null, mpWrapper = null, mpFloating = false, mpCloseBtn = null;
let mpNaturalWidth = 0, mpNaturalHeight = 0;

function getCornerClass() { return MP_CORNER_MAP[settings.miniplayerCorner] || "ycc-mp-corner-br"; }
function getTransformOrigin() { return MP_ORIGIN_MAP[settings.miniplayerCorner] || "bottom right"; }
function parseMiniplayerSize() {
  const m = /^(\d+)x(\d+)$/i.exec((settings.miniplayerSize || "").trim());
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : { w: 400, h: 225 };
}
function applyMiniplayerScale(w) {
  if (mpNaturalWidth <= 0) return;
  const s = parseMiniplayerSize().w / mpNaturalWidth;
  w.style.transform = `scale(${s})`; w.style.transformOrigin = getTransformOrigin();
  if (mpCloseBtn) { mpCloseBtn.style.transform = `scale(${1 / s})`; mpCloseBtn.style.transformOrigin = "top right"; }
}
function isNativeExpandedState(p) {
  if (document.fullscreenElement || (p && p.classList.contains("ytp_fullscreen"))) return true;
  const n = document.querySelector("ytd-miniplayer");
  return !!(n && (n.hasAttribute("active") || n.hasAttribute("is-active")));
}
function updateMiniplayerCorner() {
  if (!mpFloating || !mpWrapper) return;
  mpWrapper.classList.remove(...MP_CORNER_CLASSES); mpWrapper.classList.add(getCornerClass());
  mpWrapper.style.transformOrigin = getTransformOrigin();
}
function updateMiniplayerSize() { if (mpFloating && mpWrapper) applyMiniplayerScale(mpWrapper); }

function engageMiniplayer(p) {
  if (mpFloating || isNativeExpandedState(p)) return;
  const r = p.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return;
  mpNaturalWidth = r.width; mpNaturalHeight = r.height;
  mpSpacer = document.createElement("div"); mpSpacer.className = "ycc-mp-spacer";
  mpSpacer.style.width = r.width + "px"; mpSpacer.style.height = r.height + "px";
  p.parentNode.insertBefore(mpSpacer, p);
  mpWrapper = document.createElement("div"); mpWrapper.className = "ycc-mp-wrapper " + getCornerClass();
  mpWrapper.style.width = mpNaturalWidth + "px"; mpWrapper.style.height = mpNaturalHeight + "px";
  document.body.appendChild(mpWrapper); mpWrapper.appendChild(p);
  mpCloseBtn = document.createElement("button"); mpCloseBtn.className = "ycc-mp-close"; mpCloseBtn.type = "button";
  mpCloseBtn.textContent = "✕"; mpCloseBtn.setAttribute("aria-label", "Restore player");
  mpCloseBtn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); if (mpSpacer) mpSpacer.scrollIntoView({ behavior: "smooth", block: "start" }); });
  mpWrapper.appendChild(mpCloseBtn);
  applyMiniplayerScale(mpWrapper); mpFloating = true;
  if (mpObserver) { if (mpObservedTarget) mpObserver.unobserve(mpObservedTarget); mpObserver.observe(mpSpacer); mpObservedTarget = mpSpacer; }
}
function restoreFromFloat(p) {
  if (mpSpacer) { mpSpacer.after(p); mpSpacer.remove(); mpSpacer = null; }
  if (mpWrapper) { mpWrapper.remove(); mpWrapper = null; }
  mpCloseBtn = null; mpNaturalWidth = 0; mpNaturalHeight = 0; mpFloating = false;
}
function disengageMiniplayer(p) {
  if (!mpFloating) return;
  restoreFromFloat(p);
  if (mpObserver) { if (mpObservedTarget) mpObserver.unobserve(mpObservedTarget); mpObserver.observe(p); mpObservedTarget = p; }
}
function handleMiniplayerIntersection(entries) {
  if (!settings || !settings.enabled || !settings.miniplayerEnabled || isShortsPage() || !isWatchPage()) return;
  const p = getPlayer(); if (!p) return;
  for (const en of entries) {
    if (en.target === mpSpacer) { if (en.isIntersecting) disengageMiniplayer(p); }
    else if (en.target === p) { if (!en.isIntersecting && en.boundingClientRect.bottom <= 0) engageMiniplayer(p); }
  }
}
function stopMiniplayerObserving() {
  const p = getPlayer(); if (mpFloating && p) restoreFromFloat(p);
  if (mpObserver) { mpObserver.disconnect(); mpObserver = null; }
  mpObservedTarget = null; mpObserverPlayerRef = null;
}
function startMiniplayerObserving() {
  if (!settings.enabled || !settings.miniplayerEnabled || isShortsPage() || !isWatchPage()) { stopMiniplayerObserving(); return; }
  const p = getPlayer(); if (!p || (mpObserver && mpObserverPlayerRef === p)) return;
  stopMiniplayerObserving();
  mpObserver = new IntersectionObserver(handleMiniplayerIntersection, { threshold: 0 });
  mpObserver.observe(p); mpObservedTarget = p; mpObserverPlayerRef = p;
}

// ---------- 9. Hide cards / end screens ----------
function applyHideCardsEndscreens() {
  document.documentElement.classList.toggle("ycc-hide-cards-endscreens", !!(settings.enabled && settings.hideCardsEndscreens));
}

// ---------- 10. No translations ----------
const FALLBACK_INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const FALLBACK_INNERTUBE_CLIENT_VERSION = "2.20240111.09.00";
let cachedInnertubeConfig = null;

function extractInnertubeConfig() {
  if (cachedInnertubeConfig) return cachedInnertubeConfig;
  let apiKey = FALLBACK_INNERTUBE_API_KEY, cv = FALLBACK_INNERTUBE_CLIENT_VERSION;
  try {
    const html = document.documentElement.innerHTML;
    const k = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/); const v = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
    if (k) apiKey = k[1]; if (v) cv = v[1];
  } catch (e) {}
  cachedInnertubeConfig = { apiKey, clientVersion: cv };
  return cachedInnertubeConfig;
}

function getVideoIdFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, location.origin);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const s = u.pathname.match(/\/shorts\/([\w-]{6,})/); if (s) return s[1];
    const e = u.pathname.match(/\/embed\/([\w-]{6,})/); if (e) return e[1];
  } catch (e) {}
  return null;
}

function fetchWithTimeout(url, options, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...options, signal: c.signal }).finally(() => clearTimeout(t));
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

async function fetchTitleFromWatchPage(id) {
  try {
    const r = await fetchWithTimeout("https://www.youtube.com/watch?v=" + encodeURIComponent(id) + "&hl=en&persist_hl=1", { credentials: "omit" }, 6000);
    if (!r.ok) return null;
    const m = (await r.text()).match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/);
    return m ? decodeEntities(m[1]).replace(/\s*-\s*YouTube\s*$/, "") || null : null;
  } catch (e) { return null; }
}
async function fetchDescriptionFallback(id) {
  try {
    const r = await fetchWithTimeout("https://www.youtube.com/watch?v=" + encodeURIComponent(id) + "&hl=en&persist_hl=1", { credentials: "omit" }, 6000);
    if (!r.ok) return null;
    const m = (await r.text()).match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch (e) { return null; }
}

function textOf(t) {
  if (!t) return "";
  if (typeof t.simpleText === "string") return t.simpleText.trim();
  if (Array.isArray(t.runs)) return t.runs.map((x) => x.text || "").join("").trim();
  return "";
}
function timeStringToSeconds(s) {
  const p = String(s).trim().split(":").map(Number);
  if (p.length === 2 && p.every((n) => !isNaN(n))) return p[0] * 60 + p[1];
  if (p.length === 3 && p.every((n) => !isNaN(n))) return p[0] * 3600 + p[1] * 60 + p[2];
  return 0;
}
function finalizeChapters(l) { if (!l.length) return null; l.sort((a, b) => a.startMillis - b.startMillis); return l; }
function extractChapters(data) {
  try {
    const mm = data?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBar?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;
    if (Array.isArray(mm)) for (const en of mm) {
      const ch = en?.value?.chapters; if (!Array.isArray(ch) || !ch.length) continue;
      const l = []; for (const c of ch) { const r = c?.chapterRenderer; if (!r) continue; const t = textOf(r.title); if (t) l.push({ title: t, startMillis: Number(r.timeRangeStartMillis || 0) }); }
      const d = finalizeChapters(l); if (d) return d;
    }
    const panels = data?.engagementPanels;
    if (Array.isArray(panels)) for (const p of panels) {
      const cs = p?.engagementPanelSectionListRenderer?.content?.sectionListRenderer?.contents; if (!Array.isArray(cs)) continue;
      for (const c of cs) {
        const it = c?.macroMarkersListRenderer?.items; if (!Array.isArray(it) || !it.length) continue;
        const l = []; for (const i of it) { const r = i?.macroMarkersListItemRenderer; if (!r) continue; const t = textOf(r.title); if (t) l.push({ title: t, startMillis: timeStringToSeconds(textOf(r.timeSnippet)) * 1000 }); }
        const d = finalizeChapters(l); if (d) return d;
      }
    }
  } catch (e) {}
  return null;
}
function parseChaptersFromDescription(desc) {
  if (!desc) return null;
  const TS = /(\d{1,2}:\d{2}(?::\d{2})?)/;
  const lines = desc.split(/\r?\n/);
  const has = lines.map((l) => { const t = l.trim(); return t.length > 0 && TS.test(t); });
  const l = [];
  lines.forEach((line, i) => {
    const t = line.trim(); if (!t) return;
    const m = t.match(TS); if (!m) return;
    let before = false, after = false;
    for (let j = i - 1; j >= 0; j--) { if (!lines[j].trim()) continue; before = has[j]; break; }
    for (let j = i + 1; j < lines.length; j++) { if (!lines[j].trim()) continue; after = has[j]; break; }
    if (!before && !after) return;
    const ts = m[1], idx = m.index;
    let title = (idx === 0 || /^[-–—•·▪▫⁃→>*\s]+$/.test(t.substring(0, idx))) ? t.substring(idx + ts.length) : t.substring(0, idx);
    title = title.replace(/^[-–—•·▪▫⁃→>*\s]+/, "").replace(/[-–—•·▪▫⁃→>*\s]+$/, "").trim();
    if (title.length < 2) return;
    l.push({ title, startMillis: timeStringToSeconds(ts) * 1000 });
  });
  return l.length < 2 ? null : finalizeChapters(l);
}

const videoMetaCache = new Map();
const titleCacheSync = new Map();
function cacheTitle(id, t) { if (!id || !t) return; titleCacheSync.set(id, t); if (titleCacheSync.size > 300) titleCacheSync.delete(titleCacheSync.keys().next().value); }

function fetchOriginalVideoMeta(id) {
  if (!id) return Promise.resolve(null);
  if (videoMetaCache.has(id)) return videoMetaCache.get(id);
  const promise = (async () => {
    let title = null, description = null, chapters = null;
    if (getVideoIdFromUrl(location.href) === id) {
      let p = getPlayer(); if (isShortsPage()) p = document.getElementById("shorts-player") || p;
      if (p && typeof p.getPlayerResponse === "function") {
        try { const r = p.getPlayerResponse(); if (r?.videoDetails?.title) title = r.videoDetails.title; if (r?.videoDetails?.shortDescription) description = r.videoDetails.shortDescription; } catch (e) {}
      }
    }
    if (!title) { try { const r = await fetchWithTimeout("https://www.youtube.com/oembed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id) + "&format=json", { credentials: "omit" }, 6000); if (r.ok) title = (await r.json()).title || null; } catch (e) {} }
    const { apiKey, clientVersion } = extractInnertubeConfig();
    try {
      const r = await fetchWithTimeout("https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(apiKey), {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", "X-Youtube-Client-Name": "1", "X-Youtube-Client-Version": clientVersion },
        body: JSON.stringify({ videoId: id, context: { client: { clientName: "WEB", clientVersion } } }),
      }, 6000);
      if (r.ok) { const d = await r.json(); if (!title) title = d?.videoDetails?.title || null; if (!description) description = d?.videoDetails?.shortDescription || null; if (!chapters) chapters = extractChapters(d); }
    } catch (e) {}
    if (!title) title = await fetchTitleFromWatchPage(id);
    if (!description) description = await fetchDescriptionFallback(id);
    if (!chapters) chapters = parseChaptersFromDescription(description);
    return title ? { title, description, chapters } : null;
  })();
  videoMetaCache.set(id, promise);
  promise.then((m) => { if (!m) videoMetaCache.delete(id); else cacheTitle(id, m.title); });
  if (videoMetaCache.size > 300) videoMetaCache.delete(videoMetaCache.keys().next().value);
  return promise;
}

function markOriginalApplied(el, k) { el.dataset.yccOrigKey = k; }
function isOriginalAppliedFor(el, k) { return el.dataset.yccOrigKey === k; }

async function applyMainTitle() {
  if (!isWatchPage()) return;
  const id = getVideoIdFromUrl(location.href); if (!id) return;
  const meta = await fetchOriginalVideoMeta(id);
  if (!settings.enabled || !settings.noTranslationEnabled || getVideoIdFromUrl(location.href) !== id || !meta?.title) return;
  const targets = document.querySelectorAll("ytd-watch-metadata h1 yt-formatted-string, #title h1 yt-formatted-string, ytd-watch-metadata h1 yt-dynamic-sizing-formatted-string, #title h1 yt-dynamic-sizing-formatted-string");
  targets.forEach((t) => {
    if (!t.isConnected) return;
    const cur = (t.textContent || "").trim();
    if (cur === meta.title) { if (t.hasAttribute("is-empty")) t.removeAttribute("is-empty"); markOriginalApplied(t, id); return; }
    t.textContent = meta.title;
    if (t.hasAttribute("title")) t.setAttribute("title", meta.title);
    t.removeAttribute("is-empty"); markOriginalApplied(t, id);
    if (cur && document.title.includes(cur)) document.title = document.title.replace(cur, meta.title);
    if (!t.dataset.yccIsEmptyObserver) {
      t.dataset.yccIsEmptyObserver = "1";
      new MutationObserver((ms) => { for (const m of ms) if (m.attributeName === "is-empty" && t.hasAttribute("is-empty")) t.removeAttribute("is-empty"); })
        .observe(t, { attributes: true, attributeFilter: ["is-empty"] });
    }
  });
}

async function applyEmbedTitle() {
  if (!isEmbedPage()) return;
  const l = document.querySelector(".ytp-title-link, a.ytp-title-link, .ytp-title a"); if (!l) return;
  const id = getVideoIdFromUrl(l.getAttribute("href") || location.href); if (!id) return;
  const k = id + ":embedtitle"; if (isOriginalAppliedFor(l, k)) return;
  const meta = await fetchOriginalVideoMeta(id);
  if (!settings.enabled || !settings.noTranslationEnabled || !meta?.title) return;
  if (l.textContent !== meta.title) l.textContent = meta.title;
  if (l.hasAttribute("title")) l.setAttribute("title", meta.title);
  markOriginalApplied(l, k);
}

// NOTE: no `ytd-reel-video-renderer #title` here - on the Shorts watch page
// that node is the sound/remix name, not the video title.
const FEED_TITLE_SELECTOR =
  "#video-title, h3[title] > a > span[role='text'], h3 > a > span[role='text'], yt-lockup-view-model h3 span[role='text'], yt-lockup-view-model [slot='title'] span, ytd-rich-grid-media #video-title, ytd-rich-grid-media h3 a span, yt-shorts-video-title-view-model h1 span[role='text'], yt-shorts-video-title-view-model h2 span[role='text'], yt-shorts-video-title-view-model [class*='ShortsVideoTitle'] span, ytd-notification-renderer #message yt-formatted-string, #notification-title";
const CARD_SELECTOR =
  "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, ytd-reel-video-renderer, ytd-notification-renderer, yt-lockup-view-model, ytd-rich-grid-media";

function getTitleVideoId(el) {
  // On the Shorts watch page the main title always belongs to the video in
  // the address bar. Never resolve it from a link inside the reel - those
  // links point to the background sound/remix (a different video), which
  // previously caused a wrong title to be printed.
  if (isShortsPage() && el.closest("yt-shorts-video-title-view-model, ytd-reel-video-renderer[is-active]")) {
    return getVideoIdFromUrl(location.href);
  }
  let link = el.closest("a");
  if (!link) { const c = el.closest(CARD_SELECTOR); link = c && c.querySelector('a[href^="/watch"], a[href^="/shorts/"]'); }
  let id = getVideoIdFromUrl(link && link.getAttribute("href"));
  if (!id && isShortsPage()) id = getVideoIdFromUrl(location.href);
  return id || null;
}

async function applyFeedTitle(el) {
  const id = getTitleVideoId(el); if (!id) return;
  if (el.dataset.yccTitleFor === id) {
    const meta = await fetchOriginalVideoMeta(id);
    if (meta?.title && el.isConnected && el.textContent !== meta.title) { el.textContent = meta.title; if (el.hasAttribute("title")) el.setAttribute("title", meta.title); }
    return;
  }
  const expected = el.textContent;
  const meta = await fetchOriginalVideoMeta(id);
  if (!settings.enabled || !settings.noTranslationEnabled || !meta?.title || !el.isConnected || el.textContent !== expected) return;
  if (expected !== meta.title) { el.textContent = meta.title; if (el.hasAttribute("title")) el.setAttribute("title", meta.title); }
  el.dataset.yccTitleFor = id;
}

function scheduleTitleRescan() {
  if (titleRescanTimer || titleRescanCount >= 3) return;
  titleRescanTimer = setTimeout(() => { titleRescanTimer = null; titleRescanCount++; scanFeedTitles(); }, 2000);
}

function scanFeedTitles() {
  if (!settings.enabled || !settings.noTranslationEnabled) return;
  const nodes = [];
  document.querySelectorAll(FEED_TITLE_SELECTOR).forEach((el) => nodes.push(el));
  document.querySelectorAll(".shortsLockupViewModelHostEndpoint").forEach((a) => { const s = a.querySelector("span[role='text']") || a.querySelector("span"); if (s) nodes.push(s); });
  let budget = 12, deferred = false;
  for (const el of nodes) {
    const id = getTitleVideoId(el); if (!id) continue;
    const cached = titleCacheSync.get(id); const marked = el.dataset.yccTitleFor === id;
    if (marked && cached && el.textContent === cached) continue;
    const cheap = marked || videoMetaCache.has(id);
    if (cheap || budget > 0) { if (!cheap) budget--; applyFeedTitle(el); } else deferred = true;
  }
  if (deferred) scheduleTitleRescan();
}

let searchSnippetStyleInjected = false;
function ensureSearchSnippetStyle() {
  if (searchSnippetStyleInjected || document.getElementById("ycc-search-style")) { searchSnippetStyleInjected = true; return; }
  const s = document.createElement("style"); s.id = "ycc-search-style";
  s.textContent = `
    .metadata-snippet-text[ycc-search]{display:none!important;}
    .metadata-snippet-container[ycc-search]::after,.metadata-snippet-container-one-line[ycc-search]::after{content:attr(data-original-description);font-size:var(--ytd-tab-system-font-size-body,1.2rem);line-height:var(--ytd-tab-system-line-height-body,1.6rem);font-family:var(--ytd-tab-system-font-family,inherit);color:var(--yt-spec-text-secondary,#aaa);white-space:pre-line;}
    ytd-video-renderer #description-text[ycc-search]{display:block!important;color:var(--yt-spec-text-secondary,#aaa);white-space:pre-line;}
  `;
  document.head.appendChild(s); searchSnippetStyleInjected = true;
}
function truncateDescription(d) { const s = d.split("\n").slice(0, 2).join("\n"); return s.length > 100 ? s.substring(0, 100) + "..." : s; }

async function applyFeedDescription(el) {
  const container = el.closest(".metadata-snippet-container, .metadata-snippet-container-one-line");
  let link = el.closest('a[href*="/watch"], a[href*="/shorts/"]');
  if (!link) { const c = el.closest(CARD_SELECTOR); link = c && c.querySelector('a[href*="/watch"], a[href*="/shorts/"]'); }
  const id = getVideoIdFromUrl(link && link.getAttribute("href")); if (!id) return;
  if (el.getAttribute("ycc-search") === id && (!container || (container.getAttribute("ycc-search") === id && container.hasAttribute("data-original-description")))) return;
  const meta = await fetchOriginalVideoMeta(id);
  if (!settings.enabled || !settings.noTranslationEnabled || !meta?.description) return;
  ensureSearchSnippetStyle();
  const trunc = truncateDescription(meta.description);
  if (container) { container.setAttribute("data-original-description", trunc); container.setAttribute("ycc-search", id); el.setAttribute("ycc-search", id); el.setAttribute("translate", "no"); }
  else if (el.id === "description-text") { el.textContent = trunc; el.setAttribute("ycc-search", id); }
  else {
    const cur = (el.textContent || "").trim(); const norm = meta.description.replace(/\s+/g, " ").trim();
    let text = norm; if (cur.length && norm.length > cur.length) text = norm.slice(0, Math.max(1, cur.length - 1)).trimEnd() + "…";
    if (cur !== text) el.textContent = text; el.setAttribute("ycc-search", id);
  }
}
function scanFeedDescriptions() {
  if (!settings.enabled || !settings.noTranslationEnabled) return;
  document.querySelectorAll(".metadata-snippet-text, #description-text").forEach((el) => applyFeedDescription(el));
}

async function applyOriginalDescription() {
  if (!isWatchPage()) return;
  const id = getVideoIdFromUrl(location.href); if (!id) return;
  const el = document.querySelector("ytd-text-inline-expander#description-inline-expander yt-attributed-string, #description-inline-expander yt-attributed-string, #description yt-attributed-string");
  if (!el || isOriginalAppliedFor(el, id)) return;
  const meta = await fetchOriginalVideoMeta(id);
  if (!settings.enabled || !settings.noTranslationEnabled || getVideoIdFromUrl(location.href) !== id || !meta?.description) return;
  el.textContent = meta.description; markOriginalApplied(el, id);
}

let cachedChapters = [], cachedChaptersVideoId = null, chapterUpdateInterval = null;
function findChapterByTime(s, ch) { let c = null; for (const x of ch) { if (x.startMillis / 1000 <= s) c = x; else break; } return c; }
function getCurrentVideoTime() { const p = getPlayer(); const v = (p && p.querySelector("video")) || getVideo(); return v ? Math.floor(v.currentTime || 0) : 0; }
async function ensureChapters(id) {
  if (cachedChaptersVideoId === id) return cachedChapters;
  const m = await fetchOriginalVideoMeta(id);
  cachedChapters = (m && m.chapters) || []; cachedChaptersVideoId = id; return cachedChapters;
}
function replaceIfDifferent(el, t) { if (!el) return; const c = (el.textContent || "").trim(); if (c && c !== t) el.textContent = t; }
function updateChapterButton(ch) { const el = document.querySelector(".ytp-chapter-title .ytp-chapter-title-content"); if (!el) return; const c = findChapterByTime(getCurrentVideoTime(), ch); if (c) replaceIfDifferent(el, c.title); }
function updateChapterTooltip(ch) {
  const tip = document.querySelector('.ytp-tooltip.ytp-preview:not([style*="display: none"])'); if (!tip) return;
  let t = tip.querySelector(".ytp-tooltip-progress-bar-pill-time-stamp"), ti = tip.querySelector(".ytp-tooltip-progress-bar-pill-title");
  if (!t || !ti) { t = tip.querySelector(".ytp-tooltip-text"); ti = tip.querySelector(".ytp-tooltip-title span"); }
  if (!t || !ti || !(t.textContent || "").trim()) return;
  const c = findChapterByTime(timeStringToSeconds(t.textContent), ch); if (c) replaceIfDifferent(ti, c.title);
}
function updateChapterPanel(ch) {
  const p = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-description-chapters"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]'); if (!p) return;
  p.querySelectorAll("ytd-macro-markers-list-item-renderer .macro-markers").forEach((el) => {
    const t = el.closest("ytd-macro-markers-list-item-renderer")?.querySelector("#time"); if (!t) return;
    const c = findChapterByTime(timeStringToSeconds(t.textContent || ""), ch); if (c) replaceIfDifferent(el, c.title);
  });
}
function stopChapterUpdater() { clearInterval(chapterUpdateInterval); chapterUpdateInterval = null; }
async function applyOriginalChapters() {
  if (!isWatchPage() || !settings.enabled || !settings.noTranslationEnabled) { stopChapterUpdater(); return; }
  const id = getVideoIdFromUrl(location.href); if (!id) return;
  const ch = await ensureChapters(id); if (!ch.length) { stopChapterUpdater(); return; }
  const run = () => { updateChapterButton(ch); updateChapterTooltip(ch); updateChapterPanel(ch); };
  run(); if (!chapterUpdateInterval) chapterUpdateInterval = setInterval(run, 400);
}

let translationObserver = null, translationScanTimer = null;
function scheduleTranslationScan() {
  clearTimeout(translationScanTimer);
  translationScanTimer = setTimeout(() => { applyMainTitle(); scanFeedTitles(); scanFeedDescriptions(); applyOriginalChapters(); applyEmbedTitle(); }, 900);
}
function startTranslationObserver() {
  if (translationObserver) return;
  translationObserver = new MutationObserver(() => { if (settings && settings.enabled && settings.noTranslationEnabled) scheduleTranslationScan(); });
  translationObserver.observe(document.documentElement, { childList: true, subtree: true });
}
function stopTranslationObserver() { if (translationObserver) { translationObserver.disconnect(); translationObserver = null; } clearTimeout(translationScanTimer); }
function applyNoTranslation() {
  if (!(settings.enabled && settings.noTranslationEnabled)) { stopTranslationObserver(); stopChapterUpdater(); return; }
  startTranslationObserver(); applyMainTitle(); applyOriginalDescription(); scanFeedTitles(); scanFeedDescriptions(); applyOriginalChapters(); applyEmbedTitle();
}
function scheduleFirstTranslationRun() {
  setTimeout(() => applyNoTranslation(), 2500);
  setTimeout(() => { if (settings && settings.enabled && settings.noTranslationEnabled) applyNoTranslation(); }, 6000);
}

// ---------- 11. Prevent accidental Shorts scrolling ----------
let shortsWheelAccumulator = 0, shortsWheelResetTimer = null, shortsSettleUntil = 0;
const SHORTS_WHEEL_THRESHOLD = 200;
const SHORTS_WHEEL_RESET_MS = 300;
const SHORTS_SETTLE_MS = 800;
const SHORTS_WHEEL_EXEMPT_SELECTOR =
  "ytd-comments, ytd-engagement-panel-section-list-renderer, #panels, #secondary, #related, #guide, #masthead-container, header, ytd-rich-section-renderer, ytd-shelf-renderer";
const SHORTS_WHEEL_STAGE_SELECTOR =
  "ytd-shorts, #shorts-container, #page-container, ytd-reel-video-renderer, #player-container";

function switchShorts(dir) {
  const down = document.getElementById("navigation-button-down");
  const up = document.getElementById("navigation-button-up");
  const wrap = dir > 0 ? down : up;
  const btn = wrap && (wrap.querySelector("button") || wrap);
  if (btn && typeof btn.click === "function") { btn.click(); return; }
  let sc = document.querySelector("ytd-reel-video-renderer[is-active], ytd-reel-video-renderer");
  while (sc && sc !== document.body) {
    const st = getComputedStyle(sc);
    if (/(auto|scroll)/.test(st.overflowY) && sc.scrollHeight > sc.clientHeight + 4) break;
    sc = sc.parentElement;
  }
  const target = (sc && sc !== document.body) ? sc : (document.querySelector("#shorts-container") || document.scrollingElement);
  if (target) target.scrollBy({ top: dir * target.clientHeight, behavior: "smooth" });
}

function handleShortsWheel(e) {
  if (!settings || !settings.enabled || !settings.disableShortsWheelScroll || !isShortsPage()) return;
  if (!(e.target instanceof Element)) return;
  if (e.target.closest(SHORTS_WHEEL_EXEMPT_SELECTOR)) return;
  if (!e.target.closest(SHORTS_WHEEL_STAGE_SELECTOR)) return;
  const now = performance.now();
  if (now < shortsSettleUntil) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 30;
  if (e.deltaMode === 2) delta *= innerHeight;
  if ((shortsWheelAccumulator > 0 && delta < 0) || (shortsWheelAccumulator < 0 && delta > 0)) shortsWheelAccumulator = 0;
  shortsWheelAccumulator += delta;
  clearTimeout(shortsWheelResetTimer);
  shortsWheelResetTimer = setTimeout(() => { shortsWheelAccumulator = 0; }, SHORTS_WHEEL_RESET_MS);
  if (Math.abs(shortsWheelAccumulator) >= SHORTS_WHEEL_THRESHOLD) {
    const dir = shortsWheelAccumulator > 0 ? 1 : -1;
    shortsWheelAccumulator = 0;
    shortsSettleUntil = now + SHORTS_SETTLE_MS;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    switchShorts(dir);
    return;
  }
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
}

// ---------- Orchestration ----------

function applyAll() {
  if (!settings) return;
  applyResolution(); fixShortsLoop(); startShortsSweep(); autoExpandPlayer();
  applyCaptions(); startMiniplayerObserving(); applyHideCardsEndscreens();
}

function onNavigate() {
  clearTimeout(navigateTimer);
  const id = getVideoIdFromUrl(location.href);
  if (id !== lastNavVideoId) {
    lastNavVideoId = id; volumeAppliedUrl = null; qualityAppliedId = null;
    qualityAttempts = 0; expandAppliedUrl = null; titleRescanCount = 0;
  }
  lastNavigationTime = Date.now();
  applyVolumeNow();
  navigateTimer = setTimeout(applyAll, 400);
  setTimeout(applyAll, 1200);
  setTimeout(applyResolution, 4000);
  setTimeout(applyResolution, 6000);
  scheduleFirstTranslationRun();
}

function init() {
  console.info("[YPI] content.js build " + BUILD_TAG);
  startPremiumSuppressor(); startPremiumSweep(); startHoverPreviewObserver();
  loadSettings().then(() => {
    applyAll(); scheduleFirstTranslationRun();
    if (settings.enabled && settings.muteHoverPreviews) startHoverMute();
  });
  addEventListener("yt-navigate-finish", onNavigate);
  addEventListener("yt-page-data-updated", onNavigate);
  document.addEventListener("wheel", handleShortsWheel, { capture: true, passive: false });
  document.addEventListener("wheel", handleVolumeWheel, { capture: true, passive: false });
  document.addEventListener("play", onVideoPlayCapture, true);
  document.addEventListener("playing", onVideoPlayingCapture, true);
  document.addEventListener("volumechange", onVolumeChangeCapture, true);
  setInterval(() => {
    if (!settings) return;
    fixShortsLoop(); autoExpandPlayer(); applyCaptions(); startMiniplayerObserving(); applyHideCardsEndscreens();
  }, 10000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
})();