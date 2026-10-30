# Changelog

## 1.1.0 Beta — 2026-10-30

A pre-release for Windows x64 and Linux. Kinly 1.0.1 remains the stable release.

> **Trakt:** Trakt integration is temporarily unavailable in Kinly 1.1.0 Beta due to temporary technical issues. It has not been permanently discontinued and is planned to return in a future update.
> Saved Trakt connections stay on your computer, untouched, and Kinly makes no Trakt
> requests in this version.

### New
- Keyboard and remote navigation across the whole interface: arrow keys move between
  cards, rows, menus and buttons, Enter opens, Esc / Back closes dialogs and goes back
  to the card you came from. Dialogs keep focus inside until closed. New **TV mode**
  (Settings → Appearance) with larger focus highlights and controls.
- Search history: recent searches per profile, kept on this computer. Click one to
  search again, remove single entries, or clear the history (with confirmation).
- Downloads page lists everything downloaded in Kinly with title, episode, size,
  status and location. Filter, sort (newest, title, size, status), play, and delete
  with confirmation. Only files Kinly downloaded can be deleted, never while they
  are downloading or playing; moved or deleted files show as Missing; interrupted
  downloads are cleaned up and can be dismissed.
- Download folder setting (Settings → Library) with a folder picker; the folder is
  checked for write access. The default is now your Videos folder. Existing
  downloads keep working when the folder changes.
- New built-in profile pictures: 36 illustrated avatars (DiceBear "Adventurer" and
  "Lorelei" by Lisa Wischofsky). Profiles that used an old built-in picture get a
  new one automatically; picture links are unchanged.

### Changed
- Trakt is switched off for this release (see above).
- Trailers use the bundled or installed yt-dlp first and download a new copy only
  when none works.
- Windows: if the video engine (`libmpv-2.dll`) is missing or cannot be loaded,
  Kinly still opens and explains the problem when you play something, instead of
  failing to start.
- Releases carry only the four installers. The source for the bundled GPL/LGPL
  components is published as a companion release (`sources-<tag>`), linked below.
  GitHub shows each file's SHA-256 digest.
- Licences: DiceBear avatar credits and the CC BY 4.0 / CC0 texts added to the
  notices; Compass attribution described file by file.

### Known limitations
- Kinly is not code-signed. Microsoft Defender flagged earlier builds of
  `kinly.exe` with a generic machine-learning detection
  (`Trojan:Win32/Bearfoos.A!ml`); see `docs/WINDOWS_SECURITY_AND_STABILITY.md`.
- Remote navigation was tested with a keyboard; Kinly does not run on TVs yet.

## 1.0.1 — 2026-10-30

### Changed
- Search results are shown as one horizontal row per source, like Home, instead
  of a long grid; posters further along the row load as you scroll to them.
- Downloads now happen inside Kinly: the video is saved to your Downloads folder
  with progress, speed and Cancel on the Downloads page. "Outside Kinly" (in the
  download sheet or Settings → Library) keeps the old behaviour and opens the
  link in your browser and copies it, for an open-source download manager such
  as Prism.
- Subtitle outline has an on/off switch (Settings → Subtitles and the player's
  subtitle panel); its width is kept for when it is turned back on.

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
