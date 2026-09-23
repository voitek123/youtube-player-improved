# Youtube Player Improved (Firefox Addon)

**Version 1.3.17**

A Firefox extension for YouTube with eleven features, all controlled from a single toolbar popup:

- **Preferred quality** – forces a chosen video quality (144p–4K or Auto) on every video, including embedded YouTube players on other sites. The "Skip Premium quality options" toggle controls how Premium is handled: **checked** (default) skips Premium-only rows (closest lower free tier is picked, never Auto) and hides any Premium upsell dialog invisibly; **unchecked** makes the addon prefer Premium quality rows, assuming you have a Premium membership (it never verifies it) and leaves upsell dialogs alone. The automation runs at most twice per video (keyed by video ID, so duplicate navigation events can't re-trigger it), only after the player has real video data, and always closes its menu again - so no relaunches and no visible settings panel.
- **Default volume level** – sets the volume when a video actually starts playing (and once per new Short), but ONLY on /watch, /shorts and /embed pages - never on feed/home/search/channel pages, so it can never touch or unmute hover previews. It opens a ~3.5-second protection window with scheduled re-asserts to beat YouTube's delayed volume restore; after the window the volume is fully under your control.
- **Block volume scroll** – scrolling the mouse wheel over the player's volume control no longer changes the volume.
- **Mute hover previews** – videos that start playing when you hover a thumbnail stay muted. The addon never touches the preview's video element; instead it waits until the preview actually starts playing, then clicks YouTube's own corner mute button once (targeted precisely by volume/mute keywords), with a single 300 ms verify-and-correct pass - so previews start smoothly (no restarts) and stay silent. On by default.
- **Prevent Shorts from looping** – pauses a Short on its last frame instead of looping forever. Off by default.
- **Auto-expand player** – automatically switches videos into theater (large) mode.
- **Captions & subtitles control** – keeps captions always off (or always on), overriding YouTube's auto-detected preference so they don't switch themselves on when a video loads. Only acts on watch/Shorts/embed pages and at most once per 8 seconds, so the control bar can't flicker and pooled preview players are never touched.
- **Mini player** – when you scroll down past the video (to read comments, for example), it smoothly detaches into a small floating window - size (320x180 up to 1280x720) and corner both configurable - and keeps playing without interruption. The window keeps the player's standard 16:9 shape at the chosen width and stays that size for the whole video. Scrolling back up, or clicking the close button, returns it to its normal place.
- **Hide info cards & end screens** – automatically removes the "i" info card teasers shown during playback and the suggested-video overlay grid at the end of videos. Also works inside embedded players.
- **No translations** – keeps titles, descriptions and chapters in their original language instead of YouTube's automatic translation, on every YouTube subpage: the watch-page title, tab title and tooltips; feed, search, channel and playlist titles (including channel shelves, "For you" rows, the home Shorts shelf, channel Shorts tabs and the new lockup/view-model layouts); the Shorts watch-page title; notifications; the watch-page description and feed/search description snippets; chapter names (control-bar chip, seekbar hover pill, chapters panel); and the title overlay shown on embedded players. Title restoration reads the original title directly from the player API when available (fastest, no network races), writes strictly to the inner formatted-string node (never the heading container), and actively removes the `is-empty` attribute that YouTube uses to hide titles during re-renders. YouTube UI chrome (view counts, buttons, hints) follows the interface language and is intentionally left untouched.
- **Prevent accidental Shorts scrolling** – requires a deliberate scroll (crossing a threshold) to switch Shorts, so accidental 1-notch mouse wheel bumps or light trackpad swipes never switch the video, while the comments column, left menu, header and panels keep their normal scrolling. After a deliberate switch, scrolling is left fully native so the Shorts reel finishes its snap and the page (including the comments panel) always updates to the current Short.

Everything is toggleable individually from the toolbar popup, which also has a "Reset to defaults" button and a "Report a bug" button that opens the project's GitHub issues page (https://github.com/voitek123/youtube-player-improved/issues).

## Install temporarily (for testing)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click *Load Temporary Add-on…*.
3. Select the `manifest.json` file inside this folder.
4. The extension icon appears in the toolbar. Open any YouTube video to see it in action.

Note: temporary add-ons are removed when Firefox restarts and never update on their own — after replacing any file, remove the add-on and load it again (or click "Reload") at the same page. `content.js` logs a build tag to the Web Console on load (Ctrl+Shift+K on a YouTube tab, then reload), so you can verify the file you replaced is the one running.

## Performance

The addon is built to be near-invisible to the page. There are no always-on subtree-scanning MutationObservers and no polling loops except small feature-gated intervals: the Premium-upsell suppressor uses a cheap "is the added node itself a dialog" check plus a 2 s sweep; the Shorts-loop fix uses a 500 ms sweep only while on Shorts with the toggle on; hover-preview muting is a single cheap observer that only reacts to added preview nodes; and the translation scanner is gated by its own toggle and debounced. Background cadence is a 10 s heartbeat where every sub-feature self-gates. With toggles off the addon is essentially idle; with toggles on, all work is interval- or event-bounded, so YouTube stays as smooth as stock.

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

The quality feature drives YouTube's own Settings-menu UI only - the old `setPlaybackQuality()` JS API is silently ignored for most viewers, and calling it with a tier above the free maximum popped the Premium upsell, so it was removed. The automation is keyed by VIDEO ID and capped at two attempts per video, so duplicate navigation events can no longer make it re-click quality rows (which reloaded the stream and looked like relaunches). It only runs once the `<video>` element actually has media data (`readyState >= 1`); player states like "buffering"/"cued" are not trusted, and any ad state counts as "not ready" - so the addon never touches the player during ad-blocker stalls. Before opening the menu, any existing menu containers are hidden; while driving, the exact menu root is hidden inline; and the menu is closed by detecting visible menu containers directly (not only via `aria-expanded`), so nothing is left open on screen. The "Skip Premium quality options" toggle controls Premium handling: when checked (default), rows whose label contains the (untranslated) brand term "Premium" are skipped, the closest lower free tier is picked, and any upsell dialog is hidden invisibly; when unchecked, Premium rows are treated as selectable and preferred (for members), and dialogs are left alone - the addon never verifies membership. If no suitable tier exists at or below the preferred resolution, the automation leaves the video on Auto instead of clicking anything. The automation is skipped entirely when the player is off-screen.

The default volume level is applied through capture-phase listeners, anchoring the real enforcement to the `playing` event (which fires when media actually starts, safely bypassing ad-blocker stalls). It is gated to /watch, /shorts and /embed pages only, so on feed/home/search/channel pages it does nothing at all and can never reach hover previews; even on allowed pages, videos inside hover-preview containers are explicitly excluded and the real content video is matched by explicit player IDs first. For ~3.5 seconds after start, scheduled re-asserts at +0.2s, +1s, +2s, and +3s overwrite the volume to beat YouTube's delayed state restore; a `volumechange` listener also re-asserts during the window. After the window there is deliberately no enforcement and the volume belongs to the user. Toggling the feature or moving the slider while a video is loaded applies the new level immediately.

Block volume scroll intercepts `wheel` events in the capture phase whenever the target is inside the player's volume control (`.ytp-volume-area` / `.ytp-volume-panel` / `.ytp-volume-control`) and swallows them, so scrolling there can never change the volume while the option is on.

Mute hover previews never writes `video.muted` / `video.volume` on previews. When a hover-preview node appears, the addon waits for the preview's `<video>` to fire `playing` (real playback; 1200 ms fallback), then clicks YouTube's own corner mute button ONCE - targeted precisely by volume/mute/sound keywords in its aria-label/class, with the old "first non-CC/close button" only as fallback - and runs a single 300 ms verify-and-correct pass. Clicking only at playback start avoids the premature control clicks that made YouTube re-init (restart) the preview. Each preview instance is processed at most once (WeakSet), so it can never oscillate.

The Shorts loop fix strips the `loop` attribute and blocks the `.loop` JS property via a 500 ms sweep that runs only while on Shorts with the toggle on (no whole-document observer), so it costs nothing elsewhere.

Auto-expand reads `ytd-watch-flexy`'s `theater` attribute - a plain boolean flag YouTube sets internally regardless of interface language - with the size button's (translated) tooltip text only as a last-resort fallback. It runs at most once per video.

Settings changes are scoped: adjusting one feature only re-applies that feature, instead of re-running every feature on every single change.

Captions control waits for a ready, ad-free player on watch/Shorts/embed pages only, then uses EITHER the player API (`isSubtitlesOn`/`toggleSubtitlesOn`) OR the visible CC button as a fallback when the API is missing - never both in the same pass - and at most one adjustment per 8 seconds, so the captions state can't oscillate and re-render (flicker) the control bar, and pooled preview players on the feed are never touched.

Hiding info cards and end screens is a plain CSS switch - a class on `<html>` that a handful of `display: none` rules key off - which works on the watch page and inside embedded players alike.

The mini player never resets or reloads the `<video>` element - its playback state is completely undisturbed. While floating, the player is reparented into a plain wrapper `<div>` appended to `<body>`; all positioning/sizing (position:fixed, corner, transform: scale()) happens on the wrapper, never on the player itself (earlier attempts that styled the player directly made YouTube's own code re-layout or panic). The wrapper is sized to the player's natural on-screen box and keeps that 16:9 shape, scaled to the width chosen in the popup, for the entire video. A sibling spacer holds the original layout spot and marks where to move the player back.

No translations fetches each video's canonical metadata and rewrites the visible translated text:

- **Titles** come primarily directly from the active player API (`getPlayerResponse().videoDetails.title`), which is instantaneous and natively untranslated. The oEmbed endpoint, InnerTube API, and watch page (`og:title`) serve as fallbacks if the player API isn't ready yet.
- **The watch-page title is restored strictly to its inner formatted-string node** (never the `<h1>` container, which breaks YouTube's rendering). Crucially, the addon actively removes the `is-empty` attribute that YouTube relies on to hide the title during re-renders, and attaches an observer to prevent YouTube from re-adding it. This prevents the "missing title on navigation, fixed by refresh" bug.
- **Titles are restored** in feed/search cards, channel shelves and "For you" rows (classic `#video-title`, `h3 > a > span[role='text']` and the newer `yt-lockup-view-model` / `ytd-rich-grid-media` layouts), the home Shorts shelf and channel Shorts tab cards (`.shortsLockupViewModelHostEndpoint`), the Shorts watch page (`yt-shorts-video-title-view-model`, ID from the URL), notifications, and the `.ytp-title-link` overlay on embedded players. Description snippets are scanned site-wide (`.metadata-snippet-text` / `#description-text`) and matched to their video via the nearest `/watch` or `/shorts` link.
- **Fetch throttling & sync caching:** each scan processes at most a small budget of fresh (uncached) titles so YouTube never rate-limits the addon; anything left over is retried by up to three targeted re-scans two seconds apart. Restored titles are kept in a synchronous cache so repeat scans skip already-correct nodes with zero async work, keeping large channel pages fast and fully restored.
- **Descriptions:** the watch-page description (plain-text substitution - clickable timestamps/links within it are lost, a known trade-off) and feed/search snippets. Snippets use the technique proven by the open-source "YouTube No Translation" extension: the translated text lives in `.metadata-snippet-text`, an element YouTube's framework re-renders constantly, so it is hidden with CSS and the original - first two lines, capped at 100 characters - is rendered via `::after { content: attr(data-original-description) }` on the snippet container, which YouTube does not rewrite.
- **Chapters:** original list from the canonical player response (seekbar markers / chapters panel) or timestamp lines in the original description; the control-bar chip, the seekbar hover pill and the chapters panel rows are rewritten by matching timestamps and re-applied on a 400 ms interval so YouTube's re-renders never win.
- Results are cached per video ID; failed lookups are not cached. YouTube UI chrome strings (view counts, buttons, hints) follow the interface language and are intentionally left untouched - this feature restores creator content only.

Preventing accidental Shorts scrolling intercepts the `wheel` event in the capture phase and accumulates the scroll delta (normalized for mice vs trackpads); only once a deliberate threshold is crossed (roughly 2 mouse wheel notches or a firm trackpad swipe) is the event allowed through to YouTube. During the short cooldown after a switch, the addon no longer swallows wheel events - it simply stops evaluating thresholds and lets the reel scroll natively, so YouTube always finishes its snap and keeps the video and the comments panel in sync (momentum may carry you one Short further, which is normal YouTube behavior). Changing scroll direction resets the accumulator. The guard covers the whole Shorts stage (`ytd-shorts`, `#shorts-container`, `#page-container`, reel renderers, player container) so it keeps working after every switch, while side areas (comments, panels, guide, header, shelves) are exempted first and always scroll normally. `{ passive: false }` is required for `preventDefault()` to work.

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