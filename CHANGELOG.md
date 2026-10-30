# Changelog

## 1.0.0 — 2026-10-30

First stable release, for Linux (DEB, AppImage) and Windows x64 (installer, MSI).

### Watching
- Home with Continue watching and catalog rows, Movies and Series browsing by
  catalog and genre, Search across every searchable catalog, and title pages with
  episodes, IMDb ratings and "More like this" (with your own TMDB key).
- Integrated mpv player with hardware decoding, resume, autoplay of the next
  episode, and Skip intro / recap / credits from IntroDB timestamps.
- Sources sheet with every stream your addons return, ranked for what this device
  plays smoothly, with quality filters and badges for source, codec, HDR and audio.
  Quality limit setting (Auto, 4K, 1440p, 1080p, 720p).
- RTX Video Super Resolution on Windows with an NVIDIA RTX GPU.
- Trailers in the built-in player (yt-dlp, downloaded and kept up to date with
  checksum verification), with a YouTube embed as a fallback.
- Local files: folder scanning, single-file open and "Open with" from the file
  manager, frame thumbnails in Continue watching.

### Subtitles
- Auto Select: picks the best subtitle by your language order, episode/year,
  release name and source, and checks the downloaded text's real language.
- Auto Sync: aligns subtitles to the dialogue, including 25/24 fps drift, using
  audio analysed on your computer.
- Arabic typography: bundled Noto Arabic fonts, complex shaping, correct
  right-to-left punctuation, Windows-1256 decoding.
- Styling (font, size, colour, outline, shadow, box, position) with quick
  controls in the player, and manual timing.

### Accounts and sync (optional)
- Kinly works fully offline as a guest. A Kinly account adds up to six profiles,
  each with its own library and addons, synced between computers; settings sync
  for the whole account. Local files never leave the computer.
- Optional profile PINs, with "Forgot PIN?" after confirming the account password.
- Trakt: connect per profile with a code, import watchlist and history, scrobble.
- Delete cloud data, or delete the account itself, from Settings → Account.

### Interface
- Six themes (Kinly, Dusk, Ocean, Crimson, OLED, Daylight), interface scaling,
  reduced motion, keyboard shortcuts, Inter typeface.
- Addons page: install by manifest URL, reorder, remove; Cinemeta and
  OpenSubtitles v3 installed by default.

### Privacy and reliability
- No telemetry. Settings and library are stored locally as JSON, written
  atomically, owner-only on Linux; a damaged file is set aside, never deleted.
  Pending changes are saved when the window closes.
