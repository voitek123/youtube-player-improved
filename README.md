# Youtube Player Improved (Firefox Addon)

**Version 1.0**

A Firefox extension for YouTube with nine features, all controlled from a single toolbar popup:

- **Preferred quality** – forces a chosen video quality (144p–4K or Auto) on every video, including embedded YouTube players on other sites.
- **Default volume level** – locks playback volume to a set percentage and auto-unmutes, including embedded YouTube players on other sites.
- **Prevent Shorts from looping** – pauses a Short on its last frame instead of looping forever. Off by default.
- **Auto-expand player** – automatically switches videos into theater (large) mode.
- **Captions & subtitles control** – keeps captions always off (or always on), overriding YouTube's auto-detected preference so they don't switch themselves on when a video loads. Also works on embedded YouTube players on other sites.
- **Mini player** – when you scroll down past the video (to read comments, for example), it smoothly detaches into a small floating window - size (320x180 up to 1280x720) and corner both configurable - and keeps playing without interruption. The window keeps the player's standard 16:9 shape at the chosen width and stays that size for the whole video. Scrolling back up, or clicking the close button, returns it to its normal place.
- **Hide info cards & end screens** – automatically removes the "i" info card teasers shown during playback and the suggested-video overlay grid at the end of videos.
- **No translations** – keeps original titles, descriptions and chapters: watch-page title/tab title/tooltips, feed and search titles (incl. Shorts and notifications), watch-page descriptions and feed/search description snippets, and chapter names (control-bar chip, seekbar hover pill, chapters panel). Modeled on the proven "YouTube No Translation" extension. YouTube UI chrome (view counts, buttons, hints) follows the interface language and is intentionally left untouched.
- **Prevent accidental Shorts scrolling** – stops accidental 1-notch mouse wheel bumps or light trackpad swipes from switching Shorts by requiring a deliberate scroll threshold to be crossed, while the comments column, left menu, header and panels keep their normal scrolling.

Everything is toggleable individually from the toolbar popup, which also has a "Reset to defaults" button.

## Install temporarily (for testing)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click *Load Temporary Add-on…*.
3. Select the `manifest.json` file inside this folder.
4. The extension icon appears in the toolbar. Open any YouTube video to see it in action.

Note: temporary add-ons are removed when Firefox restarts and never update on their own — after replacing any file, remove the add-on and load it again (or click "Reload") at the same page.

## Install permanently

Firefox requires extensions to be signed by Mozilla to install permanently in release Firefox. Two options:

- **Firefox Developer Edition / Nightly:** set `xpinstall.signatures.required` to `false` in `about:config`, then drag the packaged `.xpi` (a renamed zip of this folder) into a Firefox window.
- **Self-distribution with signing:** create a free account at https://addons.mozilla.org, use `web-ext sign` (from the `web-ext` npm package) with your API credentials to get a signed `.xpi`, then install that file normally in any Firefox release.

```
npm install -g web-ext
cd youtube-player-improved
web-ext sign --api-key=YOUR_KEY --api-secret=YOUR_SECRET
```

## Works regardless of YouTube's interface language

Every feature detects state structurally (DOM attributes, ARIA roles, resolution-number patterns like `1080p60`) rather than by matching English words in menu text, so it works the same whether YouTube is displaying in English, Polish, or anything else:

- **Quality:** the Quality row and its options are found by their `\d+p` resolution pattern, not the word "Quality"/"Auto" - and "Auto currently showing 1080p" vs. "manually pinned to 1080p" is distinguished by whether the resolution is wrapped in parentheses (how Auto mode always displays it), not by any translated label.
- **Auto-expand:** reads `ytd-watch-flexy`'s `theater` attribute, a plain boolean flag YouTube sets internally - not the size button's (translated) tooltip text.
- **Captions:** reads the CC button's `aria-pressed` attribute (`"true"`/`"false"`, not translated).
- **Fixed volume and Shorts loop-blocking** never depended on any text to begin with.

## How it works

Quality, volume, and captions control also run inside embedded YouTube players on third-party sites (`youtube.com/embed/...` and the privacy-enhanced `youtube-nocookie.com/embed/...`, both with and without the `www.` prefix), via a second content-script rule with `all_frames: true` scoped specifically to that URL pattern. Shorts loop-blocking, auto-expand, and the mini player stay inactive there - they're gated behind checks like the page path starting with `/watch`, which naturally excludes `/embed/...`.

`content.js` runs on `youtube.com` pages and reacts to YouTube's internal `yt-navigate-finish` event (fired on every SPA navigation) to reapply settings whenever you open a new video, without a full page reload.

Settings are stored with `browser.storage.local` and shared live between the popup and the content script via `storage.onChanged`.

The quality feature drives YouTube's own Settings-menu UI (the old `setPlaybackQuality()` API is silently ignored now), waiting for menus to render instead of guessing delays. Resolution rows are matched by their language-independent pattern; "still on Auto" is detected by the parentheses YouTube wraps the auto-picked resolution in; Premium-locked options are skipped with a step-down to the next free tier. It closes the menu by clicking the gear again (Escape collapses theater mode), and skips the automation entirely when the player is off-screen (clicking off-screen buttons scrolls the page back up).

Fixed volume is driven primarily through the player's own `setVolume()`/`unMute()` API (what the visible slider reflects); direct `<video>` writes only as a fallback; simulated arrow keys as a last resort - skipped on Shorts, where arrows switch videos. On Shorts the active `<video>` is identified by on-screen area, and volume is re-corrected the moment a new Short appears.

The Shorts loop fix strips the `loop` attribute and blocks the `.loop` JS property, with a `MutationObserver` (`attributeFilter: ["loop"]`) plus an interval sweep as a backstop.

Auto-expand reads `ytd-watch-flexy`'s `theater` attribute - a plain boolean flag YouTube sets internally regardless of interface language - with the size button's (translated) tooltip text only as a last-resort fallback.

Settings changes are scoped: adjusting one feature only re-applies that feature.

Captions control uses the player API (`isSubtitlesOn`/`toggleSubtitlesOn`) first, then verifies against the visible CC button's `aria-pressed` state and clicks it if the two disagree.

Hiding info cards and end screens is a plain CSS switch - a class on `<html>` that `display: none` rules key off.

The mini player reparents the player element into a plain wrapper `<div>` appended to `<body>`; all positioning/sizing (position:fixed, corner, transform: scale()) happens on the wrapper, never on the player itself (earlier attempts that styled the player directly made YouTube's own code re-layout or panic). The wrapper is sized to the player's natural on-screen box and keeps that 16:9 shape, scaled to the width chosen in the popup, for the entire video. A sibling spacer holds the original layout spot and marks where to move the player back.

No translations is modeled on the open-source "YouTube No Translation" extension (github.com/YouG-o/YouTube-No-Translation, AGPL-3.0). YouTube's `/youtubei/v1/player` endpoint returns each video's canonical (original-language) metadata as long as the request carries no `hl`/`gl` locale forcing - the translations you see come from YouTube's own localized rendering. The addon fetches that canonical data (credential-less, same-origin, cached per video ID, failures not cached) and rewrites the visible text:

- **Titles:** watch-page title, tab title and tooltips; feed/search titles keyed off `#video-title`; Shorts titles; notification titles - with the video ID taken from each card's own link.
- **Descriptions:** the watch-page description (plain-text substitution - clickable timestamps/links within it are lost, a known trade-off) and feed/search snippets. Snippets use the reference extension's technique: the translated text lives in `.metadata-snippet-text`, an element YouTube's framework re-renders constantly (which is why overwriting its textContent never stuck), so it is hidden with CSS and the original - first two lines, capped at 100 characters, same as the reference - is rendered via `::after { content: attr(data-original-description) }` on `.metadata-snippet-container`/`-one-line`, which YouTube does not rewrite; marker attributes are re-asserted on every scan. History-style `#description-text` layouts get a direct text replacement.
- **Chapters:** original list from the canonical player response (seekbar markers / chapters panel) or timestamp lines in the original description; the control-bar chip (`.ytp-chapter-title .ytp-chapter-title-content`), the seekbar hover pill (`.ytp-tooltip-progress-bar-pill-time-stamp` + `-title`, or `.ytp-tooltip-text` + `.ytp-tooltip-title span` on the old player) and the chapters panel rows (`ytd-macro-markers-list-item-renderer .macro-markers` matched by `#time`) are rewritten by timestamp and re-applied on a 250ms interval so YouTube's re-renders never win.
- YouTube UI chrome strings (view counts, buttons, hints) follow the interface language and are intentionally left untouched - this feature restores creator content only.

Preventing accidental Shorts scrolling intercepts the `wheel` event in the capture phase and accumulates the scroll delta (normalized for mice vs trackpads); only once a deliberate threshold is crossed (roughly 2 mouse wheel notches or a firm trackpad swipe) is the event allowed through to YouTube, and a short cooldown stops momentum from switching several Shorts in a row. Changing direction resets the accumulator. The guard covers the whole Shorts stage (`ytd-shorts`, `#shorts-container`, `#page-container`, reel renderers, player container) so it keeps working after every switch - an earlier "player element only" match stopped applying once YouTube re-rendered the stage under the pointer - while side areas (comments, panels, guide, header, shelves) are exempted first and always scroll normally. `{ passive: false }` is required for `preventDefault()` to work.

## Folder contents

```
manifest.json         Extension manifest (Manifest V2, Firefox-targeted)
background.js         Sets default settings on install
content.js            Core logic, injected into youtube.com pages
content.css           Styles for the mini player
popup.html/.js/.css   Toolbar popup with all settings, incl. "Reset to defaults"
icons/                Extension icons
```