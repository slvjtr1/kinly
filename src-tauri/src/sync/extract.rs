//! Decode a short audio window from a local file or HTTP stream with ffmpeg.
//! `-ss` before `-i` makes ffmpeg seek (HTTP range requests for streams), so
//! only the analysed window is read, never the whole media.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

use super::vad::SR;

pub fn locate_ffmpeg() -> Option<PathBuf> {
    // Bundled next to the executable (Windows installers, AppImage), then PATH.
    crate::tools::locate("ffmpeg")
}

fn header_blob(headers: &HashMap<String, String>) -> String {
    headers
        .iter()
        .filter(|(k, v)| {
            !k.eq_ignore_ascii_case("user-agent") && !k.contains(['\r', '\n']) && !v.contains(['\r', '\n'])
        })
        .map(|(k, v)| format!("{k}: {v}\r\n"))
        .collect()
}

/// Two channels (L, R) at 16 kHz, interleaved, band-limited to the voice range.
/// ffmpeg's standard 5.1/7.1 downmix puts the centre channel equally into L and R,
/// so dialogue ends up in the mid (L+R) signal for surround sources as well.
pub async fn decode_dialogue_pair(
    media: &str,
    headers: &HashMap<String, String>,
    audio_ff_index: Option<i64>,
    start_sec: f32,
    len_sec: f32,
    timeout: Duration,
) -> Result<Vec<f32>, String> {
    let ff = locate_ffmpeg().ok_or("ffmpeg not found")?;
    let mut cmd = Command::new(ff);
    #[cfg(windows)]
    cmd.creation_flags(crate::tools::CREATE_NO_WINDOW);
    cmd.args(["-hide_banner", "-nostats", "-loglevel", "error", "-nostdin"]);
    if media.contains("://") {
        // A stream (or an HLS playlist it serves) may only pull more network URLs, never local files.
        cmd.args(["-protocol_whitelist", "http,https,tcp,tls,crypto,httpproxy"]);
        cmd.arg("-user_agent").arg(crate::net::USER_AGENT);
        let blob = header_blob(headers);
        if !blob.is_empty() {
            cmd.arg("-headers").arg(blob);
        }
    }
    let map = match audio_ff_index {
        Some(i) if i >= 0 => format!("0:{i}"),
        _ => "0:a:0".to_string(),
    };
    cmd.arg("-ss")
        .arg(format!("{start_sec:.3}"))
        .arg("-t")
        .arg(format!("{len_sec:.3}"))
        .arg("-i")
        .arg(media)
        .args(["-vn", "-sn", "-dn", "-map", &map, "-ac", "2", "-ar"])
        .arg(SR.to_string())
        .args(["-af", "highpass=f=200,lowpass=f=3400", "-f", "f32le", "-"]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| "audio decode timed out".to_string())?
        .map_err(|e| format!("run ffmpeg: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ffmpeg failed: {}", crate::logging::redact(err.lines().last().unwrap_or(""))));
    }
    Ok(out
        .stdout
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}
