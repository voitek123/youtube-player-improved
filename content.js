// content.js - Youtube Player Improved
// Runs on youtube.com AND on embedded players. Re-applies its behavior
// every time YouTube's single-page-app navigates (yt-navigate-finish).
(function () {
"use strict";

const BUILD_TAG = "ypi-1.3.4";

const QUALITY_LABELS = {
  auto: "Auto", hd2160: "2160p", hd1440: "1440p", hd1080: "1080p",
  hd720: "720p", large: "480p", medium: "360p", small: "240p", tiny: "144p",
};
const QUALITY_ORDER = ["hd2160", "hd1440", "hd1080", "hd720", "large", "medium", "small", "tiny"];
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

let settings = {};
let navigateTimer = null;
let captionsRetryTimer = null;
let shortsSweepInterval = null;
let hoverMuteInterval = null;
let qualityAppliedUrl = null;
let expandAppliedUrl = null;

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
    qualityAppliedUrl = null; // a settings change may re-apply quality
    applyResolution();
  }
  if (changedKeys.some((k) => KEY_GROUPS.volume.includes(k))) applyVolumeNow();
  if (changedKeys.some((k) => KEY_GROUPS.hover.includes(k))) {
    if (settings.enabled && settings.muteHoverPreviews) startHoverMute(); else stopHoverMute();
  }
  if (changedKeys.some((k) => KEY_GROUPS.shorts.includes(k))) { fixShortsLoop(); startShortsSweep(); }
  if (changedKeys.some((k) => KEY_GROUPS.expand.includes(k))) { expandAppliedUrl = null; autoExpandPlayer(); }
  if (changedKeys.some((k) => KEY_GROUPS.captions.includes(k))) { applyCaptions(); scheduleCaptionsRetries(); }
  if (changedKeys.some((k) => KEY_GROUPS.miniplayer.includes(k))) {
    const structuralChange = changedKeys.includes("enabled") || changedKeys.includes("miniplayerEnabled");
    if (structuralChange) startMiniplayerObserving();
    else {
      if (changedKeys.includes("miniplayerCorner")) updateMiniplayerCorner();
      if (changedKeys.includes("miniplayerSize")) updateMiniplayerSize();
    }
  }
  if (changedKeys.some((k) => KEY_GROUPS.cardsEndscreens.includes(k))) applyHideCardsEndscreens();
  if (changedKeys.some((k) => KEY_GROUPS.translation.includes(k))) applyNoTranslation();
});

// ---------- Helpers ----------

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitFor(checkFn, timeout = 1500, interval = 50) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function tick() {
      let result;
      try { result = checkFn(); } catch (e) { result = null; }
      if (result) return resolve(result);
      if (Date.now() - start >= timeout) return resolve(null);
      setTimeout(tick, interval);
    })();
  });
}

function getPlayer() {
  return document.getElementById("movie_player") || document.querySelector(".html5-video-player");
}

function getActiveVideoAmong(videos) {
  if (videos.length <= 1) return videos[0] || null;
  let best = null, bestVisibleArea = -1;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const visibleWidth = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const visibleHeight = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    const area = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
    if (area > bestVisibleArea) { bestVisibleArea = area; best = v; }
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
function isAdShowing(player) { return !!player && player.classList.contains("ad-showing"); }

// Truly unavailable options (for everyone, Premium member or not).
function isOptionDisabled(el) {
  if (el.getAttribute("aria-disabled") === "true") return true;
  if (el.hasAttribute("disabled")) return true;
  const cls = (el.className || "").toString().toLowerCase();
  if (/disabled|locked/.test(cls)) return true;
  if (el.querySelector('[class*="locked" i], [class*="lock-icon" i]')) return true;
  const style = el.getAttribute("style") || "";
  if (/pointer-events:\s*none/i.test(style)) return true;
  return false;
}

// Premium-branded rows (e.g. "1080p Premium"). "Premium" is an
// untranslated brand term, so matching on it is language-safe.
function isPremiumRow(o) {
  return /premium/i.test(o.textContent || "") ||
    !!o.querySelector('[class*="premium" i]');
}

// ---------- Premium upsell suppression ----------
// When "Skip Premium quality options" is CHECKED (default), Premium upsell
// dialogs are hidden in the same frame they are inserted - MutationObserver
// callbacks run before the next paint, so the user never sees them - and the
// node is removed shortly after. No on-screen button is ever pressed. When
// the toggle is UNCHECKED the suppressor stays off (the user prefers
// Premium quality). Scope is limited to centered dialogs; banners untouched.

const PREMIUM_DIALOG_SELECTOR = 'tp-yt-paper-dialog, [role="dialog"]';

function suppressPremiumDialogs(root) {
  if (!(root instanceof Element)) return;
  const nodes = [];
  if (root.matches && root.matches(PREMIUM_DIALOG_SELECTOR)) nodes.push(root);
  if (root.querySelectorAll) root.querySelectorAll(PREMIUM_DIALOG_SELECTOR).forEach((n) => nodes.push(n));
  for (const dlg of nodes) {
    if (dlg.dataset.yccSuppressed) continue;
    const text = dlg.textContent || "";
    if (!/premium/i.test(text)) continue;
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
    if (!settings || !settings.enabled) return;
    if (settings.blockPremiumPromos === false) return; // unchecked = leave dialogs alone
    for (const m of muts) m.addedNodes.forEach((n) => suppressPremiumDialogs(n));
  });
  premiumSuppressObserver.observe(document.documentElement, { childList: true, subtree: true });
}

// ---------- 1. Preferred quality ----------
// Drives the real Settings-menu UI only. The automation runs AT MOST ONCE
// per video URL. While it runs, the menu UI is hidden with the
// ycc-quiet-menus class.
//
// "Skip Premium quality options" toggle:
//  - CHECKED (default): Premium rows are skipped, the closest lower FREE
//    tier is picked (or the video stays on Auto if no free tier exists),
//    and any Premium upsell dialog is hidden invisibly.
//  - UNCHECKED: the addon PREFERS Premium quality rows - it will click
//    "1080p Premium" when that is the closest tier to your preference,
//    assuming you have a Premium membership. It never verifies the
//    membership itself, and it leaves any upsell dialog alone.

let resolutionInFlight = false;

async function applyResolution() {
  if (!settings.enabled || !settings.resolutionEnabled) return;
  if (resolutionInFlight) return;
  if (isShortsPage()) return;
  if (qualityAppliedUrl === location.href) return; // already handled this video
  const player = getPlayer();
  if (!player || isAdShowing(player)) return;
  const desired = settings.preferredResolution || "hd1080";
  const blockPromos = settings.blockPremiumPromos !== false;

  const settingsBtn = player.querySelector(".ytp-settings-button");
  if (!settingsBtn) return;
  if (settingsBtn.getAttribute("aria-expanded") === "true") return;

  if (!mpFloating) {
    const rect = player.getBoundingClientRect();
    const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    if (!visible) return;
  }

  const ITEM_SELECTOR =
    '.ytp-settings-menu [role="menuitemradio"], .ytp-settings-menu [role="menuitem"], .ytp-settings-menu .ytp-menuitem, .ytp-panel-menu [role="menuitemradio"], .ytp-panel-menu [role="menuitem"], .ytp-panel-menu .ytp-menuitem';
  const RES_PATTERN = /\d{2,4}p(\d{1,3})?/i;

  resolutionInFlight = true;
  document.documentElement.classList.add("ycc-quiet-menus");
  try {
    settingsBtn.click();
    const menuItems = await waitFor(() => {
      const items = Array.from(player.querySelectorAll(ITEM_SELECTOR));
      return items.length ? items : null;
    }, 1500);
    if (!menuItems) return; // player not ready yet - the 4s pass may retry

    const qualityItem = menuItems.find((mi) => {
      const contentText = mi.querySelector(".ytp-menuitem-content")?.textContent || mi.textContent || "";
      return RES_PATTERN.test(contentText) || /^\s*quality/i.test(mi.textContent || "");
    });
    if (!qualityItem) return;

    // We've done our job for this video either way - never re-run the
    // automation (that's what caused the repeated stream reloads).
    qualityAppliedUrl = location.href;

    const desiredLabel = QUALITY_LABELS[desired] || "1080p";
    const currentLabelText = (qualityItem.querySelector(".ytp-menuitem-content")?.textContent || qualityItem.textContent || "").trim();
    const isCurrentlyAuto = currentLabelText.includes("(");
    const alreadyCorrect = desired === "auto" ? isCurrentlyAuto : !isCurrentlyAuto && currentLabelText.startsWith(desiredLabel);
    if (!alreadyCorrect) {
      qualityItem.click();

      const options = await waitFor(() => {
        const radios = Array.from(player.querySelectorAll('.ytp-panel-menu [role="menuitemradio"], .ytp-settings-menu [role="menuitemradio"]'));
        const items = radios.length ? radios : Array.from(player.querySelectorAll(ITEM_SELECTOR));
        return items.length ? items : null;
      }, 1500);

      if (options) {
        const selectable = options.filter((o) => !isOptionDisabled(o) && !(blockPromos && isPremiumRow(o)));
        const resOf = (o) => { const m = (o.textContent || "").match(/(\d{2,4})p/); return m ? parseInt(m[1], 10) : 0; };
        let target = null;
        if (desired === "auto") {
          target = selectable.find((o) => !resOf(o)) || null;
        } else {
          const desiredNum = QUALITY_NUM[desired] || 1080;
          const numbered = selectable.map((o) => ({ o, n: resOf(o) })).filter((x) => x.n > 0);
          const lowerClosest = numbered.filter((x) => x.n <= desiredNum).sort((a, b) => b.n - a.n)[0];
          target = lowerClosest ? lowerClosest.o : null;
        }
        if (target) target.click();
      }
      await wait(150);
    }
  } catch (e) { /* ignore - finally still closes the menu */ }
  finally {
    document.documentElement.classList.remove("ycc-quiet-menus");
    for (let i = 0; i < 3; i++) {
      const open =
        settingsBtn.getAttribute("aria-expanded") === "true" ||
        (player.querySelector(".ytp-settings-menu, .ytp-panel-menu") || {}).offsetParent !== null;
      if (!open) break;
      settingsBtn.click();
      await wait(120);
    }
    if (blockPromos) setTimeout(() => suppressPremiumDialogs(document.body), 300);
    resolutionInFlight = false;
  }
}

// ---------- 2. Default volume level (applied at video start) ----------
let volumeAppliedUrl = null;
const volumeAppliedVideos = new WeakSet();

function setVolumeOnce(video) {
  const target = Math.min(100, Math.max(0, Math.round(settings.fixedVolume ?? 50)));
  const player = getPlayer();
  if (player && typeof player.setVolume === "function") {
    try {
      if (target > 0 && typeof player.isMuted === "function" && player.isMuted()) player.unMute();
      player.setVolume(target);
    } catch (e) { /* ignore */ }
  }
  if (video) {
    try {
      video.volume = target / 100;
      if (video.muted && target > 0) video.muted = false;
    } catch (e) { /* ignore */ }
  }
}

function onVideoPlayCapture(e) {
  if (!settings || !settings.enabled || !settings.fixedVolumeEnabled) return;
  const v = e.target;
  if (!(v instanceof HTMLVideoElement)) return;
  if (isShortsPage()) {
    if (volumeAppliedVideos.has(v)) return;
    volumeAppliedVideos.add(v);
    setVolumeOnce(v);
    return;
  }
  if (!v.classList.contains("html5-main-video")) return;
  if (volumeAppliedUrl === location.href) return;
  volumeAppliedUrl = location.href;
  setVolumeOnce(v);
}

function applyVolumeNow() {
  if (!settings.enabled || !settings.fixedVolumeEnabled) return;
  volumeAppliedUrl = location.href;
  setVolumeOnce(getVideo());
}

// ---------- 3. Block volume scroll ----------
function handleVolumeWheel(e) {
  if (!settings || !settings.enabled || !settings.disableVolumeWheel) return;
  if (!(e.target instanceof Element)) return;
  if (e.target.closest(".ytp-volume-area, .ytp-volume-panel, .ytp-volume-control, .ytp-volume-bar")) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
}

// ---------- 4. Mute hover previews ----------
const HOVER_PREVIEW_SELECTOR =
  "ytd-video-preview, #video-preview, .ytd-video-preview, ytd-video-preview-renderer, #hover-preview";

function muteHoverPreviews() {
  document.querySelectorAll(HOVER_PREVIEW_SELECTOR).forEach((box) => {
    box.querySelectorAll("video").forEach((v) => { if (!v.muted) v.muted = true; });
  });
}
function startHoverMute() {
  if (hoverMuteInterval) return;
  muteHoverPreviews();
  hoverMuteInterval = setInterval(muteHoverPreviews, 600);
}
function stopHoverMute() { clearInterval(hoverMuteInterval); hoverMuteInterval = null; }

// ---------- 5. Prevent Shorts from looping ----------
const shortsFixed = new WeakSet();
function stripLoop(video) { if (video.hasAttribute("loop")) video.removeAttribute("loop"); }
function neutralizeLoop(video) {
  stripLoop(video);
  if (shortsFixed.has(video)) return;
  shortsFixed.add(video);
  try {
    Object.defineProperty(video, "loop", {
      get() { return false; },
      set() { /* ignore */ },
      configurable: true,
    });
  } catch (e) { /* attribute observer below still catches re-adds */ }
}
function fixShortsLoop() {
  if (!settings.enabled || !settings.stopShortsLoop) return;
  if (!isShortsPage()) return;
  document.querySelectorAll("video").forEach(neutralizeLoop);
}
const shortsObserver = new MutationObserver((mutations) => {
  if (!settings || !settings.enabled || !isShortsPage()) return;
  for (const m of mutations) {
    if (m.type === "attributes" && m.attributeName === "loop") {
      if (settings.stopShortsLoop && m.target instanceof HTMLVideoElement) stripLoop(m.target);
      continue;
    }
    m.addedNodes.forEach((node) => {
      if (node.nodeType !== 1) return;
      const isVideo = node.tagName === "VIDEO";
      const nestedVideos = node.querySelectorAll ? Array.from(node.querySelectorAll("video")) : [];
      if (settings.stopShortsLoop) {
        if (isVideo) neutralizeLoop(node);
        nestedVideos.forEach(neutralizeLoop);
      }
    });
  }
});
function startShortsSweep() {
  clearInterval(shortsSweepInterval);
  if (!settings.enabled || !settings.stopShortsLoop) return;
  shortsSweepInterval = setInterval(() => {
    if (!isShortsPage()) return;
    document.querySelectorAll("video[loop]").forEach(stripLoop);
  }, 500);
}

// ---------- 6. Auto-expand player (theater mode) ----------
function isTheaterActive() {
  const flexy = document.querySelector("ytd-watch-flexy");
  if (flexy) return flexy.hasAttribute("theater");
  const sizeButton = document.querySelector(".ytp-size-button");
  const label = (sizeButton?.getAttribute("title") || sizeButton?.getAttribute("aria-label") || "").toLowerCase();
  if (label.includes("default")) return true;
  if (label.includes("theater")) return false;
  return false;
}
function autoExpandPlayer() {
  if (!settings.enabled || !settings.autoExpandEnabled || !isWatchPage()) return;
  if (expandAppliedUrl === location.href) return; // once per video
  const sizeButton = document.querySelector(".ytp-size-button");
  if (!sizeButton) return;
  if (isTheaterActive()) { expandAppliedUrl = location.href; return; }
  sizeButton.click();
  expandAppliedUrl = location.href;
}

// ---------- 7. Captions / subtitles control ----------
function applyCaptions() {
  if (!settings.enabled || !settings.captionsControlEnabled) return;
  const player = getPlayer();
  if (!player) return;
  const desiredOn = settings.captionsMode === "on";
  try {
    if (typeof player.isSubtitlesOn === "function") {
      const isOn = player.isSubtitlesOn();
      if (isOn !== desiredOn && typeof player.toggleSubtitlesOn === "function") player.toggleSubtitlesOn(desiredOn);
    } else if (typeof player.setOption === "function" && !desiredOn) player.setOption("captions", "track", {});
  } catch (e) { /* ignore */ }
  const btn = document.querySelector(".ytp-subtitles-button");
  if (btn) {
    const pressed = btn.getAttribute("aria-pressed") === "true";
    if (pressed !== desiredOn) btn.click();
  }
}
function scheduleCaptionsRetries() {
  clearInterval(captionsRetryTimer);
  if (!settings.enabled || !settings.captionsControlEnabled) return;
  let attempts = 0;
  captionsRetryTimer = setInterval(() => {
    attempts++;
    applyCaptions();
    if (attempts >= 6) clearInterval(captionsRetryTimer);
  }, 1000);
}

// ---------- 8. Mini player when scrolling to comments ----------
const MP_CORNER_CLASSES = ["ycc-mp-corner-tl", "ycc-mp-corner-tr", "ycc-mp-corner-bl", "ycc-mp-corner-br"];
const MP_CORNER_MAP = { "top-left": "ycc-mp-corner-tl", "top-right": "ycc-mp-corner-tr", "bottom-left": "ycc-mp-corner-bl", "bottom-right": "ycc-mp-corner-br" };
const MP_ORIGIN_MAP = { "top-left": "top left", "top-right": "top right", "bottom-left": "bottom left", "bottom-right": "bottom right" };

let mpObserver = null, mpObserverPlayerRef = null, mpObservedTarget = null;
let mpSpacer = null, mpWrapper = null, mpFloating = false, mpCloseBtn = null;
let mpNaturalWidth = 0, mpNaturalHeight = 0;

function getCornerClass() { return MP_CORNER_MAP[settings.miniplayerCorner] || "ycc-mp-corner-br"; }
function getTransformOrigin() { return MP_ORIGIN_MAP[settings.miniplayerCorner] || "bottom right"; }
function parseMiniplayerSize() {
  const match = /^(\d+)x(\d+)$/i.exec((settings.miniplayerSize || "").trim());
  if (!match) return { w: 400, h: 225 };
  return { w: parseInt(match[1], 10), h: parseInt(match[2], 10) };
}
function applyMiniplayerScale(wrapper) {
  if (mpNaturalWidth <= 0) return;
  const scale = parseMiniplayerSize().w / mpNaturalWidth;
  wrapper.style.transform = `scale(${scale})`;
  wrapper.style.transformOrigin = getTransformOrigin();
  if (mpCloseBtn) {
    mpCloseBtn.style.transform = `scale(${1 / scale})`;
    mpCloseBtn.style.transformOrigin = "top right";
  }
}
function isNativeExpandedState(player) {
  if (document.fullscreenElement) return true;
  if (player && player.classList.contains("ytp_fullscreen")) return true;
  const nativeMini = document.querySelector("ytd-miniplayer");
  return !!(nativeMini && (nativeMini.hasAttribute("active") || nativeMini.hasAttribute("is-active")));
}
function updateMiniplayerCorner() {
  if (!mpFloating || !mpWrapper) return;
  mpWrapper.classList.remove(...MP_CORNER_CLASSES);
  mpWrapper.classList.add(getCornerClass());
  mpWrapper.style.transformOrigin = getTransformOrigin();
}
function updateMiniplayerSize() { if (mpFloating && mpWrapper) applyMiniplayerScale(mpWrapper); }

function engageMiniplayer(player) {
  if (mpFloating || isNativeExpandedState(player)) return;
  const rect = player.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  mpNaturalWidth = rect.width;
  mpNaturalHeight = rect.height;

  mpSpacer = document.createElement("div");
  mpSpacer.className = "ycc-mp-spacer";
  mpSpacer.style.width = rect.width + "px";
  mpSpacer.style.height = rect.height + "px";
  player.parentNode.insertBefore(mpSpacer, player);

  mpWrapper = document.createElement("div");
  mpWrapper.className = "ycc-mp-wrapper " + getCornerClass();
  mpWrapper.style.width = mpNaturalWidth + "px";
  mpWrapper.style.height = mpNaturalHeight + "px";
  document.body.appendChild(mpWrapper);
  mpWrapper.appendChild(player);

  mpCloseBtn = document.createElement("button");
  mpCloseBtn.className = "ycc-mp-close";
  mpCloseBtn.type = "button";
  mpCloseBtn.textContent = "\u2715";
  mpCloseBtn.setAttribute("aria-label", "Restore player");
  mpCloseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (mpSpacer) mpSpacer.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  mpWrapper.appendChild(mpCloseBtn);

  applyMiniplayerScale(mpWrapper);
  mpFloating = true;

  if (mpObserver) {
    if (mpObservedTarget) mpObserver.unobserve(mpObservedTarget);
    mpObserver.observe(mpSpacer);
    mpObservedTarget = mpSpacer;
  }
}
function restoreFromFloat(player) {
  if (mpSpacer) { mpSpacer.after(player); mpSpacer.remove(); mpSpacer = null; }
  if (mpWrapper) { mpWrapper.remove(); mpWrapper = null; }
  mpCloseBtn = null;
  mpNaturalWidth = 0; mpNaturalHeight = 0; mpFloating = false;
}
function disengageMiniplayer(player) {
  if (!mpFloating) return;
  restoreFromFloat(player);
  if (mpObserver) {
    if (mpObservedTarget) mpObserver.unobserve(mpObservedTarget);
    mpObserver.observe(player);
    mpObservedTarget = player;
  }
}
function handleMiniplayerIntersection(entries) {
  if (!settings || !settings.enabled || !settings.miniplayerEnabled) return;
  if (isShortsPage() || !isWatchPage()) return;
  const player = getPlayer();
  if (!player) return;
  for (const entry of entries) {
    if (entry.target === mpSpacer) {
      if (entry.isIntersecting) disengageMiniplayer(player);
    } else if (entry.target === player) {
      if (!entry.isIntersecting && entry.boundingClientRect.bottom <= 0) engageMiniplayer(player);
    }
  }
}
function stopMiniplayerObserving() {
  const player = getPlayer();
  if (mpFloating && player) restoreFromFloat(player);
  if (mpObserver) { mpObserver.disconnect(); mpObserver = null; }
  mpObservedTarget = null; mpObserverPlayerRef = null;
}
function startMiniplayerObserving() {
  if (!settings.enabled || !settings.miniplayerEnabled || isShortsPage() || !isWatchPage()) {
    stopMiniplayerObserving();
    return;
  }
  const player = getPlayer();
  if (!player) return;
  if (mpObserver && mpObserverPlayerRef === player) return;
  stopMiniplayerObserving();
  mpObserver = new IntersectionObserver(handleMiniplayerIntersection, { threshold: 0 });
  mpObserver.observe(player);
  mpObservedTarget = player;
  mpObserverPlayerRef = player;
}

// ---------- 9. Hide info cards and end screens ----------
function applyHideCardsEndscreens() {
  document.documentElement.classList.toggle("ycc-hide-cards-endscreens", !!(settings.enabled && settings.hideCardsEndscreens));
}

// ---------- 10. Prevent auto-translation ----------
// Site-wide: titles, descriptions and chapter names are restored on EVERY
// YouTube subpage (home, search, feed, channels + their Shorts tabs,
// playlists, the Shorts watch page, notifications, watch page, embeds).
// Titles come primarily from the oEmbed endpoint: public, locale-free,
// always the canonical original title. InnerTube (no hl/gl, no cookies)
// supplies descriptions and chapters; the watch page (og:title) is the
// last-resort fallback. Failed lookups are never cached.
//
// Title writes are RACE-SAFE and SELF-HEALING: YouTube constantly reuses
// and rebuilds card DOM nodes while scrolling, so a write is only applied
// if the node is still in the DOM and still shows exactly the text we saw
// before the async fetch (i.e. it wasn't reused for another video). Each
// processed node is marked with the video ID it was restored for; on later
// scans a marked node whose text YouTube re-rendered back to a translated
// (or emptied) value is repaired from the cached original.

const FALLBACK_INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const FALLBACK_INNERTUBE_CLIENT_VERSION = "2.20240111.09.00";
let cachedInnertubeConfig = null;

function extractInnertubeConfig() {
  if (cachedInnertubeConfig) return cachedInnertubeConfig;
  let apiKey = FALLBACK_INNERTUBE_API_KEY, clientVersion = FALLBACK_INNERTUBE_CLIENT_VERSION;
  try {
    const html = document.documentElement.innerHTML;
    const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const verMatch = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
    if (keyMatch) apiKey = keyMatch[1];
    if (verMatch) clientVersion = verMatch[1];
  } catch (e) { /* fallback constants */ }
  cachedInnertubeConfig = { apiKey, clientVersion };
  return cachedInnertubeConfig;
}

function getVideoIdFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, location.origin);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const shortsMatch = u.pathname.match(/\/shorts\/([\w-]{6,})/);
    if (shortsMatch) return shortsMatch[1];
    const embedMatch = u.pathname.match(/\/embed\/([\w-]{6,})/);
    if (embedMatch) return embedMatch[1];
  } catch (e) { /* not a video link */ }
  return null;
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Static HTML-entity decoder (no DOM, no innerHTML) - keeps Mozilla's
// linter happy while still cleaning og:title values.
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

async function fetchTitleFromWatchPage(videoId) {
  try {
    const res = await fetchWithTimeout(
      "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&hl=en&persist_hl=1",
      { credentials: "omit" }, 6000);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/);
    if (!m) return null;
    const t = decodeEntities(m[1]).replace(/\s*-\s*YouTube\s*$/, "");
    return t || null;
  } catch (e) { return null; }
}

async function fetchDescriptionFallback(videoId) {
  try {
    const res = await fetchWithTimeout(
      "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&hl=en&persist_hl=1",
      { credentials: "omit" }, 6000);
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
    if (!match) return null;
    return JSON.parse(`"${match[1]}"`);
  } catch (e) { return null; }
}

function textOf(t) {
  if (!t) return "";
  if (typeof t.simpleText === "string") return t.simpleText.trim();
  if (Array.isArray(t.runs)) return t.runs.map((x) => x.text || "").join("").trim();
  return "";
}
function timeStringToSeconds(str) {
  const parts = String(str).trim().split(":").map(Number);
  if (parts.length === 2 && parts.every((n) => !isNaN(n))) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every((n) => !isNaN(n))) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}
function finalizeChapters(list) {
  if (!list.length) return null;
  list.sort((a, b) => a.startMillis - b.startMillis);
  return list;
}
function extractChapters(data) {
  try {
    const markersMap = data?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBar?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;
    if (Array.isArray(markersMap)) {
      for (const entry of markersMap) {
        const chapters = entry?.value?.chapters;
        if (!Array.isArray(chapters) || !chapters.length) continue;
        const list = [];
        for (const c of chapters) {
          const ch = c?.chapterRenderer;
          if (!ch) continue;
          const title = textOf(ch.title);
          if (title) list.push({ title, startMillis: Number(ch.timeRangeStartMillis || 0) });
        }
        const done = finalizeChapters(list);
        if (done) return done;
      }
    }
    const panels = data?.engagementPanels;
    if (Array.isArray(panels)) {
      for (const p of panels) {
        const contents = p?.engagementPanelSectionListRenderer?.content?.sectionListRenderer?.contents;
        if (!Array.isArray(contents)) continue;
        for (const c of contents) {
          const items = c?.macroMarkersListRenderer?.items;
          if (!Array.isArray(items) || !items.length) continue;
          const list = [];
          for (const it of items) {
            const r = it?.macroMarkersListItemRenderer;
            if (!r) continue;
            const title = textOf(r.title);
            if (title) list.push({ title, startMillis: timeStringToSeconds(textOf(r.timeSnippet)) * 1000 });
          }
          const done = finalizeChapters(list);
          if (done) return done;
        }
      }
    }
  } catch (e) { /* fallback below */ }
  return null;
}
function parseChaptersFromDescription(description) {
  if (!description) return null;
  const TS = /(\d{1,2}:\d{2}(?::\d{2})?)/;
  const lines = description.split(/\r?\n/);
  const hasTs = lines.map((l) => { const t = l.trim(); return t.length > 0 && TS.test(t); });
  const list = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const m = trimmed.match(TS);
    if (!m) return;
    let before = false, after = false;
    for (let i = index - 1; i >= 0; i--) { if (lines[i].trim().length === 0) continue; before = hasTs[i]; break; }
    for (let i = index + 1; i < lines.length; i++) { if (lines[i].trim().length === 0) continue; after = hasTs[i]; break; }
    if (!before && !after) return;
    const ts = m[1], idx = m.index;
    let title;
    if (idx === 0 || /^[-–—•·▪▫‣⁃→>*\s]+$/.test(trimmed.substring(0, idx))) title = trimmed.substring(idx + ts.length);
    else title = trimmed.substring(0, idx);
    title = title.replace(/^[-–—•·▪▫‣⁃→>*\s]+/, "").replace(/[-–—•·▪▫⁃→>*\s]+$/, "").trim();
    if (title.length < 2) return;
    list.push({ title, startMillis: timeStringToSeconds(ts) * 1000 });
  });
  if (list.length < 2) return null;
  return finalizeChapters(list);
}

const videoMetaCache = new Map();

function fetchOriginalVideoMeta(videoId) {
  if (!videoId) return Promise.resolve(null);
  if (videoMetaCache.has(videoId)) return videoMetaCache.get(videoId);
  const promise = (async () => {
    const { apiKey, clientVersion } = extractInnertubeConfig();
    let title = null, description = null, chapters = null;

    // 1) Title from oEmbed - locale-free canonical original.
    try {
      const res = await fetchWithTimeout(
        "https://www.youtube.com/oembed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + videoId) + "&format=json",
        { credentials: "omit" }, 6000);
      if (res.ok) title = (await res.json()).title || null;
    } catch (e) { /* fall through */ }

    // 2) Description + chapters (+ title fallback) from InnerTube.
    try {
      const res = await fetchWithTimeout(
        "https://www.youtube.com/youtubei/v1/player?key=" + encodeURIComponent(apiKey),
        {
          method: "POST",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            "X-Youtube-Client-Name": "1",
            "X-Youtube-Client-Version": clientVersion,
          },
          body: JSON.stringify({ videoId, context: { client: { clientName: "WEB", clientVersion } } }),
        },
        6000);
      if (res.ok) {
        const data = await res.json();
        if (!title) title = data?.videoDetails?.title || null;
        description = data?.videoDetails?.shortDescription || null;
        chapters = extractChapters(data);
      }
    } catch (e) { /* fall through */ }

    // 3) Watch-page fallbacks.
    if (!title) title = await fetchTitleFromWatchPage(videoId);
    if (!description) description = await fetchDescriptionFallback(videoId);
    if (!chapters) chapters = parseChaptersFromDescription(description);
    if (!title) return null;
    return { title, description, chapters };
  })();
  videoMetaCache.set(videoId, promise);
  promise.then((m) => { if (!m) videoMetaCache.delete(videoId); });
  if (videoMetaCache.size > 300) videoMetaCache.delete(videoMetaCache.keys().next().value);
  return promise;
}

function markOriginalApplied(el, key) { el.dataset.yccOrigKey = key; }
function isOriginalAppliedFor(el, key) { return el.dataset.yccOrigKey === key; }

async function applyMainTitle() {
  if (!isWatchPage()) return;
  const videoId = getVideoIdFromUrl(location.href);
  if (!videoId) return;
  const titleEl = document.querySelector(
    "ytd-watch-metadata h1.ytd-watch-metadata yt-formatted-string, ytd-watch-metadata yt-formatted-string.ytd-watch-metadata, #title h1 yt-formatted-string");
  if (!titleEl) return;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled) return;
  if (getVideoIdFromUrl(location.href) !== videoId) return;
  if (!meta || !meta.title) return;
  if (isOriginalAppliedFor(titleEl, videoId)) {
    // Self-heal: repair if YouTube re-rendered the title back to a
    // translated (or emptied) value.
    if (titleEl.textContent !== meta.title) {
      const oldTitle = titleEl.textContent;
      titleEl.textContent = meta.title;
      if (titleEl.hasAttribute("title")) titleEl.setAttribute("title", meta.title);
      if (oldTitle && document.title.includes(oldTitle)) document.title = document.title.replace(oldTitle, meta.title);
    }
    return;
  }
  const oldTitle = titleEl.textContent;
  if (oldTitle !== meta.title) {
    titleEl.textContent = meta.title;
    if (titleEl.hasAttribute("title")) titleEl.setAttribute("title", meta.title);
    if (oldTitle && document.title.includes(oldTitle)) document.title = document.title.replace(oldTitle, meta.title);
  }
  markOriginalApplied(titleEl, videoId);
}

async function applyEmbedTitle() {
  if (!isEmbedPage()) return;
  const linkEl = document.querySelector(".ytp-title-link, a.ytp-title-link, .ytp-title a");
  if (!linkEl) return;
  const videoId = getVideoIdFromUrl(linkEl.getAttribute("href") || location.href);
  if (!videoId) return;
  const key = videoId + ":embedtitle";
  if (isOriginalAppliedFor(linkEl, key)) return;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled || !meta || !meta.title) return;
  if (linkEl.textContent !== meta.title) linkEl.textContent = meta.title;
  if (linkEl.hasAttribute("title")) linkEl.setAttribute("title", meta.title);
  markOriginalApplied(linkEl, key);
}

// Every title element we know how to restore, across ALL subpages:
// classic cards (#video-title), new view-model grids
// (h3[title] > a > span[role="text"]), the Shorts watch page
// (yt-shorts-video-title-view-model), old reel renderers, notifications.
const FEED_TITLE_SELECTOR =
  "#video-title, " +
  "h3[title] > a > span[role='text'], " +
  "yt-shorts-video-title-view-model h1 span[role='text'], " +
  "yt-shorts-video-title-view-model h2 span[role='text'], " +
  "yt-shorts-video-title-view-model [class*='ShortsVideoTitle'] span, " +
  "ytd-reel-video-renderer #title, " +
  "ytd-notification-renderer #message yt-formatted-string, " +
  "#notification-title";

async function applyFeedTitle(titleEl) {
  let link = titleEl.closest("a");
  if (!link) {
    const card = titleEl.closest(
      "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, ytd-reel-video-renderer, ytd-notification-renderer");
    link = card && card.querySelector('a[href^="/watch"], a[href^="/shorts/"]');
  }
  let videoId = getVideoIdFromUrl(link && link.getAttribute("href"));
  // The Shorts watch-page title has no link of its own - use the URL.
  if (!videoId && isShortsPage()) videoId = getVideoIdFromUrl(location.href);
  if (!videoId) return;

  // Already processed for this video: only repair if YouTube re-rendered
  // the node back to a translated (or emptied) title. Cached, so cheap.
  if (titleEl.dataset.yccTitleFor === videoId) {
    const meta = await fetchOriginalVideoMeta(videoId);
    if (meta && meta.title && titleEl.isConnected && titleEl.textContent !== meta.title) {
      titleEl.textContent = meta.title;
      if (titleEl.hasAttribute("title")) titleEl.setAttribute("title", meta.title);
    }
    return;
  }

  // Capture what the element shows right now; after the async fetch we
  // only write if the node is still in the DOM and still shows exactly
  // that text - i.e. YouTube hasn't reused or rebuilt it meanwhile.
  const expected = titleEl.textContent;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled || !meta || !meta.title) return;
  if (!titleEl.isConnected) return;
  if (titleEl.textContent !== expected) return;
  if (expected !== meta.title) {
    titleEl.textContent = meta.title;
    if (titleEl.hasAttribute("title")) titleEl.setAttribute("title", meta.title);
  }
  titleEl.dataset.yccTitleFor = videoId;
}

function scanFeedTitles() {
  if (!settings.enabled || !settings.noTranslationEnabled) return;
  document.querySelectorAll(FEED_TITLE_SELECTOR).forEach((el) => applyFeedTitle(el));
  // New-style Shorts cards (home Shorts shelf, channel Shorts tab): the
  // title is the first text span inside the lockup anchor (href=/shorts/ID).
  document.querySelectorAll(".shortsLockupViewModelHostEndpoint").forEach((a) => {
    const span = a.querySelector("span[role='text']") || a.querySelector("span");
    if (span) applyFeedTitle(span);
  });
}

let searchSnippetStyleInjected = false;
function ensureSearchSnippetStyle() {
  if (searchSnippetStyleInjected || document.getElementById("ycc-search-style")) { searchSnippetStyleInjected = true; return; }
  const style = document.createElement("style");
  style.id = "ycc-search-style";
  style.textContent = `
    .metadata-snippet-text[ycc-search] { display: none !important; }
    .metadata-snippet-container[ycc-search]::after,
    .metadata-snippet-container-one-line[ycc-search]::after {
      content: attr(data-original-description);
      font-size: var(--ytd-tab-system-font-size-body, 1.2rem);
      line-height: var(--ytd-tab-system-line-height-body, 1.6rem);
      font-family: var(--ytd-tab-system-font-family, inherit);
      color: var(--yt-spec-text-secondary, #aaa);
      white-space: pre-line;
    }
    ytd-video-renderer #description-text[ycc-search] {
      display: block !important; color: var(--yt-spec-text-secondary, #aaa); white-space: pre-line;
    }
  `;
  document.head.appendChild(style);
  searchSnippetStyleInjected = true;
}
function truncateDescription(description) {
  const short = description.split("\n").slice(0, 2).join("\n");
  return short.length > 100 ? short.substring(0, 100) + "..." : short;
}

// Site-wide description snippets: find every snippet element on whatever
// subpage we're on, then locate the video it belongs to via the nearest
// /watch or /shorts link (inside the card/lockup container).
async function applyFeedDescription(descEl) {
  const container = descEl.closest(".metadata-snippet-container, .metadata-snippet-container-one-line");
  let link = descEl.closest('a[href*="/watch"], a[href*="/shorts/"]');
  if (!link) {
    const card = descEl.closest(
      "ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer, .shortsLockupViewModelHostEndpoint, ytd-lockup-view-model");
    link = card && card.querySelector('a[href*="/watch"], a[href*="/shorts/"]');
  }
  const videoId = getVideoIdFromUrl(link && link.getAttribute("href"));
  if (!videoId) return;
  if (descEl.getAttribute("ycc-search") === videoId &&
      (!container || (container.getAttribute("ycc-search") === videoId && container.hasAttribute("data-original-description")))) return;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled || !meta || !meta.description) return;
  ensureSearchSnippetStyle();
  const truncated = truncateDescription(meta.description);
  if (container) {
    container.setAttribute("data-original-description", truncated);
    container.setAttribute("ycc-search", videoId);
    descEl.setAttribute("ycc-search", videoId);
    descEl.setAttribute("translate", "no");
  } else if (descEl.id === "description-text") {
    descEl.textContent = truncated;
    descEl.setAttribute("ycc-search", videoId);
  } else {
    const current = (descEl.textContent || "").trim();
    const normalized = meta.description.replace(/\s+/g, " ").trim();
    let text = normalized;
    if (current.length && normalized.length > current.length) {
      text = normalized.slice(0, Math.max(1, current.length - 1)).trimEnd() + "…";
    }
    if (current !== text) descEl.textContent = text;
    descEl.setAttribute("ycc-search", videoId);
  }
}
function scanFeedDescriptions() {
  if (!settings.enabled || !settings.noTranslationEnabled) return;
  document.querySelectorAll(".metadata-snippet-text, #description-text").forEach((el) => applyFeedDescription(el));
}

async function applyOriginalDescription() {
  if (!isWatchPage()) return;
  const videoId = getVideoIdFromUrl(location.href);
  if (!videoId) return;
  const descEl = document.querySelector(
    "ytd-text-inline-expander#description-inline-expander yt-attributed-string, #description-inline-expander yt-attributed-string, #description yt-attributed-string");
  if (!descEl || isOriginalAppliedFor(descEl, videoId)) return;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled) return;
  if (getVideoIdFromUrl(location.href) !== videoId) return;
  if (!meta || !meta.description) return;
  descEl.textContent = meta.description;
  markOriginalApplied(descEl, videoId);
}

let cachedChapters = [], cachedChaptersVideoId = null, chapterUpdateInterval = null;
function findChapterByTime(seconds, chapters) {
  let current = null;
  for (const ch of chapters) { if (ch.startMillis / 1000 <= seconds) current = ch; else break; }
  return current;
}
function getCurrentVideoTime() {
  const player = getPlayer();
  const v = (player && player.querySelector("video")) || getVideo();
  return v ? Math.floor(v.currentTime || 0) : 0;
}
async function ensureChapters(videoId) {
  if (cachedChaptersVideoId === videoId) return cachedChapters;
  const meta = await fetchOriginalVideoMeta(videoId);
  cachedChapters = (meta && meta.chapters) || [];
  cachedChaptersVideoId = videoId;
  return cachedChapters;
}
function replaceIfDifferent(el, newText) {
  if (!el) return;
  const cur = (el.textContent || "").trim();
  if (cur && cur !== newText) el.textContent = newText;
}
function updateChapterButton(chapters) {
  const el = document.querySelector(".ytp-chapter-title .ytp-chapter-title-content");
  if (!el) return;
  const ch = findChapterByTime(getCurrentVideoTime(), chapters);
  if (ch) replaceIfDifferent(el, ch.title);
}
function updateChapterTooltip(chapters) {
  const tip = document.querySelector('.ytp-tooltip.ytp-preview:not([style*="display: none"])');
  if (!tip) return;
  let timeEl = tip.querySelector(".ytp-tooltip-progress-bar-pill-time-stamp");
  let titleEl = tip.querySelector(".ytp-tooltip-progress-bar-pill-title");
  if (!timeEl || !titleEl) { timeEl = tip.querySelector(".ytp-tooltip-text"); titleEl = tip.querySelector(".ytp-tooltip-title span"); }
  if (!timeEl || !titleEl || !(timeEl.textContent || "").trim()) return;
  const ch = findChapterByTime(timeStringToSeconds(timeEl.textContent), chapters);
  if (ch) replaceIfDifferent(titleEl, ch.title);
}
function updateChapterPanel(chapters) {
  const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-description-chapters"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]');
  if (!panel) return;
  panel.querySelectorAll("ytd-macro-markers-list-item-renderer .macro-markers").forEach((el) => {
    const timeEl = el.closest("ytd-macro-markers-list-item-renderer")?.querySelector("#time");
    if (!timeEl) return;
    const ch = findChapterByTime(timeStringToSeconds(timeEl.textContent || ""), chapters);
    if (ch) replaceIfDifferent(el, ch.title);
  });
}
function stopChapterUpdater() { clearInterval(chapterUpdateInterval); chapterUpdateInterval = null; }
async function applyOriginalChapters() {
  if (!isWatchPage() || !settings.enabled || !settings.noTranslationEnabled) { stopChapterUpdater(); return; }
  const videoId = getVideoIdFromUrl(location.href);
  if (!videoId) return;
  const chapters = await ensureChapters(videoId);
  if (!chapters.length) { stopChapterUpdater(); return; }
  const run = () => { updateChapterButton(chapters); updateChapterTooltip(chapters); updateChapterPanel(chapters); };
  run();
  if (!chapterUpdateInterval) chapterUpdateInterval = setInterval(run, 250);
}

let translationObserver = null, translationScanTimer = null;
function scheduleTranslationScan() {
  clearTimeout(translationScanTimer);
  translationScanTimer = setTimeout(() => {
    scanFeedTitles();
    scanFeedDescriptions();
    applyOriginalChapters();
    applyEmbedTitle();
  }, 250);
}
function startTranslationObserver() {
  if (translationObserver) return;
  translationObserver = new MutationObserver(() => {
    if (!settings || !settings.enabled || !settings.noTranslationEnabled) return;
    scheduleTranslationScan();
  });
  translationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}
function stopTranslationObserver() {
  if (translationObserver) { translationObserver.disconnect(); translationObserver = null; }
  clearTimeout(translationScanTimer);
}
function applyNoTranslation() {
  if (!(settings.enabled && settings.noTranslationEnabled)) { stopTranslationObserver(); stopChapterUpdater(); return; }
  startTranslationObserver();
  applyMainTitle();
  applyOriginalDescription();
  scanFeedTitles();
  scanFeedDescriptions();
  applyOriginalChapters();
  applyEmbedTitle();
}

// ---------- 11. Prevent accidental Shorts scrolling ----------
// Accumulates the scroll delta and only lets the event through to YouTube
// once a deliberate threshold is crossed. Changing direction resets the
// accumulator. The guard covers the whole Shorts stage; side areas
// (comments, panels, guide, header, shelves) are exempted first and always
// scroll normally.
//
// IMPORTANT (1.3.4): after a switch has been allowed, the cooldown window
// no longer swallows wheel events - we simply stop evaluating thresholds
// and let the reel scroll 100% natively. Swallowing events there could
// leave YouTube's scroll-snap reel half-finished, which sometimes kept the
// comments panel bound to the previous Short. Native post-switch scrolling
// also means momentum may carry you one Short further - that's normal
// YouTube behavior and keeps the page state (video + comments) in sync.
let shortsWheelAccumulator = 0, shortsWheelResetTimer = null, shortsWheelCooldown = false;
const SHORTS_WHEEL_THRESHOLD = 200;
const SHORTS_WHEEL_COOLDOWN_MS = 800;
const SHORTS_WHEEL_RESET_MS = 300;
const SHORTS_WHEEL_EXEMPT_SELECTOR =
  "ytd-comments, ytd-engagement-panel-section-list-renderer, #panels, #secondary, #related, #guide, #masthead-container, header, ytd-rich-section-renderer, ytd-shelf-renderer";
const SHORTS_WHEEL_STAGE_SELECTOR =
  "ytd-shorts, #shorts-container, #page-container, ytd-reel-video-renderer, #player-container";

function handleShortsWheel(e) {
  if (!settings || !settings.enabled || !settings.disableShortsWheelScroll) return;
  if (!isShortsPage()) return;
  if (!(e.target instanceof Element)) return;
  if (e.target.closest(SHORTS_WHEEL_EXEMPT_SELECTOR)) return;
  if (!e.target.closest(SHORTS_WHEEL_STAGE_SELECTOR)) return;
  if (shortsWheelCooldown) return; // stay out of the way - native scrolling
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 30;
  if (e.deltaMode === 2) delta *= window.innerHeight;
  if ((shortsWheelAccumulator > 0 && delta < 0) || (shortsWheelAccumulator < 0 && delta > 0)) shortsWheelAccumulator = 0;
  shortsWheelAccumulator += delta;
  clearTimeout(shortsWheelResetTimer);
  shortsWheelResetTimer = setTimeout(() => { shortsWheelAccumulator = 0; }, SHORTS_WHEEL_RESET_MS);
  if (Math.abs(shortsWheelAccumulator) >= SHORTS_WHEEL_THRESHOLD) {
    shortsWheelAccumulator = 0;
    shortsWheelCooldown = true;
    setTimeout(() => { shortsWheelCooldown = false; }, SHORTS_WHEEL_COOLDOWN_MS);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

// ---------- Orchestration ----------

function applyAll() {
  if (!settings) return;
  applyResolution();
  fixShortsLoop();
  startShortsSweep();
  autoExpandPlayer();
  applyCaptions();
  scheduleCaptionsRetries();
  startMiniplayerObserving();
  applyHideCardsEndscreens();
  applyNoTranslation();
}

function onNavigate() {
  clearTimeout(navigateTimer);
  volumeAppliedUrl = null;
  qualityAppliedUrl = null;
  expandAppliedUrl = null;
  navigateTimer = setTimeout(applyAll, 400);
  setTimeout(applyAll, 1200);
  // Late quality verification - only does anything if the earlier passes
  // never reached the menu (applyResolution self-guards per URL).
  setTimeout(applyResolution, 4000);
}

function init() {
  console.info("[YPI] content.js build " + BUILD_TAG);
  startPremiumSuppressor();
  loadSettings().then(() => {
    applyAll();
    if (settings.enabled && settings.muteHoverPreviews) startHoverMute();
    shortsObserver.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["loop"],
    });
  });
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);
  document.addEventListener("wheel", handleShortsWheel, { capture: true, passive: false });
  document.addEventListener("wheel", handleVolumeWheel, { capture: true, passive: false });
  document.addEventListener("play", onVideoPlayCapture, true);
  setInterval(() => {
    if (!settings) return;
    fixShortsLoop();
    autoExpandPlayer();
    applyCaptions();
    startMiniplayerObserving();
    applyHideCardsEndscreens();
    applyNoTranslation();
    if (settings.enabled && settings.blockPremiumPromos !== false) suppressPremiumDialogs(document.body);
  }, 5000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
})();