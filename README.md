# Youtube Player Improved (Firefox Addon)

**Version 1.3**

A Firefox extension for YouTube with eleven features, all controlled from a single toolbar popup:

- **Preferred quality** – forces a chosen video quality (144p–4K or Auto) on every video, including embedded YouTube players on other sites. If the preferred resolution isn't available (or is Premium-locked), the closest **lower** non-Premium tier is selected instead - never Auto. The "Avoid Premium qualities" toggle (on by default) skips Premium-only rows entirely so the Premium upsell dialog never appears; when no free tier exists below the preferred resolution, the video stays on Auto. The settings-menu automation runs with the menu UI hidden, so the settings panel never visibly pops open.
- **Default volume level** – sets the volume once when a video starts (and once per new Short). After that the volume is fully under your control - no continuous enforcement.
- **Block volume scroll** – scrolling the mouse wheel over the player's volume control no longer changes the volume.
- **Mute hover previews** – videos that start playing when you hover a thumbnail stay muted. On by default.
- **Prevent Shorts from looping** – pauses a Short on its last frame instead of looping forever. Off by default.
- **Auto-expand player** – automatically switches videos into theater (large) mode.
- **Captions & subtitles control** – keeps captions always off (or always on), overriding YouTube's auto-detected preference so they don't switch themselves on when a video loads. Also works on embedded YouTube players on other sites.
- **Mini player** – when you scroll down past the video (to read comments, for example), it smoothly detaches into a small floating window - size (320x180 up to 1280x720) and corner both configurable - and keeps playing without interruption. The window keeps the player's standard 16:9 shape at the chosen width and stays that size for the whole video. Scrolling back up, or clicking the close button, returns it to its normal place.
- **Hide info cards & end screens** – automatically removes the "i" info card teasers shown during playback and the suggested-video overlay grid at the end of videos. Also works inside embedded players.
- **No translations** – keeps titles, descriptions and chapters in their original language instead of YouTube's automatic translation: the watch-page title, tab title and tooltips; feed and search titles (including Shorts and notifications); the watch-page description and feed/search description snippets; chapter names (control-bar chip, seekbar hover pill, chapters panel); and the title overlay shown on embedded players. YouTube UI chrome (view counts, buttons, hints) follows the interface language and is intentionally left untouched.
- **Prevent accidental Shorts scrolling** – requires a deliberate scroll (crossing a threshold) to switch Shorts, so accidental 1-notch mouse wheel bumps or light trackpad swipes never switch the video, while the comments column, left menu, header and panels keep their normal scrolling.

Everything is toggleable individually from the toolbar popup, which also has a "Reset to defaults" button and a "Report a bug" button that opens the project's GitHub issues page (https://github.com/voitek123/youtube-player-improved/issues).

## Install temporarily (for testing)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click *Load Temporary Add-on…*.
3. Select the `manifest.json` file inside this folder.
4. The extension icon appears in the toolbar. Open any YouTube video to see it in action.

Note: temporary add-ons are removed when Firefox restarts and never update on their own — after replacing any file, remove the add-on and load it again (or click "Reload") at the same page. `content.js` logs a build tag to the Web Console on load (Ctrl+Shift+K on a YouTube tab, then reload), so you can verify the file you replaced is the one running.

## Works regardless of YouTube's interface language

Every feature detects state structurally (DOM attributes, ARIA roles, resolution-number patterns like `1080p60`) rather than by matching English words in menu text, so it works the same whether YouTube is displaying in English, Polish, or anything else:

- **Quality:** the Quality row and its options are found by their `\d+p` resolution pattern, not the word "Quality"/"Auto" - and "Auto currently showing 1080p" vs. "manually pinned to 1080p" is distinguished by whether the resolution is wrapped in parentheses (how Auto mode always displays it), not by any translated label. Premium rows are detected via the (untranslated) brand term "Premium".
- **Auto-expand:** reads `ytd-watch-flexy`'s `theater` attribute, a plain boolean flag YouTube sets internally - not the size button's (translated) tooltip text.
- **Captions:** reads the CC button's `aria-pressed` attribute (`"true"`/`"false"`, not translated).
- **Volume, loop-blocking, volume-scroll blocking and hover-preview muting** never depend on any text.

## How it works

Quality, volume, captions control, info-card/end-screen hiding, volume-scroll blocking and the no-translation title restoration also run inside embedded YouTube players on third-party sites (`youtube.com/embed/...` and the privacy-enhanced `youtube-nocookie.com/embed/...`, both with and without the `www.` prefix), via a second content-script rule with `all_frames: true` scoped specifically to that URL pattern - so it injects into the embed iframe itself, not into unrelated iframes on the host page. Shorts loop-blocking, auto-expand, and the mini player stay inactive there since none of those concepts apply to a bare embed - they're gated behind checks like the page path starting with `/watch`, which naturally excludes `/embed/...`. Note that if a site sandboxes its embed iframes in a way that blocks scripts entirely, no extension can run inside it - that's a restriction the host page itself is imposing, not something fixable from here.

`content.js` runs on `youtube.com` pages and reacts to YouTube's internal `yt-navigate-finish` event (fired on every SPA navigation) to reapply settings whenever you open a new video, without a full page reload.

Settings are stored with `browser.storage.local` and shared live between the popup and the content script via `storage.onChanged`.

The quality feature drives YouTube's own Settings-menu UI (the old `setPlaybackQuality()` API is silently ignored now), waiting for menus to render instead of guessing delays. While the automation runs, the menu UI is hidden with a temporary CSS class so the settings panel never visibly pops open in a corner; synthetic clicks work on hidden elements just fine, and afterward the gear's `aria-expanded` state is verified so the menu is always left fully closed. Rows are matched by their language-independent resolution pattern; Premium-locked options are skipped; and when the preferred resolution isn't selectable, the closest lower non-Premium tier is picked by comparing the numeric resolutions parsed off the rows - it never falls back to Auto. With "Avoid Premium qualities" enabled (default), rows whose label contains the (untranslated) brand term "Premium" are treated as unavailable, so the Premium upsell dialog is never triggered; if no free tier exists at or below the preferred resolution, the automation leaves the video on Auto instead of clicking anything. The automation is skipped entirely when the player is off-screen.

The default volume level is applied once per video through a capture-phase `play` listener (the main `<video>` on the watch page, each new `<video>` on Shorts), writing through the player's `setVolume()` API and the raw element in parallel so the slider and the audible level agree. There is deliberately no continuous enforcement: after the video starts, the volume belongs to the user. Toggling the feature or moving the slider while a video is loaded applies the new level immediately.

Block volume scroll intercepts `wheel` events in the capture phase whenever the target is inside the player's volume control (`.ytp-volume-area` / `.ytp-volume-panel` / `.ytp-volume-control`) and swallows them, so scrolling there can never change the volume while the option is on.

Mute hover previews keeps any `<video>` inside YouTube's hover-preview containers (`ytd-video-preview` and related selectors) muted, re-checked on a short interval because the preview element appears and disappears with the hover.

The Shorts loop fix strips the `loop` attribute from `<video>` elements and blocks the `.loop` JS property. It watches for the attribute being re-added via a `MutationObserver` (`attributeFilter: ["loop"]`), plus a short interval sweep as a backstop.

Auto-expand reads `ytd-watch-flexy`'s `theater` attribute - a plain boolean flag YouTube sets internally regardless of interface language - with the size button's (translated) tooltip text only as a last-resort fallback.

Settings changes are scoped: adjusting one feature only re-applies that feature, instead of re-running every feature on every single change.

Captions control uses the player API (`isSubtitlesOn`/`toggleSubtitlesOn`) first, then verifies against the visible CC button's `aria-pressed` state and clicks it if the two disagree.

Hiding info cards and end screens is a plain CSS switch - a class on `<html>` that a handful of `display: none` rules key off - which works on the watch page and inside embedded players alike.

The mini player never resets or reloads the `<video>` element - its playback state is completely undisturbed. While floating, the player is reparented into a plain wrapper `<div>` appended to `<body>`; all positioning/sizing (position:fixed, corner, transform: scale()) happens on the wrapper, never on the player itself (earlier attempts that styled the player directly made YouTube's own code re-layout or panic). The wrapper is sized to the player's natural on-screen box and keeps that 16:9 shape, scaled to the width chosen in the popup, for the entire video. A sibling spacer holds the original layout spot and marks where to move the player back.

No translations fetches each video's canonical metadata and rewrites the visible translated text:

- **Titles** come primarily from YouTube's oEmbed endpoint - a public, locale-free API that always returns the video's canonical original title. (The InnerTube `/player` endpoint, when called without an explicit language, may honor the browser's Accept-Language header and return an auto-translated title for videos YouTube translates - which is why some feed titles stayed translated before.) InnerTube still supplies descriptions and chapters; the watch page (`og:title`) is the last-resort fallback, and failed lookups are retried instead of being cached.
- **Titles are restored** on the watch page (including tab title and tooltips), in feed/search cards keyed off `#video-title` (including Shorts and notifications), and on the `.ytp-title-link` overlay shown on embedded players - with the video ID taken from each card's own link.
- **Descriptions:** the watch-page description (plain-text substitution - clickable timestamps/links within it are lost, a known trade-off) and feed/search snippets. Snippets use the technique proven by the open-source "YouTube No Translation" extension: the translated text lives in `.metadata-snippet-text`, an element YouTube's framework re-renders constantly, so it is hidden with CSS and the original - first two lines, capped at 100 characters - is rendered via `::after { content: attr(data-original-description) }` on the snippet container, which YouTube does not rewrite.
- **Chapters:** original list from the canonical player response (seekbar markers / chapters panel) or timestamp lines in the original description; the control-bar chip, the seekbar hover pill and the chapters panel rows are rewritten by matching timestamps and re-applied on a short interval so YouTube's re-renders never win.
- Results are cached per video ID; failed lookups are not cached. YouTube UI chrome strings (view counts, buttons, hints) follow the interface language and are intentionally left untouched - this feature restores creator content only.

Preventing accidental Shorts scrolling intercepts the `wheel` event in the capture phase and accumulates the scroll delta (normalized for mice vs trackpads); only once a deliberate threshold is crossed (roughly 2 mouse wheel notches or a firm trackpad swipe) is the event allowed through to YouTube, and a short cooldown stops momentum from switching several Shorts in a row. Changing scroll direction resets the accumulator. The guard covers the whole Shorts stage (`ytd-shorts`, `#shorts-container`, `#page-container`, reel renderers, player container) so it keeps working after every switch, while side areas (comments, panels, guide, header, shelves) are exempted first and always scroll normally. `{ passive: false }` is required for `preventDefault()` to work.

## Folder contents

```
manifest.json         Extension manifest (Manifest V2, Firefox-targeted)
background.js         Sets default settings on install
content.js            Core logic, injected into youtube.com pages
content.css           Styles for the mini player and menu hiding
popup.html/.js/.css   Toolbar popup with all settings, "Reset to defaults"
                      and "Report a bug"
icons/                Extension icons
LICENSE               MIT license text
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. The no-translation approach was modeled on the open-source "YouTube No Translation" extension (github.com/YouG-o/YouTube-No-Translation, AGPL-3.0).