# Kinly

A lean media center for Linux and Windows: movies and TV series, an integrated
mpv player, automatic subtitle selection and synchronisation, and careful Arabic
subtitle typography. The interface is in English; subtitles can be in any
supported language, with Arabic first and English second by default.

Kinly does not host or provide any content. It plays your local files and the
direct HTTP streams returned by Stremio-protocol addons that **you** install.

Supported platforms: Windows 10/11 x64 and Linux x86-64. Android, Android TV and
webOS are not supported; [docs/PLATFORM_ARCHITECTURE.md](docs/PLATFORM_ARCHITECTURE.md)
describes what they would take.

> **Kinly 1.1.0:** Trakt integration is temporarily unavailable in Kinly 1.1.0 due to temporary technical issues. It has not been permanently discontinued and is planned to return in a future update.

## Install

Download Kinly from the repository's
[Releases](https://github.com/slvjtr1/kinly/releases) page: the latest release is
**1.1.0**. Each release has four installers (`.exe`, `.msi`, `.deb`, `.AppImage`);
GitHub shows the SHA-256 digest next to each file, which you can compare with
`Get-FileHash <file>` (Windows) or `sha256sum <file>` (Linux). The examples below use
the 1.1.0 file names.

**Windows 10/11 (x64):** run `Kinly_1.1.0_x64-setup.exe` (installs for the
current user) or use the `.msi`. The installer includes the video engine, FFmpeg
and yt-dlp, and installs Microsoft's WebView2 runtime if it is missing. The
installer is not code-signed yet, so Windows SmartScreen may ask you to confirm.
Microsoft Defender has flagged earlier unsigned builds of `kinly.exe` with a generic
machine-learning detection; do not turn off your antivirus for Kinly. See
[docs/WINDOWS_SECURITY_AND_STABILITY.md](docs/WINDOWS_SECURITY_AND_STABILITY.md).

**Ubuntu 24.04 / Linux Mint 22 and similar (DEB, recommended):**

```bash
sudo apt install ./Kinly_1.1.0_amd64.deb
```

apt pulls in `libmpv2`, `ffmpeg`, WebKitGTK and the GL libraries. Kinly then
appears in the menu under *Sound & Video* and as an "Open with" choice for video files.
Remove with `sudo apt remove kinly`.

**AppImage (portable, no installation):**

```bash
chmod +x Kinly_1.1.0_amd64.AppImage
./Kinly_1.1.0_amd64.AppImage
```

The AppImage bundles libmpv, FFmpeg's libraries, WebKitGTK and GTK. It needs
FUSE 2 (`libfuse2t64` on Ubuntu 24.04 / Mint 22) — or run it with
`--appimage-extract-and-run`. Auto Sync uses the system `ffmpeg` command if it
is installed (`sudo apt install ffmpeg`); without it, everything else works and
Settings → About says so.

## Using Kinly

- **Home** shows Continue watching and catalog rows from your addons.
- **Movies / Series** browse catalogs by genre. **Search** (Ctrl+K or /) queries every searchable
  catalog and shows the results in rows. Recent searches are kept on this computer (per profile,
  at most 20, no duplicates): click one to search again, remove single entries, or *Clear search
  history* (with confirmation). They are separate from watch history and downloads.
- **A title page** shows the details, IMDb rating, trailer and episodes. **Play** (or clicking an
  episode) opens the source list: every stream your addons return, best first, with
  filters for 4K / 1080p / 720p / SD and badges for the source (BluRay REMUX, WEB-DL…),
  codec (HEVC x265, AV1, x264), HDR (Dolby Vision, HDR10+, HDR) and audio (Atmos, TrueHD,
  DTS, DD+, 7.1/5.1). Torrent-only results are shown as unsupported (Kinly has no torrent
  engine; use an addon with a debrid service).
- **Best match for this device**: Kinly reads what your GPU can decode and how
  much the computer can handle, and puts the best stream it will play smoothly at
  the top. Sources above the quality limit (Settings → Playback → Quality limit:
  Auto, 4K, 1440p, 1080p or 720p), or high-resolution sources in a codec the GPU
  cannot decode (for example 10-bit HEVC or AV1 at 4K), are listed after the others
  with a "May stutter on this device" badge.
- **Skip intro / recap / credits**: when IntroDB has timestamps for a title, the
  player shows a *Skip intro*, *Skip recap* or *Next episode* button at the right
  moment. Settings → Playback can skip intros and recaps automatically and choose
  what happens when the credits start.
- **More like this**: with a TMDB key (Settings → Connections), title pages show
  recommendations with their IMDb ratings.
- **Local files**: add folders or open a single file. Subtitle files next to a video
  (`Movie.ar.srt`, `Movie.eng.srt`, `Subs/…`) are found automatically.
- **Downloads**: a title's *Download* button saves a source in Kinly (or hands the link to
  your browser or download manager, if you choose *Outside Kinly*). The Downloads page lists
  what Kinly downloaded with title, episode, size, status and location; filter by name, sort by date, title,
  size or status, play, or delete a file (with confirmation). Kinly only deletes files it
  downloaded itself, never one that is still downloading or playing. Files that were moved
  or deleted outside Kinly show as *Missing*; interrupted downloads can be dismissed.
- **Download folder**: Settings → Library. The default is your Videos folder; Kinly checks
  that a folder you pick is writable. Changing it applies to new downloads; existing ones
  stay where they are and keep working.
- **Library** keeps your watchlist and history (mark watched / unwatched, remove, clear).
- **Themes**: Kinly (default), Dusk, Ocean, Crimson, OLED (true black) and Daylight,
  in Settings → Appearance.
- **Keyboard and remote navigation**: arrow keys move between cards, rows, buttons and
  menus; Enter opens; Esc (or a remote's Back key) leaves a text field, closes a dialog
  or goes back, returning to the card you came from. Settings → Appearance → **TV mode**
  makes focus highlights and controls larger for viewing from a distance.
- **Profile pictures**: 36 built-in illustrated avatars (DiceBear "Adventurer" and
  "Lorelei" by Lisa Wischofsky), or a picture link.

### Addons

Cinemeta (metadata and catalogs) and OpenSubtitles v3 (subtitles) are installed by
default. Open **Addons** (puzzle icon, top right, or Settings → Addons) to add others by pasting a manifest
URL (`https://…/manifest.json` or `stremio://…`), reorder or remove them. Removing
Cinemeta asks for confirmation, since Home, Movies, Series and Search depend on it; it
can be reinstalled from the same page.

### Accounts and profiles (optional)

Kinly works fully offline as a guest. Signing in to a free Kinly account adds up
to six profiles, each with its own library and addons, synced between your
computers; settings sync for the whole account. Profiles can have a PIN (a
household lock, not account security). Settings → Account can delete the cloud
data or the whole account. Details, including exactly what is stored where:
[ACCOUNTS.md](ACCOUNTS.md).

Trakt integration is temporarily unavailable in Kinly 1.1.0 due to temporary technical issues. It has not been permanently discontinued and is planned to return in a future update.
Existing Trakt connections stay saved on your computer and are not contacted. Details:
[docs/TRAKT_TEMPORARILY_DISABLED.md](docs/TRAKT_TEMPORARILY_DISABLED.md).

### TMDB (optional)

Settings → Connections → TMDB: paste your own free API key or API Read Access Token
from themoviedb.org. It is checked with TMDB, stored only on this computer and sent
only to `api.themoviedb.org`.

### Subtitles

- **Auto Select** picks the best subtitle when playback starts: your language order
  first, then the right episode/year, the release name, and the source. The downloaded
  text is checked — a file labelled Arabic that is really Persian or Hebrew is skipped and
  shown under its real language. Choosing a subtitle yourself always wins.
- **Auto Sync** aligns downloaded and external subtitles to the dialogue, including
  25/24 fps drift, using a few short audio windows analysed on your computer (nothing is
  uploaded). For streams it downloads at most ~300 MB automatically; very high-bitrate
  streams need the **Sync to dialogue** button (up to ~1 GB) or manual timing.
- **Manual timing**: Z / X (or −/+ in the subtitle panel) moves subtitles by 0.1 s; *Reset* clears it.
- **Style**: Settings → Subtitles (font, bold, size, colour and opacity, outline, shadow,
  background box, position). Size, bold and the box can also be changed in the player's subtitle panel.
  Bundled fonts: Noto Naskh Arabic, Noto Sans Arabic, Noto Kufi Arabic, Noto Sans.

### Keyboard

| Key | Action |
| --- | --- |
| Space / K | Play / pause |
| ← / → (Shift: 60 s) | Seek |
| ↑ / ↓ | Volume |
| M | Mute |
| F / double-click | Fullscreen |
| S, A | Subtitle panel, audio panel |
| Z / X | Subtitle delay −/+ 0.1 s |
| N | Next episode |
| Esc | Close panel → leave fullscreen → back |

Outside the player: arrow keys move focus, Enter activates, Esc / Back goes back,
Ctrl+K or / opens Search, F11 toggles fullscreen.

## Privacy

Kinly has no telemetry and no ads. It only contacts:

| Service | When | What it receives |
| --- | --- | --- |
| The addons you install (by default Cinemeta, `v3-cinemeta.strem.io`, and OpenSubtitles v3, `opensubtitles-v3.strem.io`) | Browsing, searching, opening a title, playing | The title, episode and catalog requests the Stremio protocol defines; for subtitles, the release name and file size |
| The artwork, subtitle and stream URLs those addons return | Showing artwork, loading subtitles, playing, downloading in Kinly | Ordinary HTTP requests to whichever server the addon points at |
| IntroDB (`api.theintrodb.org`) | Playing a movie or episode | The title's TMDB/IMDb id, season and episode, and the video's duration |
| TMDB (`api.themoviedb.org`, `image.tmdb.org`) | Only after you add your own TMDB key | Title ids, for recommendations and artwork |
| Kinly's account service (Supabase) | Only when you sign in | Your email and password (to sign in), profiles, each profile's library (movies and series: watchlist, progress, history) and addon list, and the synced settings. Local files, their paths and thumbnails are never uploaded |
| Trakt (`api.trakt.tv`), and Kinly's Trakt sign-in relay on the account service | Never in 1.1.0 (Trakt is temporarily unavailable). When it returns: only after you connect Trakt for a profile | The sign-in code exchange (through the relay, which stores nothing), then your watchlist and history import and what you play (scrobbling), directly with Trakt |
| YouTube (`youtube.com`, `youtube-nocookie.com`) | Playing a trailer | The trailer's video id |
| GitHub (`github.com/yt-dlp`) | Playing a trailer, only when no working yt-dlp is available (none bundled or installed, or it fails because YouTube changed) | A download of the latest yt-dlp and its checksum list |
| Microsoft | Windows installer, only if WebView2 is missing | The WebView2 runtime download |

Addon URLs, TMDB keys and Trakt tokens are stored only on your computer (addon
URLs are also synced to your account when you are signed in, because they are
part of a profile). Logs redact tokens, keys and URLs.

## Where data lives

| | Linux | Windows |
| --- | --- | --- |
| Settings, library, addons, account session, connections | `~/.config/app.kinly.desktop/` (owner-only) | `%APPDATA%\app.kinly.desktop\` |
| Logs | `~/.local/share/app.kinly.desktop/logs/kinly.log` | `%LOCALAPPDATA%\app.kinly.desktop\logs\kinly.log` |
| Subtitle cache, thumbnails | `~/.cache/app.kinly.desktop/` | `%LOCALAPPDATA%\app.kinly.desktop\` |
| List of Kinly's downloads (`downloads.json`) | `~/.local/share/app.kinly.desktop/` | `%APPDATA%\app.kinly.desktop\` |
| Downloaded videos (default) | Videos folder (`xdg-user-dir VIDEOS`, else `~/Videos`) | Videos folder |

If a saved file is damaged, Kinly moves it aside as `<name>.corrupt-<time>.json`
(it is never deleted) and starts with defaults.

## Troubleshooting

- **"The video engine could not start"** (Linux) — check `libmpv2` is installed
  (`apt policy libmpv2`) and look in the log file above.
- **Black video on Wayland/NVIDIA** — Kinly applies the known WebKitGTK workarounds;
  try an X11 session and report the log.
- **Auto Sync says "Not enough dialogue"** — the analysed parts had little speech or the
  subtitle belongs to a different cut. Use Z / X.
- **A stream fails** — choose another source; the addon or server may be offline.

## Build from source

See [docs/BUILDING.md](docs/BUILDING.md) for Linux and Windows requirements,
release builds and the Supabase backend. In short, on Ubuntu 24.04 / Mint 22:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev build-essential pkg-config libmpv-dev ffmpeg
npm install
npm run dev                 # development (Vite + Tauri)
npm test                    # UI and database unit tests
bash scripts/cargo.sh test  # Rust unit tests
bash scripts/release.sh     # tests + DEB + AppImage into release/<version>/
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together.

## Credits and licenses

Kinly's source code is MIT licensed (`LICENSE`). It adapts code from three files of
[Compass](https://github.com/compassstremio/Compass) (MIT), bundles the Noto and
Inter fonts (SIL OFL 1.1), and ships avatars by Lisa Wischofsky made with
[DiceBear](https://www.dicebear.com): "Adventurer" (CC BY 4.0) and "Lorelei" (CC0 1.0).
The video engine, libmpv, is GPL-2.0-or-later in the builds Kinly uses, so the Windows
installer and the AppImage, which include it, are distributed under the GPL's terms.
The corresponding source for those GPL/LGPL binaries is published with each release as
the companion release `sources-<tag>`, linked from the release notes. See
`THIRD_PARTY_NOTICES.md` and `licenses/`.
