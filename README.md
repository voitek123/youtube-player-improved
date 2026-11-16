# Youtube Player Improved (Firefox Addon)

**Version 1.3.23**

A Firefox extension for YouTube with ten features, all controlled from one toolbar popup:

- **Preferred quality** – forces a chosen quality (144p–4K or Auto) on every video, including embedded players. "Skip Premium quality options" (checked by default) skips Premium-only rows and hides the upsell popup invisibly; unchecked prefers Premium rows. 3 attempts + an extra ~6 s check; closes stray menus and still sets quality in the same pass.
- **Default volume** – sets your volume when a video/Short starts AND on every video/page change, guarded ~5 s so the previous video's manual volume can't carry over. Only on /watch, /shorts, /embed.
- **Block volume scroll** – the wheel over the player's volume control no longer changes volume.
- **Mute hover previews** – only genuine preview boxes are touched; never the real player, never on Shorts pages.
- **Prevent Shorts looping** – pauses a Short on its last frame. Off by default.
- **Auto-expand player** – switches videos into theater mode.
- **Captions control** – keeps captions always off/on; only on watch/Shorts/embed, at most once per 8 s.
- **Mini player** – scrolling past the video floats it into a resizable corner window that keeps playing; scroll back or press ✕ to restore.
- **Hide info cards & end screens** – removes the "i" teasers and end-screen grid, also in embeds.
- **No translations** – restores original titles/descriptions/chapters across all YouTube pages. On Shorts, the main title is always matched to the video in the address bar (never to a sound/remix link inside the reel), so a wrong video's title can no longer be printed; the sound-name line is left untouched.
- **Prevent accidental Shorts scrolling** – a deliberate scroll performs one complete, clean switch and briefly ignores the wheel while it settles.

Everything is toggleable; the popup also has "Reset to defaults" and "Report a bug" (GitHub issues).

## Install temporarily (testing)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click *Load Temporary Add-on…* and pick `manifest.json`.
3. Open YouTube. After replacing files, reload the add-on; `content.js` logs its build tag to the Web Console so you can confirm the running version.

## Performance

No whole-document polling. Observers do a single cheap check per added node; the Premium sweep is a 2 s pass over the small popup area; heavy translation scans run once ~2.5 s after navigation (plus ~6 s), never from the heartbeat, and afterwards only on settled mutations with a fetch budget and cache. Background heartbeat is 10 s of cheap self-checks. With toggles off the addon is essentially idle.

## Folder contents

```
manifest.json  background.js  content.js  content.css
popup.html/.js/.css  icons/  LICENSE
```

## License

MIT – see LICENSE. No-translation approach modeled on "YouTube No Translation" (AGPL-3.0).