// background.js
// Sets sensible defaults the first time the addon is installed,
// and migrates/fills in any missing keys on updates.
const DEFAULT_SETTINGS = {
  enabled: true,
  // 1. Preferred quality
  resolutionEnabled: false,
  preferredResolution: "hd1080",
  avoidPremiumQualities: true,
  // 2. Default volume level (applied when a video starts)
  fixedVolumeEnabled: false,
  fixedVolume: 50, // 0 - 100
  // 3. Block volume scroll (wheel over the volume control)
  disableVolumeWheel: false,
  // 4. Mute hover-preview videos
  muteHoverPreviews: true,
  // 5. Prevent Shorts from looping
  stopShortsLoop: false,
  // 6. Auto-expand player (theater mode)
  autoExpandEnabled: false,
  // 7. Captions / subtitles control
  captionsControlEnabled: false,
  captionsMode: "off",
  // 8. Mini player when scrolling to comments
  miniplayerEnabled: false,
  miniplayerCorner: "bottom-right",
  miniplayerSize: "400x225",
  // 9. Hide info cards and end screens
  hideCardsEndscreens: false,
  // 10. Prevent auto-translation (titles, descriptions, chapters)
  noTranslationEnabled: false,
  // 11. Prevent accidental Shorts scrolling
  disableShortsWheelScroll: false
};

async function initSettings() {
  const current = await browser.storage.local.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...current };
  await browser.storage.local.set(merged);
}

browser.runtime.onInstalled.addListener(() => {
  initSettings();
});

initSettings();