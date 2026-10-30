<#
.SYNOPSIS
  Fetch the native Windows dependencies Kinly bundles: libmpv (shinchiro
  mpv-winbuild-cmake dev build), ffmpeg.exe (BtbN FFmpeg-Builds, LGPL) and
  yt-dlp.exe (official yt-dlp release).

.DESCRIPTION
  All downloads are pinned by URL and verified against a SHA-256 before use.
  Output (default src-tauri/windows, git-ignored):
    libmpv-2.dll   bundled next to Kinly.exe (tauri.windows.conf.json)
    mpv.lib        MSVC import library, generated from the DLL's export table
    libmpv.dll.a   GNU import library (x86_64-pc-windows-gnu builds)
    ffmpeg.exe     bundled next to Kinly.exe for Auto Sync
    yt-dlp.exe     bundled next to Kinly.exe for trailers
    ffmpeg-LICENSE.txt, NOTICE-windows.txt   bundled under notices/
  Prints KINLY_MPV_DIR=<dir>; in GitHub Actions it is also written to $GITHUB_ENV
  (src-tauri/build.rs adds it to the linker search path).

  To update a pin, change the URL and the SHA-256 together. shinchiro and BtbN
  prune old builds, so a pin eventually has to move; the GitHub release API
  lists each asset's sha256 "digest". Every pin can also be overridden from the
  environment (KINLY_MPV_URL/_SHA256, KINLY_FFMPEG_URL/_SHA256,
  KINLY_YTDLP_URL/_SHA256), e.g. from a workflow_dispatch run.
#>
param(
  [string]$MpvUrl = $(if ($env:KINLY_MPV_URL) { $env:KINLY_MPV_URL } else { "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/mpv-dev-x86_64-20261021-git-e471496c56.7z" }),
  [string]$MpvSha256 = $(if ($env:KINLY_MPV_SHA256) { $env:KINLY_MPV_SHA256 } else { "efc719eff3dc5954b4a5efc800632808bcec01cc9034940dd14e5eb7fe9ea633" }),
  [string]$FfmpegUrl = $(if ($env:KINLY_FFMPEG_URL) { $env:KINLY_FFMPEG_URL } else { "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-28-19-47/ffmpeg-n8.1.3-25-g611cec792a-win64-lgpl-8.1.zip" }),
  [string]$FfmpegSha256 = $(if ($env:KINLY_FFMPEG_SHA256) { $env:KINLY_FFMPEG_SHA256 } else { "023ba9e491ce616ea2e3c2b10b7c7df16a4714c0ec1dbf0f4e0f59aae04e73e8" }),
  [string]$YtdlpUrl = $(if ($env:KINLY_YTDLP_URL) { $env:KINLY_YTDLP_URL } else { "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe" }),
  [string]$YtdlpSha256 = $(if ($env:KINLY_YTDLP_SHA256) { $env:KINLY_YTDLP_SHA256 } else { "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d" }),
  [string]$OutDir = (Join-Path $PSScriptRoot "..\src-tauri\windows")
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ("kinly-deps-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Get-Verified([string]$Url, [string]$Sha256, [string]$Name) {
  $file = Join-Path $work $Name
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
  $got = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($got -ne $Sha256.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Name`n  expected $Sha256`n  got      $got"
  }
  Write-Host "  sha256 ok ($got)"
  return $file
}

function Find-MsvcTool([string]$Exe) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found; install Visual Studio Build Tools (C++)" }
  $hit = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -find "VC\Tools\MSVC\*\bin\Hostx64\x64\$Exe" | Select-Object -First 1
  if (-not $hit) { throw "$Exe not found in the MSVC toolset" }
  return $hit
}

# --- libmpv -----------------------------------------------------------------
$mpvArchive = Get-Verified $MpvUrl $MpvSha256 "mpv-dev.7z"
$mpvDir = Join-Path $work "mpv"
& 7z x -y "-o$mpvDir" $mpvArchive | Out-Null
if ($LASTEXITCODE -ne 0) { throw "7z failed to extract $mpvArchive" }
$dll = Get-ChildItem -Path $mpvDir -Recurse -Filter "libmpv-2.dll" | Select-Object -First 1
if (-not $dll) { throw "libmpv-2.dll not found in the archive" }
Copy-Item $dll.FullName $OutDir -Force
$dlla = Get-ChildItem -Path $mpvDir -Recurse -Filter "libmpv.dll.a" | Select-Object -First 1
if ($dlla) { Copy-Item $dlla.FullName $OutDir -Force }

# MSVC import library from the DLL's exports (the archive ships only the GNU one).
$dumpbin = Find-MsvcTool "dumpbin.exe"
$libexe = Find-MsvcTool "lib.exe"
$names = & $dumpbin /nologo /exports $dll.FullName | ForEach-Object {
  if ($_ -match '^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]{8}\s+(mpv_\w+)') { $Matches[1] }
}
if (-not $names -or $names.Count -lt 20) { throw "could not read libmpv exports (got $($names.Count))" }
$def = Join-Path $work "mpv.def"
@("LIBRARY libmpv-2", "EXPORTS") + $names | Set-Content -Path $def -Encoding ascii
& $libexe /nologo "/def:$def" "/name:libmpv-2.dll" /machine:x64 "/out:$(Join-Path $OutDir 'mpv.lib')" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "lib.exe failed to create mpv.lib" }
Write-Host "  mpv.lib: $($names.Count) exports"

# --- ffmpeg -----------------------------------------------------------------
$ffZip = Get-Verified $FfmpegUrl $FfmpegSha256 "ffmpeg.zip"
$ffDir = Join-Path $work "ffmpeg"
Expand-Archive -Path $ffZip -DestinationPath $ffDir -Force
$ff = Get-ChildItem -Path $ffDir -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $ff) { throw "ffmpeg.exe not found in the archive" }
Copy-Item $ff.FullName $OutDir -Force
$lic = Get-ChildItem -Path $ffDir -Recurse -Filter "LICENSE.txt" | Select-Object -First 1
if ($lic) {
  Copy-Item $lic.FullName (Join-Path $OutDir "ffmpeg-LICENSE.txt") -Force
} else {
  "FFmpeg is licensed under the GNU LGPL v2.1 or later. Source: https://ffmpeg.org/" |
    Set-Content -Path (Join-Path $OutDir "ffmpeg-LICENSE.txt") -Encoding utf8
}

# --- yt-dlp -----------------------------------------------------------------
$yt = Get-Verified $YtdlpUrl $YtdlpSha256 "yt-dlp.exe"
Copy-Item $yt (Join-Path $OutDir "yt-dlp.exe") -Force

$mpvCommit = if ($MpvUrl -match 'git-([0-9a-f]+)\.7z$') { $Matches[1] } else { "see the archive name above" }
@(
  "Native components bundled with Kinly for Windows",
  "",
  "Kinly itself is MIT licensed. libmpv-2.dll is licensed under the GNU GPL version 2 or later,",
  "so Kinly for Windows as a whole is distributed under the terms of the GPL-2.0-or-later.",
  "License texts: GPL-2.0.txt and LGPL-2.1.txt in this folder.",
  "",
  "libmpv-2.dll - mpv (https://mpv.io), GPL-2.0-or-later build by shinchiro/mpv-winbuild-cmake.",
  "  $MpvUrl",
  "  sha256 $MpvSha256",
  "  Source: mpv commit $mpvCommit (https://github.com/mpv-player/mpv), built with",
  "  https://github.com/shinchiro/mpv-winbuild-cmake, which lists the bundled libraries and their sources.",
  "",
  "ffmpeg.exe - FFmpeg (https://ffmpeg.org), LGPL build by BtbN/FFmpeg-Builds. See ffmpeg-LICENSE.txt.",
  "  $FfmpegUrl",
  "  sha256 $FfmpegSha256",
  "  Source: https://github.com/FFmpeg/FFmpeg and https://github.com/BtbN/FFmpeg-Builds",
  "",
  "yt-dlp.exe - yt-dlp (https://github.com/yt-dlp/yt-dlp), The Unlicense (public domain).",
  "  The executable is a PyInstaller bundle that includes Python (PSF License) and",
  "  the libraries listed at https://github.com/yt-dlp/yt-dlp#dependencies.",
  "  $YtdlpUrl",
  "  sha256 $YtdlpSha256"
) | Set-Content -Path (Join-Path $OutDir "NOTICE-windows.txt") -Encoding utf8

Remove-Item -Recurse -Force $work
Write-Host "KINLY_MPV_DIR=$OutDir"
if ($env:GITHUB_ENV) { "KINLY_MPV_DIR=$OutDir" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8 }
Get-ChildItem $OutDir | Format-Table Name, Length
