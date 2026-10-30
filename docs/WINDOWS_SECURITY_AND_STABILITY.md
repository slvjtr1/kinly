# Windows: antivirus detections and stability

This page records what is known about Microsoft Defender detections of Kinly on
Windows, what was changed, and what users and maintainers should do. It separates
facts (observed) from hypotheses (not verified).

**Never turn off Microsoft Defender or another antivirus for Kinly, and never add an
exclusion just to make Kinly run.** If your antivirus blocks Kinly, follow
[What to do if Defender flags Kinly](#what-to-do-if-defender-flags-kinly).

## What was observed

On a Windows 11 test machine on 2026-10-30, Microsoft Defender's real-time protection
quarantined `kinly.exe` from both the 1.0.0 and the 1.0.1 installers:

| | |
| --- | --- |
| Detection | `Trojan:Win32/Bearfoos.A!ml` (severity "Severe", category Trojan) |
| File | `%LOCALAPPDATA%\Kinly\kinly.exe` (the main program) only |
| Source | Real-Time Protection, "Concrete" detection, local machine |
| When | When the file was started (first event: by `taskhostw.exe` / `explorer.exe`), before Kinly ran any code of its own |
| Action | Quarantine. Defender also listed the Start-menu and desktop shortcuts and the uninstall registry key as related resources |
| Defender | Security intelligence 1.463.33.0, engine 1.1.26100.4, platform 4.18.25080.5 |

Effect for the user: the shortcut opens nothing (or Windows reports a missing file),
which looks like a crash.

The other files installed with Kinly were **not** flagged. A Defender custom scan of
the install folder (`ffmpeg.exe`, `libmpv-2.dll`, `yt-dlp.exe`, `uninstall.exe`) found
nothing. `yt-dlp.exe` has the SHA-256 published by the yt-dlp project for release
2026.10.26 (`f5389d36…7a7d`), the same value pinned in `scripts/fetch-windows-deps.ps1`.
`ffmpeg.exe` and `libmpv-2.dll` come from archives whose SHA-256 is pinned in the same
script and verified in CI before every build (listed in `notices/NOTICE-windows.txt`).

## What the detection name means

The `!ml` suffix marks a verdict from Defender's machine-learning models rather than a
signature for known malware; "Bearfoos" is a generic family name used for such
verdicts. Microsoft documents that new, unsigned programs with little reputation are
more likely to receive heuristic detections, and that developers can submit files for
analysis.

Kinly is built in GitHub Actions from this repository's source by
`.github/workflows/release.yml`; nothing is added to the binary after the build, and
no code in the repository is designed to hide what it does. That is not the same as
proof that the detection is a false positive: only Microsoft's analysis of the
submitted file can establish that. Until Microsoft confirms it, this page does not call
it one.

### Possible contributing factors (hypotheses, not verified)

- `kinly.exe` is not code-signed and every release is a new file with no reputation.
- The program contains the ability to download a program (yt-dlp, from GitHub, checked
  against the published SHA-256) and run it, and it starts helper programs (ffmpeg,
  yt-dlp) without a console window. These are normal for a media player but are also
  traits that heuristic models associate with downloaders.
- The `.exe` had no publisher in its version information.

## What changed in 1.1.0

- **No download-and-run on first use:** trailers now use the bundled `yt-dlp.exe` first.
  A new copy is downloaded only when no copy works (for example after YouTube changes).
  This is a real reduction of risky behaviour, not a way to hide behaviour.
- **Publisher in the version information** (`Kinly contributors`).
- **Missing or blocked video engine is reported, not a crash:** `libmpv-2.dll` is now
  delay-loaded. If it is missing (incomplete installation, or removed by a security
  program) or cannot be loaded, Kinly still opens; playing something shows "The video
  engine could not start (… libmpv-2.dll is missing from … Reinstall Kinly …)" and the
  log records it. Previously Windows refused to start Kinly with a loader error.
- Missing `ffmpeg.exe` or `yt-dlp.exe` already only disable Auto Sync or trailers, and
  Settings → About says which helper is missing.
- Releases no longer carry extra files: four installers, and GitHub shows each one's
  SHA-256 digest.

Nothing was obfuscated or packed, no binary was modified to change how scanners see it,
and Kinly does not add antivirus exclusions.

## Results

The 1.1.0 beta builds were checked on Windows; see "Verification of the 1.1.0 Beta build"
at the end of this page.

## What to do if Defender flags Kinly

1. Do not disable Defender and do not restore the file blindly.
2. Check that the installer came from this repository's Releases page and compare its
   SHA-256 with the digest GitHub shows next to the file:
   `Get-FileHash .\Kinly_1.1.0_x64-setup.exe`.
3. Open Windows Security → Virus & threat protection → Protection history, note the
   detection name, and report it (with the Kinly version) in the repository's issues.
4. If the hash matches the release, submit the file to Microsoft for analysis:
   <https://www.microsoft.com/en-us/wdsi/filesubmission> ("Home customer" or "Software
   developer", "Incorrectly detected as malware/malicious"). If Microsoft clears it,
   Defender stops flagging that file after a signature update.
5. Only restore a quarantined file from Protection history after Microsoft's analysis,
   or after you have confirmed the hash yourself, and only if you trust the source.

## Recommendations for maintainers

- **Code-sign** `kinly.exe`, the NSIS installer and the MSI (an OV certificate, or
  Microsoft's Trusted Signing service). Signing builds reputation across releases and
  is the most effective step against heuristic detections and SmartScreen prompts.
  Signing needs a certificate in the maintainer's name, so it was not set up here.
- **Submit each Windows release** (installer and `kinly.exe`) to the Microsoft portal
  above as a software developer before announcing it.
- Keep the helper programs pinned by SHA-256 (as now) and keep the release notes
  stating where each bundled binary comes from.
- Check other engines (for example by uploading the installer to a multi-engine
  scanner) and record the results here.

## Verification of the 1.1.0 Beta build

Tested on the same Windows 11 machine on 2026-10-30, with real-time protection on and
security intelligence 1.463.33.0 (the version that flagged 1.0.x):

- `Kinly_1.1.0_x64-setup.exe` from the v1.1.0-beta release: SHA-256 matched the digest
  GitHub shows; a Defender custom scan of the installer found nothing.
- Silent install (`/S`), then `kinly.exe` started three times over about 20 minutes
  (browsing, search, an in-app download that was cancelled, a delete, trailers played
  through libmpv): **no Defender detection** in that time. `kinly.exe` carries
  CompanyName "Kinly contributors" and version 1.1.0.
- With `libmpv-2.dll` renamed away, Kinly started normally; playing logged
  "libmpv-2.dll is missing … Reinstall Kinly from the official release" and the trailer
  fell back to the YouTube player instead of the app failing to start. The file was
  restored afterwards (SHA-256 unchanged).
- Beta 2 (built by the same workflow): the installer was scanned with a Defender custom
  scan (nothing found) and installed over Beta 1 with `/S`; `kinly.exe` was started
  twice (browsing, keyboard navigation, search, profile editing, a download listed and
  deleted): **no Defender detection**.

This is one machine at one signature version. It does not prove that Defender or other
products will not flag a later build, because heuristic models and reputation change.
Code signing and submission to Microsoft remain the recommended steps.
