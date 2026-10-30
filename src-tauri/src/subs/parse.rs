//! Subtitle decoding and cue-timing extraction (SRT, WebVTT, ASS/SSA).
//! Only timings and plain text are extracted; mpv/libass does the rendering.

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SubFormat {
    Srt,
    Vtt,
    Ass,
}

impl SubFormat {
    pub fn ext(self) -> &'static str {
        match self {
            SubFormat::Srt => "srt",
            SubFormat::Vtt => "vtt",
            SubFormat::Ass => "ass",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

/// Decode raw bytes to UTF-8. Handles BOMs, valid UTF-8, and legacy code pages
/// (Windows-1256 is common for Arabic) via chardetng.
pub fn decode(bytes: &[u8]) -> (String, &'static str) {
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _, _) = enc.decode(&bytes[bom_len..]);
        return (text.into_owned(), enc.name());
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "UTF-8");
    }
    let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    det.feed(bytes, true);
    let enc = det.guess(None, chardetng::Utf8Detection::Allow);
    let (text, _, _) = enc.decode(bytes);
    (text.into_owned(), enc.name())
}

pub fn detect_format(text: &str) -> Option<SubFormat> {
    let head: String = text.trim_start().chars().take(4096).collect();
    if head.starts_with("WEBVTT") {
        return Some(SubFormat::Vtt);
    }
    if head.contains("[Script Info]") || head.contains("[Events]") {
        return Some(SubFormat::Ass);
    }
    // Checked before a bare "Dialogue:" so an SRT line of text starting with it stays SRT.
    if timing_regex().is_match(&head) {
        return Some(SubFormat::Srt);
    }
    head.contains("Dialogue:").then_some(SubFormat::Ass)
}

fn timing_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?m)^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})",
        )
        .unwrap()
    })
}

fn hms(h: Option<regex::Match>, m: &str, s: &str, frac: &str) -> f32 {
    let h: f32 = h.and_then(|x| x.as_str().parse().ok()).unwrap_or(0.0);
    let m: f32 = m.parse().unwrap_or(0.0);
    let s: f32 = s.parse().unwrap_or(0.0);
    let scale = 10f32.powi(frac.len() as i32);
    let f: f32 = frac.parse::<f32>().unwrap_or(0.0) / scale;
    h * 3600.0 + m * 60.0 + s + f
}

/// SRT and WebVTT share the `a --> b` block structure.
fn parse_blocks(text: &str) -> Vec<Cue> {
    let re = timing_regex();
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues = Vec::new();
    let mut lines = normalized.lines().peekable();
    while let Some(line) = lines.next() {
        let Some(c) = re.captures(line) else { continue };
        let start = hms(c.get(1), &c[2], &c[3], &c[4]);
        let end = hms(c.get(5), &c[6], &c[7], &c[8]);
        let mut body = Vec::new();
        while let Some(next) = lines.peek() {
            if next.trim().is_empty() {
                break;
            }
            if re.is_match(next) {
                break;
            }
            body.push(lines.next().unwrap_or_default().to_string());
        }
        if end > start {
            cues.push(Cue { start, end, text: strip_tags(&body.join("\n")) });
        }
    }
    cues
}

fn ass_time(s: &str) -> Option<f32> {
    let mut parts = s.trim().split(':');
    let h: f32 = parts.next()?.parse().ok()?;
    let m: f32 = parts.next()?.parse().ok()?;
    let sec: f32 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

fn parse_ass(text: &str) -> Vec<Cue> {
    let mut fields: Vec<String> = Vec::new();
    let mut in_events = false;
    let mut cues = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_events = line.eq_ignore_ascii_case("[events]");
            continue;
        }
        if !in_events {
            continue;
        }
        if let Some(rest) = line.strip_prefix("Format:") {
            fields = rest.split(',').map(|f| f.trim().to_ascii_lowercase()).collect();
            continue;
        }
        let Some(rest) = line.strip_prefix("Dialogue:") else { continue };
        if fields.is_empty() {
            fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        }
        let parts: Vec<&str> = rest.splitn(fields.len(), ',').collect();
        let idx = |name: &str| fields.iter().position(|f| f == name);
        let (Some(si), Some(ei), Some(ti)) = (idx("start"), idx("end"), idx("text")) else { continue };
        let (Some(start), Some(end)) = (parts.get(si).and_then(|s| ass_time(s)), parts.get(ei).and_then(|s| ass_time(s)))
        else {
            continue;
        };
        let body = parts.get(ti).copied().unwrap_or("");
        // Skip pure drawing/karaoke-effect events: they are not dialogue.
        if body.contains("\\p1") {
            continue;
        }
        if end > start {
            cues.push(Cue { start, end, text: strip_tags(&body.replace("\\N", "\n").replace("\\n", "\n")) });
        }
    }
    cues
}

fn strip_tags(s: &str) -> String {
    static TAGS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = TAGS.get_or_init(|| regex::Regex::new(r"<[^>]{0,200}>|\{[^}]{0,400}\}").unwrap());
    re.replace_all(s, "").trim().to_string()
}

pub fn parse(text: &str, format: SubFormat) -> Vec<Cue> {
    let mut cues = match format {
        SubFormat::Srt | SubFormat::Vtt => parse_blocks(text),
        SubFormat::Ass => parse_ass(text),
    };
    cues.retain(|c| !c.text.is_empty());
    cues.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));
    cues
}

/// Merge overlapping cues into dialogue intervals for the correlator.
pub fn cue_intervals(cues: &[Cue]) -> Vec<(f32, f32)> {
    let mut out: Vec<(f32, f32)> = Vec::with_capacity(cues.len());
    for c in cues {
        if let Some(last) = out.last_mut() {
            if c.start <= last.1 {
                last.1 = last.1.max(c.end);
                continue;
            }
        }
        out.push((c.start, c.end));
    }
    out
}

/// True when a cue carries no spoken words: sound descriptions and music cues
/// common in SDH subtitles ("[door slams]", "(sighs)", "♪ ... ♪", "♪♪"),
/// optionally with a speaker label or dash. Such cues mark audio that is not
/// dialogue and would blur the subtitle activity signal used by Auto Sync.
pub fn is_non_speech(text: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(concat!(
            r"\[[^\]]{0,200}\]|\([^)]{0,200}\)|［[^］]{0,200}］|（[^）]{0,200}）|【[^】]{0,200}】",
            r"|[♪♫#][^♪♫#]{0,300}[♪♫#]|[♪♫]",
            r"|(?m)^\s*(?:-|–|>>)?\s*[\p{Lu}][\p{Lu}\d .'’-]{0,30}:",
        ))
        .unwrap()
    });
    let rest = re.replace_all(text, " ");
    !rest.chars().any(char::is_alphanumeric)
}

/// Dialogue intervals for Auto Sync: non-speech cues are left out, unless that
/// would leave almost nothing (e.g. a lyrics-only subtitle).
pub fn dialogue_intervals(cues: &[Cue]) -> Vec<(f32, f32)> {
    let spoken: Vec<Cue> = cues.iter().filter(|c| !is_non_speech(&c.text)).cloned().collect();
    if spoken.len() < 8 || spoken.len() * 5 < cues.len() {
        return cue_intervals(cues);
    }
    cue_intervals(&spoken)
}

fn fmt_time(t: f32, format: SubFormat) -> String {
    // ASS has centisecond precision: round to it (truncating lost up to 9 ms).
    let unit: u64 = if format == SubFormat::Ass { 10 } else { 1 };
    let ms = ((t.max(0.0) as f64 * 1000.0 / unit as f64).round() as u64) * unit;
    let (h, m, s, f) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
    match format {
        SubFormat::Srt => format!("{h:02}:{m:02}:{s:02},{f:03}"),
        SubFormat::Vtt => format!("{h:02}:{m:02}:{s:02}.{f:03}"),
        SubFormat::Ass => format!("{h}:{m:02}:{s:02}.{:02}", f / 10),
    }
}

/// Rewrite every cue's timing with `map(cue_start) = (ratio, offset)`:
/// `t' = ratio * t + offset`, applied to start and end alike so a cue keeps its
/// length and stays in one segment. Everything else in the file is kept as is.
pub fn retime(text: &str, format: SubFormat, map: impl Fn(f32) -> (f32, f32)) -> String {
    let apply = |start: f32, end: f32| {
        let (r, o) = map(start);
        (r * start + o, r * end + o)
    };
    match format {
        SubFormat::Srt | SubFormat::Vtt => timing_regex()
            .replace_all(text, |c: &regex::Captures| {
                let (s, e) = apply(hms(c.get(1), &c[2], &c[3], &c[4]), hms(c.get(5), &c[6], &c[7], &c[8]));
                format!("{} --> {}", fmt_time(s, format), fmt_time(e, format))
            })
            .into_owned(),
        SubFormat::Ass => {
            let mut fields: Vec<String> = Vec::new();
            let mut in_events = false;
            let mut out = String::with_capacity(text.len());
            for raw in text.split_inclusive('\n') {
                let line = raw.trim_start();
                if line.starts_with('[') {
                    in_events = line.trim_end().eq_ignore_ascii_case("[events]");
                } else if in_events {
                    if let Some(rest) = line.strip_prefix("Format:") {
                        fields = rest.split(',').map(|f| f.trim().to_ascii_lowercase()).collect();
                    } else if let Some(rest) = line.strip_prefix("Dialogue:") {
                        let n = if fields.is_empty() { 10 } else { fields.len() };
                        let idx = |name: &str, d: usize| fields.iter().position(|f| f == name).unwrap_or(d);
                        let (si, ei) = (idx("start", 1), idx("end", 2));
                        let mut parts: Vec<String> = rest.splitn(n, ',').map(str::to_string).collect();
                        if let (Some(s), Some(e)) = (parts.get(si).and_then(|x| ass_time(x)), parts.get(ei).and_then(|x| ass_time(x))) {
                            let (s, e) = apply(s, e);
                            parts[si] = fmt_time(s, format);
                            parts[ei] = fmt_time(e, format);
                            let indent = &raw[..raw.len() - line.len()];
                            out.push_str(indent);
                            out.push_str("Dialogue: ");
                            out.push_str(parts.join(",").trim_start());
                            if !out.ends_with('\n') && raw.ends_with('\n') {
                                out.push('\n');
                            }
                            continue;
                        }
                    }
                }
                out.push_str(raw);
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRT: &str = "1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hello</i>\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,250\r\nمرحبا بالعالم\r\nسطر ثان\r\n\r\n";

    #[test]
    fn parses_srt_with_crlf_and_tags() {
        let cues = parse(SRT, detect_format(SRT).unwrap());
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "Hello");
        assert!((cues[1].end - 6.25).abs() < 1e-4);
        assert_eq!(cues[1].text, "مرحبا بالعالم\nسطر ثان");
    }

    #[test]
    fn parses_vtt_short_timestamps() {
        let vtt = "WEBVTT\n\n00:01.000 --> 00:02.500 align:start\nHi\n\n01:00:00.000 --> 01:00:01.000\nLate\n";
        assert_eq!(detect_format(vtt), Some(SubFormat::Vtt));
        let cues = parse(vtt, SubFormat::Vtt);
        assert_eq!(cues.len(), 2);
        assert!((cues[0].start - 1.0).abs() < 1e-4);
        assert!((cues[1].start - 3600.0).abs() < 1e-3);
    }

    #[test]
    fn parses_ass_dialogue_with_commas() {
        let ass = "[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.10,0:00:07.00,Default,,0,0,0,,{\\b1}Well, hello\\Nthere\nDialogue: 0,0:00:08.00,0:00:09.00,Sign,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}\n";
        let cues = parse(ass, detect_format(ass).unwrap());
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "Well, hello\nthere");
        assert!((cues[0].start - 5.1).abs() < 1e-3);
    }

    #[test]
    fn decodes_windows_1256_arabic() {
        let (bytes, _, _) = encoding_rs::WINDOWS_1256.encode("1\n00:00:01,000 --> 00:00:02,000\nمرحبا، كيف حالك؟ هذا نص عربي طويل بما يكفي للكشف عن الترميز\n");
        assert!(std::str::from_utf8(&bytes).is_err());
        let (text, enc) = decode(&bytes);
        assert!(text.contains("مرحبا"), "decoded as {enc}: {text}");
    }

    #[test]
    fn decodes_utf8_bom() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("WEBVTT\n".as_bytes());
        assert_eq!(decode(&b).0, "WEBVTT\n");
    }

    #[test]
    fn merges_overlapping_cues() {
        let cues = vec![
            Cue { start: 1.0, end: 3.0, text: "a".into() },
            Cue { start: 2.5, end: 4.0, text: "b".into() },
            Cue { start: 5.0, end: 6.0, text: "c".into() },
        ];
        assert_eq!(cue_intervals(&cues), vec![(1.0, 4.0), (5.0, 6.0)]);
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(detect_format("<html><body>404</body></html>"), None);
    }

    #[test]
    fn srt_mentioning_dialogue_stays_srt() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nDialogue: that's the word\n";
        assert_eq!(detect_format(srt), Some(SubFormat::Srt));
        assert_eq!(detect_format("Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi"), Some(SubFormat::Ass));
    }

    #[test]
    fn ass_times_round_to_centiseconds() {
        assert_eq!(fmt_time(5.106, SubFormat::Ass), "0:00:05.11");
        assert_eq!(fmt_time(59.999, SubFormat::Ass), "0:01:00.00");
    }

    #[test]
    fn recognises_non_speech_cues() {
        for t in ["[music playing]", "♪ ♪", "♪♪", "(door slams)", "- [GUNFIRE]\n- (screams)", "THOM: [sighs]", "♪ Ominous music ♪", "#we will rock you#", "（笑）", "【拍手】"] {
            assert!(is_non_speech(t), "{t}");
        }
        for t in ["[sighs] Hello there.", "THOM: You're a jerk.", "- [door opens]\n- Who's there?", "I said (quietly) no", "مرحبا", "OK", "2:00 already?"] {
            assert!(!is_non_speech(t), "{t}");
        }
    }

    #[test]
    fn dialogue_intervals_skip_sound_cues() {
        let mut cues: Vec<Cue> = (0..10).map(|i| Cue { start: i as f32 * 10.0, end: i as f32 * 10.0 + 2.0, text: format!("line {i}") }).collect();
        cues.push(Cue { start: 3.0, end: 8.0, text: "[music]".into() });
        cues.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
        let iv = dialogue_intervals(&cues);
        assert_eq!(iv.len(), 10);
        assert_eq!(iv[0], (0.0, 2.0));
        // Lyrics-only subtitle: keep everything rather than nothing.
        let lyrics: Vec<Cue> = (0..10).map(|i| Cue { start: i as f32, end: i as f32 + 0.5, text: "♪ la la ♪".into() }).collect();
        assert_eq!(dialogue_intervals(&lyrics).len(), 10);
    }

    #[test]
    fn retimes_srt_vtt_and_ass() {
        let out = retime(SRT, SubFormat::Srt, |s| if s < 3.5 { (1.0, -2.0) } else { (1.0, 10.0) });
        let cues = parse(&out, SubFormat::Srt);
        assert_eq!(cues[0].start, 0.0, "clamped at zero: {out}");
        assert!((cues[0].end - 1.0).abs() < 1e-3);
        assert!((cues[1].start - 14.0).abs() < 1e-3 && (cues[1].end - 16.25).abs() < 1e-3);
        assert!(out.contains("<i>Hello</i>") && out.contains("\r\n"));
        let vtt = "WEBVTT\n\n00:01.000 --> 00:02.500 align:start\nHi\n";
        let out = retime(vtt, SubFormat::Vtt, |_| (25.0 / 24.0, 0.5));
        assert!(out.contains("00:00:01.542 --> 00:00:03.104 align:start"), "{out}");
        let ass = "[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:05.10,0:00:07.00,Default,,0,0,0,,Well, hello\n";
        let out = retime(ass, SubFormat::Ass, |_| (1.0, 61.0));
        assert!(out.contains("Dialogue: 0,0:01:06.10,0:01:08.00,Default,,0,0,0,,Well, hello\n"), "{out}");
    }
}
