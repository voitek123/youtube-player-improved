// content.js - Youtube Player Improved
// Runs on youtube.com. Re-applies its behavior every time YouTube's
// single-page-app navigates to a new video (yt-navigate-finish).
(function () {
"use strict";

const BUILD_TAG = "ypi-1.0.0";

const QUALITY_LABELS = {
  auto: "Auto", hd2160: "2160p", hd1440: "1440p", hd1080: "1080p",
  hd720: "720p", large: "480p", medium: "360p", small: "240p", tiny: "144p",
};
const QUALITY_ORDER = ["hd2160", "hd1440", "hd1080", "hd720", "large", "medium", "small", "tiny"];

const KEY_GROUPS = {
  resolution: ["enabled", "resolutionEnabled", "preferredResolution"],
  volume: ["enabled", "fixedVolumeEnabled", "fixedVolume"],
  shorts: ["enabled", "stopShortsLoop"],
  expand: ["enabled", "autoExpandEnabled"],
  captions: ["enabled", "captionsControlEnabled", "captionsMode"],
  miniplayer: ["enabled", "miniplayerEnabled", "miniplayerCorner", "miniplayerSize"],
  cardsEndscreens: ["enabled", "hideCardsEndscreens"],
  translation: ["enabled", "noTranslationEnabled"],
};

let settings = {};
let navigateTimer = null;
let resolutionRetryTimer = null;
let captionsRetryTimer = null;
let volumeEnforceInterval = null;
let shortsSweepInterval = null;

function loadSettings() {
  return browser.storage.local.get(null).then((s) => { settings = s; return s; });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!settings) settings = {};
  const changedKeys = Object.keys(changes);
  for (const key of changedKeys) settings[key] = changes[key].newValue;

  if (changedKeys.some((k) => KEY_GROUPS.resolution.includes(k))) { applyResolution(); scheduleResolutionRetries(); }
  if (changedKeys.some((k) => KEY_GROUPS.volume.includes(k))) startVolumeEnforcement();
  if (changedKeys.some((k) => KEY_GROUPS.shorts.includes(k))) { fixShortsLoop(); startShortsSweep(); }
  if (changedKeys.some((k) => KEY_GROUPS.expand.includes(k))) autoExpandPlayer();
  if (changedKeys.some((k) => KEY_GROUPS.captions.includes(k))) { applyCaptions(); scheduleCaptionsRetries(); }
  if (changedKeys.some((k) => KEY_GROUPS.miniplayer.includes(k))) {
    if (changedKeys.includes("enabled") || changedKeys.includes("miniplayerEnabled")) startMiniplayerObserving();
    else {
      if (changedKeys.includes("miniplayerCorner")) updateMiniplayerCorner();
      if (changedKeys.includes("miniplayerSize")) updateMiniplayerSize();
    }
  }
  if (changedKeys.some((k) => KEY_GROUPS.cardsEndscreens.includes(k))) applyHideCardsEndscreens();
  if (changedKeys.some((k) => KEY_GROUPS.translation.includes(k))) applyNoTranslation();
});

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
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
function isAdShowing(player) { return !!player && player.classList.contains("ad-showing"); }
function isOptionLocked(el) {
  if (el.getAttribute("aria-disabled") === "true") return true;
  if (el.hasAttribute("disabled")) return true;
  const cls = (el.className || "").toString().toLowerCase();
  if (/disabled|premium|locked/.test(cls)) return true;
  if (el.querySelector('[class*="premium" i], [class*="locked" i], [class*="lock-icon" i]')) return true;
  const style = el.getAttribute("style") || "";
  if (/pointer-events:\s*none/i.test(style)) return true;
  return false;
}
function closeSettingsMenu(player) {
  const btn = player && player.querySelector(".ytp-settings-button");
  const menu = player && player.querySelector(".ytp-settings-menu");
  if (btn && menu && menu.offsetParent !== null) btn.click();
}

let resolutionInFlight = false;
async function applyResolution() {
  if (!settings.enabled || !settings.resolutionEnabled) return;
  if (resolutionInFlight) return;
  if (isShortsPage()) return;
  const player = getPlayer();
  if (!player || isAdShowing(player)) return;
  const desired = settings.preferredResolution || "hd1080";
  try {
    if (typeof player.setPlaybackQualityRange === "function") player.setPlaybackQualityRange(desired, desired);
    if (typeof player.setPlaybackQuality === "function") player.setPlaybackQuality(desired);
  } catch (e) {}
  const settingsBtn = player.querySelector(".ytp-settings-button");
  if (!settingsBtn) return;
  const existingMenu = player.querySelector(".ytp-settings-menu");
  if (existingMenu && existingMenu.offsetParent !== null) return;
  if (!mpFloating) {
    const rect = player.getBoundingClientRect();
    if (!(rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth)) return;
  }
  const ITEM_SELECTOR = '.ytp-settings-menu [role="menuitemradio"], .ytp-settings-menu [role="menuitem"], .ytp-settings-menu .ytp-menuitem, .ytp-panel-menu [role="menuitemradio"], .ytp-panel-menu [role="menuitem"], .ytp-panel-menu .ytp-menuitem';
  const RES_PATTERN = /\d{2,4}p(\d{1,3})?/i;
  resolutionInFlight = true;
  try {
    player.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    player.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    settingsBtn.click();
    const menuItems = await waitFor(() => {
      const items = Array.from(player.querySelectorAll(ITEM_SELECTOR));
      return items.length ? items : null;
    }, 1500);
    if (!menuItems) { closeSettingsMenu(player); return; }
    const qualityItem = menuItems.find((mi) => {
      const contentText = mi.querySelector(".ytp-menuitem-content")?.textContent || mi.textContent || "";
      return RES_PATTERN.test(contentText) || /^\s*quality/i.test(mi.textContent || "");
    });
    if (!qualityItem) { closeSettingsMenu(player); return; }
    const desiredLabel = QUALITY_LABELS[desired] || "1080p";
    const currentLabelText = (qualityItem.querySelector(".ytp-menuitem-content")?.textContent || qualityItem.textContent || "").trim();
    const isCurrentlyAuto = currentLabelText.includes("(");
    const alreadyCorrect = desired === "auto" ? isCurrentlyAuto : !isCurrentlyAuto && currentLabelText.startsWith(desiredLabel);
    if (alreadyCorrect) { closeSettingsMenu(player); return; }
    qualityItem.click();
    const options = await waitFor(() => {
      const radios = Array.from(player.querySelectorAll('.ytp-panel-menu [role="menuitemradio"], .ytp-settings-menu [role="menuitemradio"]'));
      const items = radios.length ? radios : Array.from(player.querySelectorAll(ITEM_SELECTOR));
      return items.length ? items : null;
    }, 1500);
    if (options) {
      const selectable = options.filter((o) => !isOptionLocked(o));
      const findByLabel = (label) => selectable.filter((o) => (o.textContent || "").trim().startsWith(label)).sort((a, b) => (a.textContent || "").trim().length - (b.textContent || "").trim().length)[0];
      let target;
      if (desired === "auto") target = selectable.find((o) => !RES_PATTERN.test((o.textContent || "").trim())) || selectable.find((o) => /^auto/i.test((o.textContent || "").trim()));
      else {
        target = findByLabel(desiredLabel);
        if (!target) {
          const startIdx = QUALITY_ORDER.indexOf(desired);
          for (let i = startIdx + 1; i < QUALITY_ORDER.length && !target; i++) target = findByLabel(QUALITY_LABELS[QUALITY_ORDER[i]]);
        }
      }
      if (target) target.click();
    }
    await wait(200);
    closeSettingsMenu(player);
  } catch (e) { closeSettingsMenu(player); } finally { resolutionInFlight = false; }
}
function scheduleResolutionRetries() {
  clearInterval(resolutionRetryTimer);
  if (!settings.enabled || !settings.resolutionEnabled) return;
  let attempts = 0;
  resolutionRetryTimer = setInterval(() => { attempts++; applyResolution(); if (attempts >= 5) clearInterval(resolutionRetryTimer); }, 2500);
}

function dispatchVolumeKey(target, key) {
  const opts = { key, code: key, keyCode: key === "ArrowUp" ? 38 : 40, which: key === "ArrowUp" ? 38 : 40, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
}
function nudgeVolumeWithKeyboard(player, current, target) {
  if (current === null) return;
  const steps = Math.round((target - current) / 5);
  if (steps === 0) return;
  const key = steps > 0 ? "ArrowUp" : "ArrowDown";
  const count = Math.min(Math.abs(steps), 20);
  for (let i = 0; i < count; i++) dispatchVolumeKey(player || document, key);
}
let volumeStuckTicks = 0;
function enforceFixedVolume() {
  if (!settings.enabled || !settings.fixedVolumeEnabled) return;
  const target = Math.min(100, Math.max(0, Math.round(settings.fixedVolume ?? 50)));
  const onShorts = isShortsPage();
  const player = onShorts ? null : getPlayer();
  const hasPlayerApi = !!player && typeof player.setVolume === "function";
  const video = getVideo();
  let current = null;
  try {
    if (hasPlayerApi && typeof player.getVolume === "function") current = player.getVolume();
    else if (video) current = Math.round(video.volume * 100);
  } catch (e) {}
  if (current !== null && Math.abs(current - target) <= 2) {
    volumeStuckTicks = 0;
    try {
      if (hasPlayerApi && typeof player.isMuted === "function" && target > 0 && player.isMuted()) player.unMute();
      else if (!hasPlayerApi && video && video.muted && target > 0) video.muted = false;
    } catch (e) {}
    return;
  }
  if (hasPlayerApi) {
    try {
      if (typeof player.isMuted === "function" && target > 0 && player.isMuted()) player.unMute();
      player.setVolume(target);
    } catch (e) {}
  } else if (video) {
    try {
      if (Math.abs(video.volume - target / 100) > 0.01) video.volume = target / 100;
      if (video.muted && target > 0) video.muted = false;
      video.dispatchEvent(new Event("volumechange", { bubbles: true }));
    } catch (e) {}
  }
  if (onShorts) { volumeStuckTicks = 0; return; }
  volumeStuckTicks++;
  if (volumeStuckTicks >= 2) { nudgeVolumeWithKeyboard(player, current, target); volumeStuckTicks = 0; }
}
function startVolumeEnforcement() {
  clearInterval(volumeEnforceInterval);
  if (!settings.enabled || !settings.fixedVolumeEnabled) return;
  enforceFixedVolume();
  volumeEnforceInterval = setInterval(enforceFixedVolume, 500);
}

const shortsFixed = new WeakSet();
function stripLoop(video) { if (video.hasAttribute("loop")) video.removeAttribute("loop"); }
function neutralizeLoop(video) {
  stripLoop(video);
  if (shortsFixed.has(video)) return;
  shortsFixed.add(video);
  try { Object.defineProperty(video, "loop", { get() { return false; }, set() {}, configurable: true }); } catch (e) {}
}
function fixShortsLoop() {
  if (!settings.enabled || !settings.stopShortsLoop) return;
  if (!isShortsPage()) return;
  document.querySelectorAll("video").forEach(neutralizeLoop);
}
const shortsObserver = new MutationObserver((mutations) => {
  if (!settings || !settings.enabled || !isShortsPage()) return;
  let sawNewVideo = false;
  for (const m of mutations) {
    if (m.type === "attributes" && m.attributeName === "loop") {
      if (settings.stopShortsLoop && m.target instanceof HTMLVideoElement) stripLoop(m.target);
      continue;
    }
    m.addedNodes.forEach((node) => {
      if (node.nodeType !== 1) return;
      const isVideo = node.tagName === "VIDEO";
      const nestedVideos = node.querySelectorAll ? Array.from(node.querySelectorAll("video")) : [];
      if (isVideo || nestedVideos.length) sawNewVideo = true;
      if (settings.stopShortsLoop) {
        if (isVideo) neutralizeLoop(node);
        nestedVideos.forEach(neutralizeLoop);
      }
    });
  }
  if (sawNewVideo && settings.fixedVolumeEnabled) enforceFixedVolume();
});
function startShortsSweep() {
  clearInterval(shortsSweepInterval);
  if (!settings.enabled || !settings.stopShortsLoop) return;
  shortsSweepInterval = setInterval(() => { if (isShortsPage()) document.querySelectorAll("video[loop]").forEach(stripLoop); }, 500);
}

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
  const sizeButton = document.querySelector(".ytp-size-button");
  if (sizeButton && !isTheaterActive()) sizeButton.click();
}

function applyCaptions() {
  if (!settings.enabled || !settings.captionsControlEnabled) return;
  const player = getPlayer();
  if (!player) return;
  const desiredOn = settings.captionsMode === "on";
  try {
    if (typeof player.isSubtitlesOn === "function") {
      if (player.isSubtitlesOn() !== desiredOn && typeof player.toggleSubtitlesOn === "function") player.toggleSubtitlesOn(desiredOn);
    } else if (typeof player.setOption === "function" && !desiredOn) player.setOption("captions", "track", {});
  } catch (e) {}
  const btn = document.querySelector(".ytp-subtitles-button");
  if (btn && btn.getAttribute("aria-pressed") === "true" !== desiredOn) btn.click();
}
function scheduleCaptionsRetries() {
  clearInterval(captionsRetryTimer);
  if (!settings.enabled || !settings.captionsControlEnabled) return;
  let attempts = 0;
  captionsRetryTimer = setInterval(() => { attempts++; applyCaptions(); if (attempts >= 6) clearInterval(captionsRetryTimer); }, 1000);
}

const MP_CORNER_CLASSES = ["ycc-mp-corner-tl", "ycc-mp-corner-tr", "ycc-mp-corner-bl", "ycc-mp-corner-br"];
const MP_CORNER_MAP = { "top-left": "ycc-mp-corner-tl", "top-right": "ycc-mp-corner-tr", "bottom-left": "ycc-mp-corner-bl", "bottom-right": "ycc-mp-corner-br" };
const MP_ORIGIN_MAP = { "top-left": "top left", "top-right": "top right", "bottom-left": "bottom left", "bottom-right": "bottom right" };
let mpObserver = null, mpObserverPlayerRef = null, mpObservedTarget = null, mpSpacer = null, mpWrapper = null, mpFloating = false, mpCloseBtn = null, mpNaturalWidth = 0, mpNaturalHeight = 0;
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
  if (mpCloseBtn) { mpCloseBtn.style.transform = `scale(${1 / scale})`; mpCloseBtn.style.transformOrigin = "top right"; }
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
  mpNaturalWidth = rect.width; mpNaturalHeight = rect.height;
  mpSpacer = document.createElement("div");
  mpSpacer.className = "ycc-mp-spacer";
  mpSpacer.style.width = rect.width + "px"; mpSpacer.style.height = rect.height + "px";
  player.parentNode.insertBefore(mpSpacer, player);
  mpWrapper = document.createElement("div");
  mpWrapper.className = "ycc-mp-wrapper " + getCornerClass();
  mpWrapper.style.width = mpNaturalWidth + "px"; mpWrapper.style.height = mpNaturalHeight + "px";
  document.body.appendChild(mpWrapper);
  mpWrapper.appendChild(player);
  mpCloseBtn = document.createElement("button");
  mpCloseBtn.className = "ycc-mp-close"; mpCloseBtn.type = "button"; mpCloseBtn.textContent = "\u2715";
  mpCloseBtn.setAttribute("aria-label", "Restore player");
  mpCloseBtn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); if (mpSpacer) mpSpacer.scrollIntoView({ behavior: "smooth", block: "start" }); });
  mpWrapper.appendChild(mpCloseBtn);
  applyMiniplayerScale(mpWrapper);
  mpFloating = true;
  if (mpObserver) { if (mpObservedTarget) mpObserver.unobserve(mpObservedTarget); mpObserver.observe(mpSpacer); mpObservedTarget = mpSpacer; }
}
function restoreFromFloat(player) {
  if (mpSpacer) { mpSpacer.after(player); mpSpacer.remove(); mpSpacer = null; }
  if (mpWrapper) { mpWrapper.remove(); mpWrapper = null; }
  mpCloseBtn = null; mpNaturalWidth = 0; mpNaturalHeight = 0; mpFloating = false;
}
function disengageMiniplayer(player) {
  if (!mpFloating) return;
  restoreFromFloat(player);
  if (mpObserver) { if (mpObservedTarget) mpObserver.unobserve(mpObservedTarget); mpObserver.observe(player); mpObservedTarget = player; }
}
function handleMiniplayerIntersection(entries) {
  if (!settings || !settings.enabled || !settings.miniplayerEnabled || isShortsPage() || !isWatchPage()) return;
  const player = getPlayer(); if (!player) return;
  for (const entry of entries) {
    if (entry.target === mpSpacer) { if (entry.isIntersecting) disengageMiniplayer(player); }
    else if (entry.target === player && !entry.isIntersecting && entry.boundingClientRect.bottom <= 0) engageMiniplayer(player);
  }
}
function stopMiniplayerObserving() {
  if (mpFloating && getPlayer()) restoreFromFloat(getPlayer());
  if (mpObserver) { mpObserver.disconnect(); mpObserver = null; }
  mpObservedTarget = null; mpObserverPlayerRef = null;
}
function startMiniplayerObserving() {
  if (!settings.enabled || !settings.miniplayerEnabled || isShortsPage() || !isWatchPage()) { stopMiniplayerObserving(); return; }
  const player = getPlayer(); if (!player) return;
  if (mpObserver && mpObserverPlayerRef === player) return;
  stopMiniplayerObserving();
  mpObserver = new IntersectionObserver(handleMiniplayerIntersection, { threshold: 0 });
  mpObserver.observe(player); mpObservedTarget = player; mpObserverPlayerRef = player;
}

function applyHideCardsEndscreens() {
  document.documentElement.classList.toggle("ycc-hide-cards-endscreens", !!(settings.enabled && settings.hideCardsEndscreens));
}

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
    if (keyMatch) apiKey = keyMatch[1]; if (verMatch) clientVersion = verMatch[1];
  } catch (e) {}
  cachedInnertubeConfig = { apiKey, clientVersion }; return cachedInnertubeConfig;
}
function getVideoIdFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, location.origin);
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const shortsMatch = u.pathname.match(/\/shorts\/([\w-]{6,})/); if (shortsMatch) return shortsMatch[1];
    const embedMatch = u.pathname.match(/\/embed\/([\w-]{6,})/); if (embedMatch) return embedMatch[1];
  } catch (e) {}
  return null;
}
function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}
async function fetchDescriptionFallback(videoId) {
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en&persist_hl=1`, { credentials: "omit" }, 6000);
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
function finalizeChapters(list) { if (!list.length) return null; list.sort((a, b) => a.startMillis - b.startMillis); return list; }
function extractChapters(data) {
  try {
    const markersMap = data?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBar?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;
    if (Array.isArray(markersMap)) {
      for (const entry of markersMap) {
        const chapters = entry?.value?.chapters;
        if (!Array.isArray(chapters) || !chapters.length) continue;
        const list = [];
        for (const c of chapters) {
          const ch = c?.chapterRenderer; if (!ch) continue;
          const title = textOf(ch.title);
          if (title) list.push({ title, startMillis: Number(ch.timeRangeStartMillis || 0) });
        }
        const done = finalizeChapters(list); if (done) return done;
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
            const r = it?.macroMarkersListItemRenderer; if (!r) continue;
            const title = textOf(r.title);
            if (title) list.push({ title, startMillis: timeStringToSeconds(textOf(r.timeSnippet)) * 1000 });
          }
          const done = finalizeChapters(list); if (done) return done;
        }
      }
    }
  } catch (e) {}
  return null;
}
function parseChaptersFromDescription(description) {
  if (!description) return null;
  const TS = /(\d{1,2}:\d{2}(?::\d{2})?)/;
  const lines = description.split(/\r?\n/);
  const hasTs = lines.map((l) => { const t = l.trim(); return t.length > 0 && TS.test(t); });
  const list = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim(); if (!trimmed) return;
    const m = trimmed.match(TS); if (!m) return;
    let before = false, after = false;
    for (let i = index - 1; i >= 0; i--) { if (lines[i].trim().length === 0) continue; before = hasTs[i]; break; }
    for (let i = index + 1; i < lines.length; i++) { if (lines[i].trim().length === 0) continue; after = hasTs[i]; break; }
    if (!before && !after) return;
    const ts = m[1], idx = m.index;
    let title = (idx === 0 || /^[-–—•·▪▫‣⁃→>*\s]+$/.test(trimmed.substring(0, idx))) ? trimmed.substring(idx + ts.length) : trimmed.substring(0, idx);
    title = title.replace(/^[-–—•·▪▫‣⁃→>*\s]+/, "").replace(/[-–—•·▪▫‣⁃→>*\s]+$/, "").trim();
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
    try {
      const res = await fetchWithTimeout(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`, {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", "X-Youtube-Client-Name": "1", "X-Youtube-Client-Version": clientVersion },
        body: JSON.stringify({ videoId, context: { client: { clientName: "WEB", clientVersion } } }),
      }, 6000);
      if (res.ok) {
        const data = await res.json();
        title = data?.videoDetails?.title || null;
        description = data?.videoDetails?.shortDescription || null;
        chapters = extractChapters(data);
      }
    } catch (e) {}
    if (!title) {
      try {
        const res2 = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + videoId)}&format=json`, { credentials: "omit" }, 6000);
        if (res2.ok) title = (await res2.json()).title || null;
      } catch (e2) {}
    }
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
  const videoId = getVideoIdFromUrl(location.href); if (!videoId) return;
  const titleEl = document.querySelector("ytd-watch-metadata h1.ytd-watch-metadata yt-formatted-string, ytd-watch-metadata yt-formatted-string.ytd-watch-metadata, #title h1 yt-formatted-string");
  if (!titleEl || isOriginalAppliedFor(titleEl, videoId)) return;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled || getVideoIdFromUrl(location.href) !== videoId || !meta || !meta.title) return;
  const oldTitle = titleEl.textContent;
  if (oldTitle !== meta.title) {
    titleEl.textContent = meta.title;
    if (titleEl.hasAttribute("title")) titleEl.setAttribute("title", meta.title);
    if (oldTitle && document.title.includes(oldTitle)) document.title = document.title.replace(oldTitle, meta.title);
  }
  markOriginalApplied(titleEl, videoId);
}
const FEED_TITLE_SELECTOR = "#video-title, ytd-reel-video-renderer #title, ytd-notification-renderer #message yt-formatted-string, #notification-title";
async function applyFeedTitle(titleEl) {
  const card = titleEl.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, ytd-reel-video-renderer, ytd-notification-renderer");
  const link = (card && (card.querySelector("a#thumbnail, a#video-title-link, a#video-title") || card.querySelector('a[href^="/watch"], a[href^="/shorts/"]'))) || titleEl.closest("a");
  const videoId = getVideoIdFromUrl(link && link.getAttribute("href")); if (!videoId) return;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled || !meta || !meta.title) return;
  if (titleEl.textContent !== meta.title) {
    titleEl.textContent = meta.title;
    if (titleEl.hasAttribute("title")) titleEl.setAttribute("title", meta.title);
  }
}
function scanFeedTitles() { if (settings.enabled && settings.noTranslationEnabled) document.querySelectorAll(FEED_TITLE_SELECTOR).forEach(applyFeedTitle); }
let searchSnippetStyleInjected = false;
function ensureSearchSnippetStyle() {
  if (searchSnippetStyleInjected || document.getElementById("ycc-search-style")) { searchSnippetStyleInjected = true; return; }
  const style = document.createElement("style"); style.id = "ycc-search-style";
  style.textContent = `
    .metadata-snippet-text[ycc-search] { display: none !important; }
    .metadata-snippet-container[ycc-search]::after, .metadata-snippet-container-one-line[ycc-search]::after {
      content: attr(data-original-description); font-size: var(--ytd-tab-system-font-size-body, 1.2rem);
      line-height: var(--ytd-tab-system-line-height-body, 1.6rem); font-family: var(--ytd-tab-system-font-family, inherit);
      color: var(--yt-spec-text-secondary, #aaa); white-space: pre-line;
    }
    ytd-video-renderer #description-text[ycc-search] { display: block !important; color: var(--yt-spec-text-secondary, #aaa); white-space: pre-line; }
  `;
  document.head.appendChild(style); searchSnippetStyleInjected = true;
}
function truncateDescription(description) {
  const short = description.split("\n").slice(0, 2).join("\n");
  return short.length > 100 ? short.substring(0, 100) + "..." : short;
}
function findSnippetEl(card) {
  let el = card.querySelector(".metadata-snippet-text"); if (el) return el;
  el = card.querySelector("#description-text"); if (el) return el;
  const container = card.querySelector(".metadata-snippet-container, .metadata-snippet-container-one-line");
  if (container) return container.querySelector("yt-formatted-string, yt-attributed-string") || container;
  const candidates = card.querySelectorAll("yt-formatted-string, yt-attributed-string");
  for (const c of candidates) {
    if (c.id === "video-title" || c.closest("#byline-container, #owner, ytd-metadata-row-container-renderer, ytd-rich-metadata-row-renderer, #menu, #actions, #title")) continue;
    if ((c.textContent || "").trim().length >= 40) return c;
  }
  return null;
}
async function applyFeedDescription(descEl, card) {
  card = card || descEl.closest("ytd-video-renderer"); if (!card) return;
  const link = card.querySelector("a#thumbnail, a#video-title-link, a#video-title") || card.querySelector('a[href^="/watch"], a[href^="/shorts/"]') || descEl.closest("a");
  const videoId = getVideoIdFromUrl(link && link.getAttribute("href")); if (!videoId) return;
  const container = descEl.closest(".metadata-snippet-container, .metadata-snippet-container-one-line");
  if (descEl.getAttribute("ycc-search") === videoId && (!container || (container.getAttribute("ycc-search") === videoId && container.hasAttribute("data-original-description")))) return;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled || !meta || !meta.description) return;
  ensureSearchSnippetStyle();
  const truncated = truncateDescription(meta.description);
  if (container) {
    container.setAttribute("data-original-description", truncated);
    container.setAttribute("ycc-search", videoId);
    descEl.setAttribute("ycc-search", videoId); descEl.setAttribute("translate", "no");
  } else if (descEl.id === "description-text") {
    descEl.textContent = truncated; descEl.setAttribute("ycc-search", videoId);
  } else {
    const current = (descEl.textContent || "").trim();
    const normalized = meta.description.replace(/\s+/g, " ").trim();
    let text = normalized;
    if (current.length && normalized.length > current.length) text = normalized.slice(0, Math.max(1, current.length - 1)).trimEnd() + "…";
    if (current !== text) descEl.textContent = text;
    descEl.setAttribute("ycc-search", videoId);
  }
}
function scanFeedDescriptions() {
  if (!settings.enabled || !settings.noTranslationEnabled) return;
  document.querySelectorAll("ytd-video-renderer").forEach((card) => { const el = findSnippetEl(card); if (el) applyFeedDescription(el, card); });
}
async function applyOriginalDescription() {
  if (!isWatchPage()) return;
  const videoId = getVideoIdFromUrl(location.href); if (!videoId) return;
  const descEl = document.querySelector("ytd-text-inline-expander#description-inline-expander yt-attributed-string, #description-inline-expander yt-attributed-string, #description yt-attributed-string");
  if (!descEl || isOriginalAppliedFor(descEl, videoId)) return;
  const meta = await fetchOriginalVideoMeta(videoId);
  if (!settings.enabled || !settings.noTranslationEnabled || getVideoIdFromUrl(location.href) !== videoId || !meta || !meta.description) return;
  descEl.textContent = meta.description; markOriginalApplied(descEl, videoId);
}
let cachedChapters = [], cachedChaptersVideoId = null, chapterUpdateInterval = null;
function findChapterByTime(seconds, chapters) {
  let current = null;
  for (const ch of chapters) { if (ch.startMillis / 1000 <= seconds) current = ch; else break; }
  return current;
}
function getCurrentVideoTime() {
  const player = getPlayer(); const v = (player && player.querySelector("video")) || getVideo();
  return v ? Math.floor(v.currentTime || 0) : 0;
}
async function ensureChapters(videoId) {
  if (cachedChaptersVideoId === videoId) return cachedChapters;
  const meta = await fetchOriginalVideoMeta(videoId);
  cachedChapters = (meta && meta.chapters) || []; cachedChaptersVideoId = videoId;
  return cachedChapters;
}
function replaceIfDifferent(el, newText) {
  if (!el) return; const cur = (el.textContent || "").trim();
  if (cur && cur !== newText) el.textContent = newText;
}
function updateChapterButton(chapters) {
  const el = document.querySelector(".ytp-chapter-title .ytp-chapter-title-content"); if (!el) return;
  const ch = findChapterByTime(getCurrentVideoTime(), chapters); if (ch) replaceIfDifferent(el, ch.title);
}
function updateChapterTooltip(chapters) {
  const tip = document.querySelector('.ytp-tooltip.ytp-preview:not([style*="display: none"])'); if (!tip) return;
  let timeEl = tip.querySelector(".ytp-tooltip-progress-bar-pill-time-stamp");
  let titleEl = tip.querySelector(".ytp-tooltip-progress-bar-pill-title");
  if (!timeEl || !titleEl) { timeEl = tip.querySelector(".ytp-tooltip-text"); titleEl = tip.querySelector(".ytp-tooltip-title span"); }
  if (!timeEl || !titleEl || !(timeEl.textContent || "").trim()) return;
  const ch = findChapterByTime(timeStringToSeconds(timeEl.textContent), chapters); if (ch) replaceIfDifferent(titleEl, ch.title);
}
function updateChapterPanel(chapters) {
  const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-description-chapters"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]');
  if (!panel) return;
  panel.querySelectorAll("ytd-macro-markers-list-item-renderer .macro-markers").forEach((el) => {
    const timeEl = el.closest("ytd-macro-markers-list-item-renderer")?.querySelector("#time"); if (!timeEl) return;
    const ch = findChapterByTime(timeStringToSeconds(timeEl.textContent || ""), chapters); if (ch) replaceIfDifferent(el, ch.title);
  });
}
function stopChapterUpdater() { clearInterval(chapterUpdateInterval); chapterUpdateInterval = null; }
async function applyOriginalChapters() {
  if (!isWatchPage() || !settings.enabled || !settings.noTranslationEnabled) { stopChapterUpdater(); return; }
  const videoId = getVideoIdFromUrl(location.href); if (!videoId) return;
  const chapters = await ensureChapters(videoId);
  if (!chapters.length) { stopChapterUpdater(); return; }
  const run = () => { updateChapterButton(chapters); updateChapterTooltip(chapters); updateChapterPanel(chapters); };
  run(); if (!chapterUpdateInterval) chapterUpdateInterval = setInterval(run, 250);
}
let translationObserver = null, translationScanTimer = null;
function scheduleTranslationScan() {
  clearTimeout(translationScanTimer);
  translationScanTimer = setTimeout(() => { scanFeedTitles(); scanFeedDescriptions(); applyOriginalChapters(); }, 250);
}
function startTranslationObserver() {
  if (translationObserver) return;
  translationObserver = new MutationObserver(() => { if (settings && settings.enabled && settings.noTranslationEnabled) scheduleTranslationScan(); });
  translationObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}
function stopTranslationObserver() { if (translationObserver) { translationObserver.disconnect(); translationObserver = null; } clearTimeout(translationScanTimer); }
function applyNoTranslation() {
  if (!(settings.enabled && settings.noTranslationEnabled)) { stopTranslationObserver(); stopChapterUpdater(); return; }
  startTranslationObserver(); applyMainTitle(); applyOriginalDescription(); scanFeedTitles(); scanFeedDescriptions(); applyOriginalChapters();
}

let shortsWheelAccumulator = 0, shortsWheelResetTimer = null, shortsWheelCooldown = false;
const SHORTS_WHEEL_THRESHOLD = 200, SHORTS_WHEEL_COOLDOWN_MS = 800, SHORTS_WHEEL_RESET_MS = 300;
const SHORTS_WHEEL_EXEMPT_SELECTOR = "ytd-comments, ytd-engagement-panel-section-list-renderer, #panels, #secondary, #related, #guide, #masthead-container, header, ytd-rich-section-renderer, ytd-shelf-renderer";
const SHORTS_WHEEL_STAGE_SELECTOR = "ytd-shorts, #shorts-container, #page-container, ytd-reel-video-renderer, #player-container";
function handleShortsWheel(e) {
  if (!settings || !settings.enabled || !settings.disableShortsWheelScroll || !isShortsPage() || !(e.target instanceof Element)) return;
  if (e.target.closest(SHORTS_WHEEL_EXEMPT_SELECTOR)) return;
  if (!e.target.closest(SHORTS_WHEEL_STAGE_SELECTOR)) return;
  if (shortsWheelCooldown) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return; }
  let delta = e.deltaY;
  if (e.deltaMode === 1) delta *= 30; if (e.deltaMode === 2) delta *= window.innerHeight;
  if ((shortsWheelAccumulator > 0 && delta < 0) || (shortsWheelAccumulator < 0 && delta > 0)) shortsWheelAccumulator = 0;
  shortsWheelAccumulator += delta;
  clearTimeout(shortsWheelResetTimer);
  shortsWheelResetTimer = setTimeout(() => { shortsWheelAccumulator = 0; }, SHORTS_WHEEL_RESET_MS);
  if (Math.abs(shortsWheelAccumulator) >= SHORTS_WHEEL_THRESHOLD) {
    shortsWheelAccumulator = 0; shortsWheelCooldown = true;
    setTimeout(() => { shortsWheelCooldown = false; }, SHORTS_WHEEL_COOLDOWN_MS);
    return;
  }
  e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
}

function applyAll() {
  if (!settings) return;
  applyResolution(); scheduleResolutionRetries(); startVolumeEnforcement(); fixShortsLoop(); startShortsSweep();
  autoExpandPlayer(); applyCaptions(); scheduleCaptionsRetries(); startMiniplayerObserving(); applyHideCardsEndscreens(); applyNoTranslation();
}
function onNavigate() { clearTimeout(navigateTimer); navigateTimer = setTimeout(applyAll, 400); setTimeout(applyAll, 1200); }
function init() {
  console.info("[YPI] content.js build " + BUILD_TAG);
  loadSettings().then(() => {
    applyAll();
    shortsObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["loop"] });
  });
  window.addEventListener("yt-navigate-finish", onNavigate);
  window.addEventListener("yt-page-data-updated", onNavigate);
  document.addEventListener("wheel", handleShortsWheel, { capture: true, passive: false });
  setInterval(() => {
    if (!settings) return;
    startVolumeEnforcement(); fixShortsLoop(); autoExpandPlayer(); applyCaptions(); startMiniplayerObserving(); applyNoTranslation();
  }, 5000);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();