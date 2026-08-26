// popup.js
const DEFAULTS = {
  enabled: true,
  resolutionEnabled: false,
  preferredResolution: "hd1080",
  blockPremiumPromos: true,
  fixedVolumeEnabled: false,
  fixedVolume: 50,
  disableVolumeWheel: false,
  muteHoverPreviews: true,
  stopShortsLoop: false,
  autoExpandEnabled: false,
  captionsControlEnabled: false,
  captionsMode: "off",
  miniplayerEnabled: false,
  miniplayerCorner: "bottom-right",
  miniplayerSize: "400x225",
  hideCardsEndscreens: false,
  noTranslationEnabled: false,
  disableShortsWheelScroll: false,
};

const els = {
  master: document.getElementById("masterToggle"),
  versionText: document.getElementById("version-text"),
  resolutionEnabled: document.getElementById("resolutionEnabled"),
  preferredResolution: document.getElementById("preferredResolution"),
  blockPremiumPromos: document.getElementById("blockPremiumPromos"),
  resolutionSubRow: document.getElementById("resolutionSubRow"),
  fixedVolumeEnabled: document.getElementById("fixedVolumeEnabled"),
  fixedVolume: document.getElementById("fixedVolume"),
  volumeValue: document.getElementById("volumeValue"),
  volumeSubRow: document.getElementById("volumeSubRow"),
  disableVolumeWheel: document.getElementById("disableVolumeWheel"),
  muteHoverPreviews: document.getElementById("muteHoverPreviews"),
  stopShortsLoop: document.getElementById("stopShortsLoop"),
  autoExpandEnabled: document.getElementById("autoExpandEnabled"),
  captionsControlEnabled: document.getElementById("captionsControlEnabled"),
  captionsMode: document.getElementById("captionsMode"),
  captionsSubRow: document.getElementById("captionsSubRow"),
  miniplayerEnabled: document.getElementById("miniplayerEnabled"),
  miniplayerCorner: document.getElementById("miniplayerCorner"),
  miniplayerSize: document.getElementById("miniplayerSize"),
  miniplayerSubRow: document.getElementById("miniplayerSubRow"),
  hideCardsEndscreens: document.getElementById("hideCardsEndscreens"),
  noTranslationEnabled: document.getElementById("noTranslationEnabled"),
  disableShortsWheelScroll: document.getElementById("disableShortsWheelScroll"),
  resetDefaults: document.getElementById("resetDefaults"),
  statusText: document.getElementById("status-text"),
};

if (els.versionText) {
  els.versionText.textContent = "v" + browser.runtime.getManifest().version;
}

function refreshSubRows() {
  els.resolutionSubRow.style.display = els.resolutionEnabled.checked ? "block" : "none";
  els.volumeSubRow.style.display = els.fixedVolumeEnabled.checked ? "block" : "none";
  els.captionsSubRow.style.display = els.captionsControlEnabled.checked ? "block" : "none";
  els.miniplayerSubRow.style.display = els.miniplayerEnabled.checked ? "block" : "none";
}

function setControlsDisabled(disabled) {
  document.getElementById("controls").style.opacity = disabled ? "0.4" : "1";
  document.getElementById("controls").style.pointerEvents = disabled ? "none" : "auto";
  els.statusText.textContent = disabled ? "Disabled" : "Active on YouTube";
}

function loadFromSettings(s) {
  els.master.checked = !!s.enabled;
  els.resolutionEnabled.checked = !!s.resolutionEnabled;
  els.preferredResolution.value = s.preferredResolution || "hd1080";
  els.blockPremiumPromos.checked = !!s.blockPremiumPromos;
  els.fixedVolumeEnabled.checked = !!s.fixedVolumeEnabled;
  els.fixedVolume.value = s.fixedVolume ?? 50;
  els.volumeValue.textContent = s.fixedVolume ?? 50;
  els.disableVolumeWheel.checked = !!s.disableVolumeWheel;
  els.muteHoverPreviews.checked = !!s.muteHoverPreviews;
  els.stopShortsLoop.checked = !!s.stopShortsLoop;
  els.autoExpandEnabled.checked = !!s.autoExpandEnabled;
  els.captionsControlEnabled.checked = !!s.captionsControlEnabled;
  els.captionsMode.value = s.captionsMode || "off";
  els.miniplayerEnabled.checked = !!s.miniplayerEnabled;
  els.miniplayerCorner.value = s.miniplayerCorner || "bottom-right";
  els.miniplayerSize.value = s.miniplayerSize || "400x225";
  els.hideCardsEndscreens.checked = !!s.hideCardsEndscreens;
  els.noTranslationEnabled.checked = !!s.noTranslationEnabled;
  els.disableShortsWheelScroll.checked = !!s.disableShortsWheelScroll;
  refreshSubRows();
  setControlsDisabled(!s.enabled);
}

browser.storage.local.get(null).then(loadFromSettings);

function save(partial) {
  browser.storage.local.set(partial);
}

els.master.addEventListener("change", () => {
  save({ enabled: els.master.checked });
  setControlsDisabled(!els.master.checked);
});
els.resolutionEnabled.addEventListener("change", () => {
  save({ resolutionEnabled: els.resolutionEnabled.checked });
  refreshSubRows();
});
els.preferredResolution.addEventListener("change", () => {
  save({ preferredResolution: els.preferredResolution.value });
});
els.blockPremiumPromos.addEventListener("change", () => {
  save({ blockPremiumPromos: els.blockPremiumPromos.checked });
});
els.fixedVolumeEnabled.addEventListener("change", () => {
  save({ fixedVolumeEnabled: els.fixedVolumeEnabled.checked });
  refreshSubRows();
});
els.fixedVolume.addEventListener("input", () => {
  els.volumeValue.textContent = els.fixedVolume.value;
});
els.fixedVolume.addEventListener("change", () => {
  save({ fixedVolume: Number(els.fixedVolume.value) });
});
els.disableVolumeWheel.addEventListener("change", () => {
  save({ disableVolumeWheel: els.disableVolumeWheel.checked });
});
els.muteHoverPreviews.addEventListener("change", () => {
  save({ muteHoverPreviews: els.muteHoverPreviews.checked });
});
els.stopShortsLoop.addEventListener("change", () => {
  save({ stopShortsLoop: els.stopShortsLoop.checked });
});
els.autoExpandEnabled.addEventListener("change", () => {
  save({ autoExpandEnabled: els.autoExpandEnabled.checked });
});
els.captionsControlEnabled.addEventListener("change", () => {
  save({ captionsControlEnabled: els.captionsControlEnabled.checked });
  refreshSubRows();
});
els.captionsMode.addEventListener("change", () => {
  save({ captionsMode: els.captionsMode.value });
});
els.miniplayerEnabled.addEventListener("change", () => {
  save({ miniplayerEnabled: els.miniplayerEnabled.checked });
  refreshSubRows();
});
els.miniplayerCorner.addEventListener("change", () => {
  save({ miniplayerCorner: els.miniplayerCorner.value });
});
els.miniplayerSize.addEventListener("change", () => {
  save({ miniplayerSize: els.miniplayerSize.value });
});
els.hideCardsEndscreens.addEventListener("change", () => {
  save({ hideCardsEndscreens: els.hideCardsEndscreens.checked });
});
els.noTranslationEnabled.addEventListener("change", () => {
  save({ noTranslationEnabled: els.noTranslationEnabled.checked });
});
els.disableShortsWheelScroll.addEventListener("change", () => {
  save({ disableShortsWheelScroll: els.disableShortsWheelScroll.checked });
});
els.resetDefaults.addEventListener("click", () => {
  browser.storage.local.set(DEFAULTS).then(() => loadFromSettings(DEFAULTS));
});