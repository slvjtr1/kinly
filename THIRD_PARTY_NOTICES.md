# Third-party notices

## Compass (MIT)

Portions of Kinly are adapted from Compass, https://github.com/compassstremio/Compass,
revision a4adad6d014bd7d49c1edb39138c4a5b7de56f28:

- `src-tauri/src/player/render_linux.rs` (libmpv GTK GLArea embedding)
- `src-tauri/src/sync/vad.rs` (heuristic voice-activity detection)
- `src-tauri/src/sync/correlate.rs` (FFT cross-correlation and peak statistics)

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
for the GPL/LGPL binaries bundled with a release is attached to that release on
GitHub (`source-*.tar.gz`, listed in `GPL-SOURCES.txt`), and is also available
from the projects listed above at the versions named there.

## Libraries compiled into Kinly

Rust crates and npm packages: see `src-tauri/Cargo.lock` and `package-lock.json`.
They are MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 or Unicode-3.0 licensed.
