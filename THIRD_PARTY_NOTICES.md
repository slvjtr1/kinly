# Third-party notices

## Compass (MIT)

Portions of Kinly are adapted from Compass, https://github.com/compassstremio/Compass,
revision a4adad6d014bd7d49c1edb39138c4a5b7de56f28:

- `src-tauri/src/player/render_linux.rs` (libmpv GTK GLArea embedding; adapted from
  Compass's `src-tauri/src/mpv_render_linux.rs`)
- `src-tauri/src/sync/vad.rs` (`hysteresis`, `VadConfig` and their tests, adapted from
  Compass's `src-tauri/src/subsync/vad.rs`)
- `src-tauri/src/sync/correlate.rs` (the FFT cross-correlation `fft_xcorr` and the peak
  statistics, adapted from Compass's `src-tauri/src/subsync/correlate.rs`)

Each of these files says so in its header. The overall shape of Auto Sync (a single-run
guard around the `sync_subtitle` command, ffmpeg extraction of short audio windows with
the stream's request headers) also follows Compass's `subsync` module; that code
(`sync/mod.rs`, `sync/extract.rs`) was written for Kinly. The Windows video embedding
(`render_windows.rs`) uses the same child-window layout as Compass and other mpv-based
players. A line-by-line comparison of Kinly 1.1.0's Rust and TypeScript sources with
Compass at the revision above found no other copied code beyond short, generic lines.

```
MIT License

Copyright (c) 2026 Compass

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts (SIL Open Font License 1.1)

Noto Naskh Arabic, Noto Sans Arabic, Noto Kufi Arabic and Noto Sans
(Copyright 2010–2020 Google Inc. / Google LLC), copied from Ubuntu's
`fonts-noto-core` package. Full license text: `licenses/OFL.txt` (installed as `notices/OFL.txt`).

Inter 4.1 (Copyright 2016 The Inter Project Authors, https://github.com/rsms/inter),
`InterVariable.woff2` from the official release, used for the interface text.
Full license text: `licenses/Inter-OFL.txt` (installed as `notices/Inter-OFL.txt`).

## Avatars (DiceBear)

The built-in profile pictures in `src/assets/avatars/` were generated once, at
development time, with DiceBear 9.4.3 (https://www.dicebear.com) by
`scripts/generate-avatars.mjs`, and are bundled as SVG files. Each SVG also carries its
source, creator and licence in its own metadata.

- **Adventurer** (`adventurer-*.svg`): "Adventurer" by Lisa Wischofsky
  (https://www.instagram.com/lischi_art/), source
  https://www.figma.com/community/file/1184595184137881796, licensed under
  **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). Kinly selected
  individual combinations and added background colours. Full licence text:
  `licenses/CC-BY-4.0.txt` (installed as `notices/CC-BY-4.0.txt`).
- **Lorelei** (`lorelei-*.svg`): "Lorelei" by Lisa Wischofsky, source
  https://www.figma.com/community/file/1198749693280469639, dedicated to the public
  domain under **CC0 1.0** (https://creativecommons.org/publicdomain/zero/1.0/).
  Credited anyway. Text: `licenses/CC0-1.0.txt` (installed as `notices/CC0-1.0.txt`).
- The DiceBear libraries (`@dicebear/core`, `@dicebear/collection`, MIT,
  Copyright (c) 2024 Florian Körner) are used only by the generator script; they are
  not part of the app.

No artwork from streaming services or other copyrighted characters is included.

## Video engine and other native components

Kinly's own code is MIT licensed. It plays video through **libmpv**
(https://mpv.io). The libmpv builds Kinly uses — Ubuntu/Debian's `libmpv2`
package and the Windows build bundled with the installer — are licensed under
the **GNU GPL version 2 or later**, because they include GPL parts of mpv and
of the libraries it is built with. Packages that bundle libmpv (the Windows
installer and the AppImage) are therefore distributed as a whole under the terms
of the GPL-2.0-or-later; the MIT license of Kinly's source is compatible with
that. Full texts: `licenses/GPL-2.0.txt` and `licenses/LGPL-2.1.txt` (installed
as `notices/GPL-2.0.txt` and `notices/LGPL-2.1.txt`).

| Component | Where | License | Source |
| --- | --- | --- | --- |
| libmpv | DEB: system package. AppImage: bundled from Ubuntu 24.04. Windows: `libmpv-2.dll`, built by shinchiro/mpv-winbuild-cmake | GPL-2.0-or-later | https://github.com/mpv-player/mpv; Ubuntu source package `mpv`; https://github.com/shinchiro/mpv-winbuild-cmake |
| FFmpeg libraries (used by libmpv) | DEB: system packages. AppImage: bundled from Ubuntu 24.04 | GPL-2.0-or-later (Ubuntu build) | Ubuntu source package `ffmpeg`; https://ffmpeg.org |
| `ffmpeg` command (Auto Sync audio extraction) | DEB/AppImage: the system `ffmpeg`. Windows: `ffmpeg.exe`, LGPL build by BtbN/FFmpeg-Builds | Windows build: LGPL-2.1-or-later | https://github.com/FFmpeg/FFmpeg; https://github.com/BtbN/FFmpeg-Builds |
| yt-dlp (trailers) | Windows: `yt-dlp.exe` bundled. All platforms: a checksum-verified copy downloaded on demand from yt-dlp's GitHub releases, or one already installed | The Unlicense (public domain); the Windows executable also contains Python (PSF License) | https://github.com/yt-dlp/yt-dlp |
| WebKitGTK, GTK 3 and their dependencies | DEB: system packages. AppImage: bundled by linuxdeploy | LGPL-2.0/2.1-or-later and others | Ubuntu source packages |
| Microsoft Edge WebView2 Runtime | Windows: installed by Microsoft's bootstrapper if missing | Microsoft software license | Not redistributed by Kinly |

The Windows installer's `notices/NOTICE-windows.txt` names the exact archives
(URL, SHA-256 and mpv commit) that the bundled files come from, and
`notices/ffmpeg-LICENSE.txt` carries FFmpeg's license. The corresponding source
for the GPL/LGPL binaries bundled with a release is published next to it in the
same repository, as the companion release `sources-<tag>` (for example
`sources-v1.1.0`): the `source-*.tar.gz` archives, `GPL-SOURCES.txt` (what each
archive is) and `SHA256SUMS-sources.txt`. Each release's notes link to it. v1.0.0's
source is in `sources-v1.0.0`; v1.0.1 has these files attached to the release itself.
The source is also available
from the projects listed above at the versions named there.

## Libraries compiled into Kinly

Rust crates and npm packages: see `src-tauri/Cargo.lock` and `package-lock.json`.
They are MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 or Unicode-3.0 licensed.
