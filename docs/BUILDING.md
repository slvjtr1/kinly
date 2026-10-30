# Building Kinly

Kinly is a Tauri 2 app (React 19 UI, Rust backend) with an embedded libmpv
player. It builds for **Linux x64** (`.deb`, `.AppImage`) and **Windows x64**
(NSIS `.exe` installer, `.msi`).

- [Linux](#linux)
- [Windows](#windows)
- [Checking the Windows build from Linux](#checking-the-windows-build-from-linux)
- [Release builds (GitHub Actions)](#release-builds-github-actions)
- [Supabase configuration](#supabase-configuration)
- [How video works on each OS](#how-video-works-on-each-os)
- [RTX Video Super Resolution](#rtx-video-super-resolution)

## Linux

Requirements: Rust (rustup), Node.js 20 or newer, and on Ubuntu 24.04 / Mint 22:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev build-essential pkg-config libmpv-dev ffmpeg
```

Without root, install only the `libmpv2` runtime and run
`bash scripts/setup-libmpv-sysroot.sh`, which unpacks the `libmpv-dev` headers and
link files into `.sysroot/`. `scripts/env.sh` (used by `scripts/cargo.sh`) picks
them up.

```bash
npm install
npm run dev                  # Vite + Tauri, hot reload
npx tsc --noEmit -p .        # typecheck
npx vitest run               # UI unit tests
bash scripts/cargo.sh test   # Rust unit tests
bash scripts/release.sh      # tests + .deb + .AppImage into release/<version>/
```

## Windows

Requirements (x64):

- Visual Studio 2022 Build Tools with **Desktop development with C++** (MSVC and the
  Windows SDK; `dumpbin` and `lib` are used to make the libmpv import library);
- Rust via rustup (`x86_64-pc-windows-msvc`, the default);
- Node.js 20 or newer;
- 7-Zip on `PATH` (`7z`);
- WebView2 Runtime (part of Windows 10/11; the installer bootstraps it if missing).

Fetch the native dependencies once (PowerShell, from the repository root):

```powershell
./scripts/fetch-windows-deps.ps1
$env:KINLY_MPV_DIR = "$PWD\src-tauri\windows"   # the script prints this
```

The script downloads three pinned files and **checks their SHA-256** before using
them:

| File | Source | Used for |
| --- | --- | --- |
| `libmpv-2.dll`, `libmpv.dll.a` | [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake/releases) `mpv-dev-x86_64-<date>-git-<rev>.7z` | the player; shipped next to `Kinly.exe` |
| `mpv.lib` | generated: `dumpbin /exports libmpv-2.dll` -> `.def` -> `lib /def` | MSVC import library for linking |
| `ffmpeg.exe` | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) `win64-lgpl` | Auto Sync audio analysis; shipped next to `Kinly.exe` |
| `yt-dlp.exe` | [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp/releases) release asset | trailers in the built-in player; shipped next to `Kinly.exe` |

Everything lands in `src-tauri/windows/` (git-ignored). `src-tauri/build.rs` adds
`KINLY_MPV_DIR` to the linker search path, and `src-tauri/tauri.windows.conf.json`
(merged by Tauri on Windows) bundles the DLL, `ffmpeg.exe` and `yt-dlp.exe` and
selects the NSIS and MSI targets.

```powershell
npm install
$env:PATH = "$env:KINLY_MPV_DIR;$env:PATH"   # so a dev build finds libmpv-2.dll
npm run dev
npx tauri build                               # bundle\nsis\*.exe and bundle\msi\*.msi
```

Updating the pins: shinchiro and BtbN prune old builds, so the pinned URLs
eventually stop working. Pick a new asset, take its `sha256` digest from the GitHub
release API (`https://api.github.com/repos/<owner>/<repo>/releases`), and change
the URL and the hash together in the parameter defaults of
`scripts/fetch-windows-deps.ps1`. One-off overrides also work through the
`KINLY_MPV_URL`/`KINLY_MPV_SHA256`, `KINLY_FFMPEG_URL`/`KINLY_FFMPEG_SHA256` and
`KINLY_YTDLP_URL`/`KINLY_YTDLP_SHA256` environment variables. yt-dlp in particular
goes stale as YouTube changes; bump it with every release.

Helper programs are found by `src-tauri/src/tools.rs`: next to the executable
first (where the installers put them), then `PATH`, with `.exe` added on Windows
and no console window. They degrade cleanly:

- without `ffmpeg.exe`, Settings > About shows "ffmpeg missing" and Auto Sync
  reports that ffmpeg was not found; playback is unaffected;
- without `yt-dlp.exe` (or when it is outdated), trailers fall back to the in-app
  YouTube embed (`src-tauri/src/player/trailer.rs`). `app_info` exposes
  `ffmpeg`, `ytdlp` and `os` flags to the UI.

## Checking the Windows build from Linux

```bash
bash scripts/check-windows.sh               # cargo check --target x86_64-pc-windows-gnu
bash scripts/check-windows.sh --all-targets # also tests and examples
```

This type-checks all `cfg(windows)` code without a Windows machine. It needs no
root: it adds the rustup target, installs zig from PyPI into
`~/.cache/kinly-xdev` as the C compiler for `ring`'s build script, and uses a stub
resource compiler (tauri-build compiles the `.exe` resources even for
`cargo check`). It also creates empty placeholders for the bundled Windows files in
`src-tauri/windows/`; on Windows, `fetch-windows-deps.ps1` replaces them. Nothing
is linked, so the result says nothing about runtime behaviour; the MSVC target
itself is covered by CI.

## Release builds (GitHub Actions)

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `.github/workflows/ci.yml` | every push (not `v*` tags) and pull request | Linux: version check, typecheck, vitest, web build, `cargo test`. Windows: fetch deps, `cargo build --locked`, `cargo test --lib` (non-blocking until confirmed green). |
| `.github/workflows/release.yml` | pushed tag `v*`, or manual run | `prepare` checks versions and the tag and creates a draft release; `linux` builds `.deb` + `.AppImage` on ubuntu-24.04; `windows` builds NSIS `.exe` + `.msi` on windows-latest; both upload their files and a SHA-256 list; `publish` publishes the release, as a **pre-release** when the tag contains `beta`. |

**Versions and channels.** The MSI (WiX) accepts only numeric versions, so
`package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` carry the
plain version (`1.0.0`). A pre-release label comes from `RELEASE_CHANNEL` in
`src/lib/channel.ts` (`"stable"` for normal releases; `"beta"` shows a Beta badge
in the app) and from the tag. `scripts/release-meta.sh` (run by both workflows,
also locally) enforces this:

- the three versions are equal and plain `MAJOR.MINOR.PATCH`;
- the tag is `v<version>` or `v<version>-<label>` (`v1.0.0-beta`, `v1.0.0-beta.2`);
- a tag containing `beta` needs `RELEASE_CHANNEL = "beta"`, any other tag needs
  `"stable"`.

To release:

1. Set the version in the three files and the channel in `src/lib/channel.ts`,
   and add the release to `CHANGELOG.md`.
2. `git tag v1.0.0 && git push origin v1.0.0`.
3. The workflow builds both platforms, uploads to a draft, then publishes it as
   the latest release ("Kinly 1.0.0"). A tag such as `v1.1.0-beta` (with the
   channel set to `"beta"`) is published as a GitHub **pre-release** instead.

A manual run (Actions > Release > Run workflow) with a `tag` input does the same
for that tag (the tag is created at the run's commit when the release is
published); tick `draft` to stop before publishing and publish by hand. Without a
tag, the packages are only kept as workflow artifacts.

Repository setup the workflows assume: Actions enabled with "Read and write"
workflow permissions (or at least `contents: write`, which `release.yml`
requests), and the two Supabase secrets below. Nothing is signed: Windows
SmartScreen will warn about the unsigned installer until a code-signing
certificate is added (`bundle.windows.certificateThumbprint` or a `signCommand`).

All actions are pinned to full commit SHAs (the version is in a comment next to
each). The Rust toolchain is pinned by `RUST_VERSION` in both workflows. The
workflows use only the built-in `GITHUB_TOKEN`; release uploads use the `gh` CLI
preinstalled on the runners.

## Supabase configuration

Accounts and sync need a Supabase project. The frontend reads it at build time
(`src/lib/supabaseConfig.ts`):

- `VITE_SUPABASE_URL` - `https://<project-ref>.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY` - the publishable (client) key

Locally, put them in `.env.local` (git-ignored; see `.env.example`). For releases,
add them as **repository secrets** with the same names (Settings > Secrets and
variables > Actions); `release.yml` passes them to the build. Never use a
service-role or secret key: the publishable key is embedded in the app. A build
without them still works, with accounts unavailable (the workflow warns).

The backend lives in `supabase/`: SQL migrations (tables, row-level security,
PIN, rate-limit and account-deletion functions) and the `trakt-oauth` Edge
Function. With the Supabase CLI linked to the project:

```bash
supabase db push                         # apply supabase/migrations in order
supabase secrets set TRAKT_CLIENT_ID=… TRAKT_CLIENT_SECRET=… KINLY_CLIENT_KEYS=sb_publishable_…
supabase functions deploy trakt-oauth    # uses supabase/config.toml (verify_jwt = false)
```

Migrations are append-only: existing files are never renamed or edited, because
the project records which ones it has applied by file name. `tests/sql-migrations.test.ts`
runs all of them in an in-memory Postgres and checks the security functions and
grants. See `ACCOUNTS.md` for what each table holds and the dashboard settings.

## How video works on each OS

The UI is HTML drawn over the video, so the webview is transparent while a video
plays and the video surface sits behind it. The JavaScript API (`player.*` in
`src/lib/tauri.ts`, the `player:prop` and `player:event` events) is identical on
both systems.

**Linux** (`src-tauri/src/player/render_linux.rs`): the libmpv render API (OpenGL)
draws into a GTK `GLArea` placed under the WebKitGTK webview.

**Windows** (`src-tauri/src/player/render_windows.rs`): mpv runs its own
`gpu-next`/`gpu` VO with `gpu-api=d3d11`, embedded with `wid=<main window HWND>`.
mpv creates a child window that fills the client area and follows resizes and
fullscreen. WebView2 is another child of the same window. Kinly keeps the mpv
window at the bottom of the z-order: a WinEvent hook catches it as soon as it is
created or shown, and mpv's video-reconfig and playback-restart events re-assert
it. The window is also marked `WS_EX_TRANSPARENT | WS_EX_NOACTIVATE` so it never
takes input or focus. While video is shown, the WebView2 default background is
switched to transparent (`ICoreWebView2Controller2::SetDefaultBackgroundColor`)
and back to the app colour when playback stops.

Why `wid` and not the render API on Windows: libmpv's render API offers only
OpenGL there, which would mean WGL, `WGL_NV_DX_interop` (or copy-back decoding)
for D3D11VA frames, a GL context driven from the UI thread, and no D3D11 frames
for `d3d11vpp`, so no RTX Video Super Resolution. The native d3d11 VO is mpv's
best-tested Windows path: zero-copy D3D11VA, a flip-model swap chain, and rendering
on mpv's own thread. Compass (whose Linux embedding Kinly adapts) ships the same layout.

**Risks of the Windows embedding** (not yet verified on real hardware):

- *Compositing.* The approach relies on DWM compositing mpv's flip-model swap
  chain (a sibling child window, bottom of the z-order) beneath the transparent
  parts of WebView2's DirectComposition output. This is what wid-embedding
  Tauri/WebView2 players do, but if the video stays black or the UI is opaque
  over it, the first thing to try is `"transparent": true` for the main window in
  `tauri.windows.conf.json` (the HTML must then paint its own opaque background
  outside playback, which it already does).
- *Z-order races.* If mpv recreates its window (VO reinit, fullscreen toggles,
  GPU reset) and the WinEvent hook misses it, the video could cover the UI for a
  moment until the next video-reconfig / playback-restart event restacks it.
- *Input and focus.* Keyboard shortcuts depend on WebView2 keeping focus;
  `input-vo-keyboard=no`, `input-cursor=no` and `WS_EX_NOACTIVATE` keep mpv out
  of it. A click that still reaches the mpv window would not reach the UI.
- *DPI and resize.* mpv sizes its window to the parent client area itself;
  per-monitor DPI changes and maximise/fullscreen need a manual check.
- *WebView2 GPU.* `--force_high_performance_gpu` is a best-effort hint; on hybrid
  laptops the UI may still composite on the integrated GPU while mpv renders on
  the discrete one, which costs a cross-adapter copy in DWM.
- *Dependencies.* libmpv comes from a third-party nightly build (shinchiro);
  `d3d11vpp` `scaling-mode` needs mpv 0.39 or newer.

Fallback if the embedding cannot be made reliable: the libmpv render API with
OpenGL over ANGLE/WGL, copy-back decoding (`d3d11va-copy`) and no RTX VSR.

**GPU selection.** Linux: see `src-tauri/src/gpu.rs` (PRIME offload variables).
Windows (`src-tauri/src/gpu_windows.rs`): adapters come from DXGI, and on hybrid
laptops the render adapter is the one DXGI ranks first for high performance (this
follows Windows Settings > Display > Graphics). mpv gets it through
`d3d11-adapter`, and WebView2 gets `--force_high_performance_gpu` through
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, unless the user already set that
variable. `KINLY_GPU=integrated` keeps both on the adapter that drives the display.
Hardware decoding is `d3d11va,d3d11va-copy,auto-safe`, and the codec badges in
Settings come from the adapter's D3D11 decoder profiles. The Settings switch
"Hardware decoding" sends `hwdec=auto-safe` when on; the player maps that to the
probed list (`resolve_hwdec` in `player/mod.rs`), so zero-copy d3d11va (and with it
VSR) is kept, and on Linux the VA-API/NVDEC order is kept too.

## RTX Video Super Resolution

Settings > Playback shows **RTX Video Super Resolution** only when an NVIDIA RTX GPU
is detected, on any OS (`isRtxGpu` / `rtxSuperResolutionSupport` in
`src/lib/settings.ts`, tested in `tests/rtx.test.ts`; `caps::is_rtx` in Rust,
exposed as `systemCaps.rtx`). The setting is `playback.rtxSuperResolution`
(default off).

- **Windows:** when it is on, and the video is decoded with zero-copy `d3d11va`
  and is smaller than the display, Kinly adds
  `@kinly-vsr:d3d11vpp=scale=<display/source>:scaling-mode=nvidia` (mpv 0.39 or
  newer). The scale is capped at 4. The filter is evaluated on every playback
  restart and removed when a new file starts (`src-tauri/src/player/vsr.rs`).
  "RTX Video enhancement > Super resolution" must also be on in the NVIDIA app or
  Control Panel.
- **Linux:** the switch is shown disabled with "Available on Windows (NVIDIA
  driver limitation)", because NVIDIA's Linux driver has no VSR.

The policy (`scale_for`, `filter`, `enabled_in` in `vsr.rs`) is pure and unit
tested on every OS; whether the NVIDIA driver actually engages VSR can only be
checked on Windows with an RTX GPU (the NVIDIA app's "RTX Video" status
indicator, or GPU load rising when the switch is on).
