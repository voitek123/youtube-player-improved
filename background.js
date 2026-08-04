// background.js
// Sets sensible defaults the first time the addon is installed,
// and migrates/fills in any missing keys on updates.
const DEFAULT_SETTINGS = {
  enabled: true,
  resolutionEnabled: false,
  preferredResolution: "hd1080",
  fixedVolumeEnabled: false,
  fixedVolume: 50,
  stopShortsLoop: false,
  autoExpandEnabled: false,
  captionsControlEnabled: false,
  captionsMode: "off",
  miniplayerEnabled: false,
  miniplayerCorner: "bottom-right",
  miniplayerSize: "400x225",
  hideCardsEndscreens: false,
  noTranslationEnabled: false,
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