# Kinly architecture

Kinly is a Tauri 2 desktop app for Linux and Windows: a Rust backend that owns
playback, subtitles, synchronisation, storage and networking, and a React +
TypeScript UI. Video is drawn by libmpv *under* a transparent webview, so the UI
is a normal web page layered over the video. On Linux the webview is WebKitGTK
and mpv renders into a GTK `GLArea` (diagram below); on Windows the webview is
WebView2 and mpv's own d3d11 video output is embedded as a child window
(`docs/BUILDING.md`, *How video works on each OS*). Accounts, profiles and cloud
sync are optional and described in `ACCOUNTS.md`. Other platforms are planned, not
supported: see [PLATFORM_ARCHITECTURE.md](PLATFORM_ARCHITECTURE.md).

## Layers

Kinly 1.1 keeps the Tauri 2 + React/TypeScript + Rust stack. A review for this release
found no reason to change language or framework: the pure logic is already separated
from the platform code, it is unit tested, and a rewrite would put working playback,
subtitle and sync code at risk for no user-visible gain. The code is organised in four
layers:

| Layer | What it holds | Where |
| --- | --- | --- |
| **Shared core** | Platform-free logic with no I/O: stream ranking and release-name parsing, subtitle auto-select, settings sanitising and migration, library/profile merge rules, the view stack, search history and download list rules, spatial-navigation geometry. Unit tested in Node (`tests/`). In Rust: subtitle decoding and parsing, VAD and correlation (`sync/`), download naming and path rules. | `src/lib/*.ts` (pure modules), `src-tauri/src/subs`, `src-tauri/src/sync`, parts of `download.rs` and `paths.rs` |
| **Platform abstraction** | The boundary between UI and OS: typed wrappers around Tauri commands and events (the only direct `invoke` calls elsewhere are the launch-file handoff in `App.tsx` and `lib/trailers.ts`). | `src/lib/tauri.ts`, `src/lib/caps.ts`, the `#[tauri::command]` functions |
| **UI** | React views and components, themes, focus and remote navigation (`lib/spatialNav.ts`). Platform-neutral web code: it runs in WebView2 and WebKitGTK alike. | `src/views`, `src/components`, `src/styles` |
| **Platform implementations** | Video embedding (GTK `GLArea` on Linux, a d3d11 child window on Windows), file system, process spawning (ffmpeg, yt-dlp), downloads, logging, store files. | `src-tauri/src/player/render_linux.rs`, `render_windows.rs`, `local.rs`, `download.rs`, `store.rs`, `trailer.rs`, `logging.rs` |

A new platform would reuse the shared core and most of the UI, and replace the
platform implementations (see PLATFORM_ARCHITECTURE.md for what that means per platform).

Feature flags for functionality that is built but switched off live in
`src/lib/features.ts` (Trakt is off in 1.1.0 Beta; see
[TRAKT_TEMPORARILY_DISABLED.md](TRAKT_TEMPORARILY_DISABLED.md)).

```
┌──────────────────────── GTK window ────────────────────────┐
│  gtk::Overlay                                              │
│   ├─ GLArea  ← libmpv render API (OpenGL), video + libass  │
│   └─ WebKitGTK webview (transparent while playing)         │
│        React UI: views, player controls, settings          │
└────────────────────────────────────────────────────────────┘
          ▲ invoke() commands            │ events: player:prop / player:event
          │                              ▼
┌──────────────────────── Rust (src-tauri) ──────────────────┐
│ player/   mpv core, GLArea embed, property events          │
│ subs/     download, decode (UTF-8/CP1256/…), parse, check   │
│ sync/     audio windows → dialogue VAD → correlation solve │
│ net.rs    HTTP for addons (timeouts, size caps, no CORS)   │
│ store.rs  JSON documents, owner-only (atomic, recoverable) │
│ local.rs  folder scan · logging.rs  redacting log file     │
│ paths.rs  launch arguments, folder dedupe, sample filter   │
└────────────────────────────────────────────────────────────┘
```

## Decisions

| Decision | Why |
| --- | --- |
| New project with code adapted from three Compass (MIT) files, not a fork | Compass (~12k files) entangles music, games, torrents, casting, TV/Android in shared code. The adapted parts (Linux video embedding, VAD hysteresis, sync correlation) were cleanly separable; they are listed with their licence in `THIRD_PARTY_NOTICES.md` and marked in the source files. |
| Tauri 2 + system libmpv | The GLArea-under-webview embedding (adapted from Compass) is proven on Linux. libmpv gives broad codec/container support and libass subtitle rendering. No second playback engine. |
| Subtitles rendered by libass, not HTML | Correct HarfBuzz/FriBidi shaping for Arabic, embedded fonts, ASS support, and frame-accurate timing. |
| Direct HTTP streams only | No torrent engine (heavy, legally sensitive). `infoHash` results are listed as unsupported; debrid-configured addons return HTTP URLs. |
| Local JSON files; cloud sync optional | Small data volumes; atomic writes; corrupt files are moved aside, never deleted. Everything works offline as a guest. Signing in adds profiles synced through Supabase (PostgREST with row-level security, called from Rust's HTTP client; no SDK). |
| Network through Rust | Addons need not send CORS headers; timeouts and response-size caps are enforced in one place; URLs are redacted in logs. |

## Playback (`src-tauri/src/player`)

- One mpv core per session, created on first play. `vo=libmpv`, `hwdec=auto-safe`,
  `config=no` (user mpv configs do not leak in), network cache and reconnect options.
- `render_linux.rs` (adapted from Compass) moves the webview into a `gtk::Overlay`
  above a `GLArea`, builds the mpv OpenGL render context (X11 or Wayland display),
  restores GL state mpv does not restore, and applies WebKitGTK compositing
  workarounds for Wayland/NVIDIA.
- `LC_NUMERIC` is set to `C` before `mpv_create` (libmpv refuses a non-C numeric locale,
  which GTK sets on most desktops).
- Properties (`time-pos` throttled to 4 Hz, `track-list`, `sid`, `sub-delay`, …) are
  pushed to the UI as events. Commands use `mpv_command` with an argv array.
- The video surface is only visible while something plays: `player_stop` makes the
  webview opaque again and clears the `GLArea`, and `player_load` reverses that. Without
  this, WebKit's transparent tiles let the last video frame flash through while
  scrolling after leaving the player. A load counter keeps a late stop (autoplay next)
  from hiding the next video.

## Subtitles

**Preparation** (`subs/`): fetch once (cached by URL hash, bounded cache), decode
(BOM → UTF-8 → `chardetng`, which handles Windows-1256), detect SRT/WebVTT/ASS,
parse cue times, and analyse the text: dominant script and, for Arabic script,
Arabic vs Persian vs Urdu by distinctive letters; share of SDH-style lines.

**Auto Select** (`src/lib/subs/autoselect.ts`, pure and unit-tested):
candidates from embedded tracks, files next to a local video, and subtitle
addons (OpenSubtitles v3 by default). Hard rejections: language not wanted,
wrong season/episode, different title year. Score: language rank (dominant;
bigger than all soft bonuses together), source (embedded > sidecar > online),
release-name similarity, image-codec / forced / CD-part / SDH penalties, addon
order. A language chosen manually for a title moves to the front next time.
The top candidate is downloaded and its text checked against its label; a
contradiction (e.g. Hebrew or Persian labelled Arabic) relabels it and the next
candidate is tried (at most four). Manual choices end auto selection for the session.

**Auto Sync** (`src-tauri/src/sync`):

1. *Windows*: media < 15 min → one window; longer → three, one per third. Each is
   placed where the subtitle has the most dialogue (avoids credits). Local: 300 s.
   Remote: sized from bitrate so the estimated download stays under 300 MB
   (automatic) or 1 GB ("Sync to dialogue"); otherwise it declines.
2. *Audio*: ffmpeg seeks (`-ss` before `-i`, HTTP range requests for streams) and
   decodes only the window, stereo 16 kHz, 200–3400 Hz.
3. *Dialogue detection*: WebRTC VAD on the mid (L+R) signal, gated by mid/side
   energy ratio > 3 (dialogue is centre-mixed; music/effects are wide). Surround
   sources reach this through ffmpeg's standard downmix.
4. *Solve*: for each candidate ratio (1, 25/23.976, 25/24, 24/23.976 and inverses)
   cue times are rescaled and each window's offset found by FFT cross-correlation
   of 100 Hz masks (±90 s). Accept a single window only with peak z ≥ 3.8 and
   dominance ≥ 1.55; with several windows each needs z ≥ 3.0 / dominance ≥ 1.2 and
   two must agree within 0.3 s. Thresholds were calibrated on real audio;
   `cargo run --example synccheck` checks a video against a known-good subtitle.
5. *Apply*: `sub-speed = ratio`, `sub-delay = offset` (verified: mpv shows a cue at
   `t·speed + delay`). Nothing is rewritten on disk. Timing is remembered per
   subtitle, because these mpv properties are global.

Embedded subtitle tracks are not synced (they are muxed with the video).

**Arabic rendering**: libass with `sub-ass-shaper=complex`, bundled static Noto
Arabic fonts via `sub-fonts-dir`, and `sub-ass-style-overrides=Encoding=-1`,
which makes libass detect each line's base direction (its default left-to-right
base put trailing punctuation of Arabic lines on the wrong side).

## UI (`src/`)

React 19, no router or state library: an in-memory route stack (`state.tsx`),
module stores with `useSyncExternalStore` for addons, library, device caps and
credentials. Views: Home, Movies/Series (catalog + genre, infinite paging), Search
(all searchable catalogs), Detail (episodes; Play opens a sources sheet), Player,
Library, Downloads, Addons, Settings (sectioned: Appearance, Playback, Subtitles,
Languages, Library, Addons, Connections, Account, About). Themes are CSS custom
properties on `[data-theme]`; the interface font is Inter (bundled).

- **Keyboard and remote navigation** (`lib/spatialNav.ts`): one window-level handler
  moves focus with the arrow keys / D-pad to the nearest focusable element in that
  direction (pure `pickNext` geometry, unit tested), activates with Enter/OK, and maps
  Back (Escape, GoBack, BrowserBack, webOS 461) to "leave the text field" then
  "previous view". Open dialogs (`aria-modal`, `role=dialog`, `data-nav-scope`) scope
  the movement; `trapDialogFocus` moves focus into a dialog and back out when it
  closes. `App.tsx` remembers the focused element per view and restores it on Back.
  Text fields, sliders and selects keep the arrows they need; `data-nav="native"` opts
  an element out. The player keeps its own keys. *TV mode* (Settings → Appearance) only
  enlarges focus rings and targets.
- **Search history** (`lib/searchHistory.ts`): the `searches` store, newest first, at
  most 20 per profile, case-insensitive de-duplication; remembered on Enter or when a
  result is opened. Local only, separate from the library.
- **Downloads** (`src-tauri/src/download.rs`, `views/Downloads.tsx`): Kinly-managed
  downloads are recorded in `downloads.json` (title, episode, size, state, path).
  Deleting removes only a file in that list, after confirmation, never one that is
  downloading or playing, and only a regular video file at an absolute path. The
  download folder is checked for write access before it is used and recorded per
  download, so changing it later does not break existing entries.
- **Streams** (`lib/streams.ts`): every result is kept and ranked in tiers: playable
  and smooth on this device → playable but may stutter → unplayable. "May stutter"
  means above the quality cap (the user's limit, or `SystemCaps.recommendedMaxHeight`
  for Auto) or a CPU decode above 1080p (codec without `hwdec` support, 10-bit HEVC
  without `hevc10`, HDR implies 10-bit, or above `maxHwHeight`). Within a tier:
  resolution, source (Remux > BluRay > WEB-DL > WEBRip > HDTV), size sanity, addon
  order; CAM releases sink.
- **Device caps** (`lib/caps.ts`): `systemCaps()` is called once at startup and
  cached; `rankCapsFor()` turns caps + settings into ranking input. If the call
  fails, ranking falls back to plain resolution order.
- **IntroDB** (`lib/segments.ts`, `views/Player.tsx`): once the duration is known
  the player asks `introdbSegments` (TMDB id from `tmdb:` meta ids, else the IMDb
  id; season/episode for series). Credits without an end run to the end of the
  file. Errors are ignored. Auto-skip happens in the time-pos listener, once per
  segment.
- **Rendering cost**: mpv's `time-pos` and cache position go to a small store
  outside React state, so only the seek bar, clock and skip button re-render. The
  app context value is memoised; Home rows and cards are memoised. CSS animates only
  `transform` and `opacity`, uses no `backdrop-filter`, and long rows/grids use
  `content-visibility: auto`. `prefers-reduced-motion` and the Reduce motion
  setting both disable animation. Release names are parsed into
  quality groups (4K/1080p/720p/SD) and tags (source, codec, HDR, audio) shown as badges.
- **TMDB** (`lib/tmdb.ts`): optional, user's own key from the `credentials` document
  (0600). `/find` maps the IMDb id, `/recommendations` (fallback `/similar`) gives
  "More like this"; each result's IMDb id comes from `/external_ids` and its IMDb rating
  from the metadata addon. v3 keys go in the query string, v4 tokens as a bearer header;
  the log redacts both.

## Storage

| Data | Linux | Windows |
| --- | --- | --- |
| `settings`, `library`, `addons`, `subprefs`, `credentials`, `account`, `trakt`, `profile`, `searches` (`.json`, owner-only on Linux) | `~/.config/app.kinly.desktop/` | `%APPDATA%\app.kinly.desktop\` |
| `downloads.json` (the Kinly-managed download list) | `~/.local/share/app.kinly.desktop/` | `%APPDATA%\app.kinly.desktop\` |
| Downloaded videos (default; Settings → Library changes it) | `$(xdg-user-dir VIDEOS)`, else `~/Videos` | the Videos known folder |
| Logs (`kinly.log`, rotated at 2 MB, URLs and tokens redacted) | `~/.local/share/app.kinly.desktop/logs/` | `%LOCALAPPDATA%\app.kinly.desktop\logs\` |
| Prepared subtitles, thumbnails | `~/.cache/app.kinly.desktop/` | `%LOCALAPPDATA%\app.kinly.desktop\` |
| Managed yt-dlp copy (trailers) | `~/.local/share/app.kinly.desktop/` | `%APPDATA%\app.kinly.desktop\` |

Pending library, settings and profile writes are debounced; closing the window
saves them first (`src/lib/shutdown.ts`, bounded to three seconds).

## Dependencies

Runtime: Linux — libmpv2 (0.37), WebKitGTK 4.1, GTK 3, ffmpeg (Auto Sync), from the
system or bundled in the AppImage. Windows — libmpv-2.dll, ffmpeg.exe and yt-dlp.exe
bundled by the installer, WebView2. Licensing: `THIRD_PARTY_NOTICES.md`.
Rust: tauri 2.12, libmpv2 4.1, gtk 0.18, reqwest (rustls), realfft, webrtc-vad,
encoding_rs, chardetng, walkdir. UI: react 19, lucide-react, DiceBear avatar art (generated at development time, bundled as SVG), @tauri-apps/api and
plugins (dialog, opener). Build: Vite 8, TypeScript 5.8, vitest 5.
