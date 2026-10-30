# Platforms

| Platform | Status in 1.1.0 Beta |
| --- | --- |
| Windows 10/11 x64 | Supported (NSIS `.exe`, `.msi`) |
| Linux x86-64 (Ubuntu 24.04 / Mint 22 and similar) | Supported (`.deb`, `.AppImage`) |
| Android phones and tablets | **Not supported.** Not built, not tested. |
| Android TV / Google TV | **Not supported.** Not built, not tested. |
| LG webOS | **Not supported.** Not built, not tested. |

Kinly 1.1 makes the interface usable with arrow keys, Enter and Back (see "TV-ready UI"
below), which a TV version would need. That alone does not make Kinly run on a TV. This
document records what each platform would take, so the work can be planned; nothing here
is a promise or a date.

## How the code is split

See [ARCHITECTURE.md](ARCHITECTURE.md#layers). In short:

- **Shared core**: pure TypeScript in `src/lib` (stream ranking, subtitle auto-select,
  settings, library and profile rules, search history, download list rules, navigation
  geometry) and pure Rust (subtitle decoding/parsing, sync maths). Reusable anywhere the
  language runs.
- **Platform abstraction**: `src/lib/tauri.ts` and `src/lib/caps.ts`, typed calls that
  the UI makes for anything the OS does.
- **UI**: React views. Platform-neutral web code.
- **Platform implementations**: Rust modules for video embedding, files, processes and
  downloads.

## Windows

- Webview: WebView2 (Edge). Video: libmpv's d3d11 output in a child window under the
  transparent webview (`src-tauri/src/player/render_windows.rs`).
- Bundled: `libmpv-2.dll`, `ffmpeg.exe` (Auto Sync), `yt-dlp.exe` (trailers). See
  [WINDOWS_SECURITY_AND_STABILITY.md](WINDOWS_SECURITY_AND_STABILITY.md) for how these are
  verified and what antivirus products may say about them.
- Downloads default to the Videos known folder (`FOLDERID_Videos`).

## Linux

- Webview: WebKitGTK 4.1. Video: libmpv's OpenGL render API into a GTK `GLArea` under
  the webview (`render_linux.rs`), with X11 and Wayland support.
- `.deb` uses the system's `libmpv2` and `ffmpeg`; the AppImage bundles libmpv and
  FFmpeg's libraries from Ubuntu 24.04.
- Downloads default to `xdg-user-dir VIDEOS`, else `~/Videos`.

## Android (phones and tablets)

What could be reused: the shared TypeScript core and most of the React UI. Tauri 2 can
build Android apps (Android System WebView), so the Rust command layer could stay.

What would have to be built:

- **Video**: libmpv cannot be placed under a WebView the way it is on desktop. Options:
  libmpv for Android (as used by mpv-android) rendering to a `SurfaceView` behind a
  transparent WebView via a Kotlin Tauri plugin, or ExoPlayer/Media3 with a different
  subtitle path. Either is a new player module, not a port.
- **Subtitles**: libass rendering comes with libmpv; with ExoPlayer the Arabic shaping
  that Kinly relies on would need to be re-verified.
- **Auto Sync and trailers**: Kinly runs `ffmpeg` and `yt-dlp` as separate programs.
  Android does not allow that in the same way; Auto Sync would need FFmpeg as a library,
  and yt-dlp (Python) has no practical Android equivalent, so trailers would need another
  approach.
- **Files and downloads**: scoped storage and MediaStore instead of paths; a folder picker
  through the Storage Access Framework.
- **UI**: touch layouts for small screens.

## Android TV / Google TV

Everything listed for Android, plus:

- Manifest: `android.software.leanback` (not required), `android.hardware.touchscreen`
  not required, a `LEANBACK_LAUNCHER` activity and a 320×180 banner.
- Remote input: D-pad and Back. Kinly 1.1's spatial navigation (below) is the part that
  already exists; the player's own controls would need a remote-first layout.
- Performance on TV hardware (low-end ARM SoCs) would have to be measured; device
  capabilities (`caps.ts`) would come from MediaCodec instead of the desktop GPU probe.
- Play Store TV quality guidelines (no touch-only paths, readable at 3 m).

## LG webOS

webOS TV apps are web apps (HTML/CSS/JS packaged as an `.ipk` with `appinfo.json`). There
is no Tauri, no Rust and no libmpv.

- Reusable: the shared TypeScript core and the React UI, behind a new implementation of
  `src/lib/tauri.ts` that uses web APIs instead of Rust commands (storage via
  `localStorage`/IndexedDB, network via `fetch`).
- **Video**: the TV's HTML5 `<video>` element (or webOS media APIs). Codec and container
  support is whatever the TV's hardware decoder supports; MKV and some audio formats may
  not play. Stream ranking would need the TV's real capabilities.
- **Subtitles**: no libass. Subtitles would be drawn in HTML, which loses ASS styling and
  needs its own Arabic rendering checks.
- **Network**: requests come from the web page, so addons and subtitle servers must allow
  cross-origin requests (Kinly's desktop app avoids this by fetching in Rust).
- **Not possible as on desktop**: Auto Sync (no ffmpeg), yt-dlp trailers, local folders,
  in-app downloads.
- Remote: the Back key (keyCode 461) is already handled by Kinly's navigation; the Magic
  Remote pointer works like a mouse.

## TV-ready UI (available now on desktop)

`src/lib/spatialNav.ts` gives the whole interface:

- Arrow keys / D-pad move focus to the nearest element in that direction; rows and pages
  scroll to keep it visible.
- Enter / OK activates. Back (Escape, GoBack, BrowserBack, webOS 461) leaves a text field
  first, closes a dialog, or goes back a view.
- Dialogs keep focus inside until they close, then focus returns to where it was; Back to a
  previous view focuses the card you opened.
- Settings → Appearance → **TV mode** draws larger focus highlights and controls.

It is tested as geometry in unit tests and works with any keyboard. It has not been tested
with a real TV remote, because Kinly does not run on a TV yet.
