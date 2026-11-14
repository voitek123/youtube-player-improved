# Youtube Player Improved (Firefox Addon)

**Version 1.3.21**

A Firefox extension for YouTube with eleven features, all controlled from one toolbar popup:

- **Preferred quality** – forces a chosen quality (144p–4K or Auto) on every video, including embedded players. "Skip Premium quality options" (checked by default) skips Premium-only rows and hides the upsell popup invisibly; unchecked prefers Premium rows (assumes membership, never verifies). Runs at most twice per video, only once the player has real data, finds the settings menu even if YouTube moves it, and always closes it again.
- **Default volume** – sets your volume when a video/Short actually starts, only on /watch, /shorts and /embed (never on feeds). A ~3.5 s protection window beats YouTube's delayed volume restore; afterwards the volume is yours.
- **Block volume scroll** – the wheel over the player's volume control no longer changes volume.
- **Mute hover previews** – only genuine preview boxes are touched; never the real player (video/Shorts/channel/mini-player), never on Shorts pages, so your actual video can't be muted by accident.
- **Prevent Shorts looping** – pauses a Short on its last frame. Off by default.
- **Auto-expand player** – switches videos into theater mode.
- **Captions control** – keeps captions always off/on; only on watch/Shorts/embed, at most once per 8 s.
- **Mini player** – scrolling past the video floats it into a resizable corner window that keeps playing; scroll back or press ✕ to restore.
- **Hide info cards & end screens** – removes the "i" teasers and end-screen grid, also in embeds.
- **No translations** – restores original titles/descriptions/chapters across all YouTube pages; deferred, throttled and cached so it never slows the feed.
- **Prevent accidental Shorts scrolling** – a deliberate scroll performs one complete, clean switch (YouTube's own up/down button or a full-video scroll) and briefly ignores the wheel while it settles, so it never stops halfway and never chains accidental switches.
- **Hide the "video isn't playing smoothly?" toast** – the white box that sometimes appears at video start is hidden automatically, in any language.

Everything is toggleable; the popup also has "Reset to defaults" and "Report a bug" (GitHub issues).

## Install temporarily (testing)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click *Load Temporary Add-on…* and pick `manifest.json`.
3. Open YouTube. After replacing files, reload the add-on; `content.js` logs its build tag to the Web Console so you can confirm the running version.

## Performance

No whole-document polling. Observers do a single cheap check per added node; the Premium/toast sweep is a 2 s pass over the small popup area; heavy translation scans run once ~2.5 s after navigation (plus a ~6 s pass), never from the heartbeat, and afterwards only on settled mutations with a fetch budget and a cache. Background heartbeat is 10 s of cheap self-checks. With toggles off the addon is essentially idle.

## How it works (brief)

Settings live in `browser.storage.local` and sync live to the content script. Quality drives YouTube's own settings menu (player → popup container → document) and hides it while automating. Volume targets only the real content video by explicit player IDs. Preview muting clicks the preview's own corner mute button once, at playback start, with a single verify pass. Shorts scrolling performs a full switch via YouTube's navigation buttons (or a one-video scroll) and ignores the wheel during an ~0.8 s settle window. The smoothness toast and Premium dialogs are hidden by a cheap observer plus a scoped sweep. No-translations reads the canonical title from the player API (oEmbed/InnerTube/watch-page fallbacks), writes only the inner title node, removes `is-empty`, and caches results.

## Folder contents

```
manifest.json  background.js  content.js  content.css
popup.html/.js/.css  icons/  LICENSE
```

## License

MIT – see LICENSE. No-translation approach modeled on "YouTube No Translation" (AGPL-3.0).