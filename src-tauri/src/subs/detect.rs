//! Lightweight content checks on downloaded subtitle text: which script and
//! language the text is really in (catches mislabeled tracks, such as Persian
//! files tagged Arabic) and how much of it is SDH annotation.

use super::parse::Cue;
use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ContentInfo {
    /// ISO 639-2 code when the script identifies a language well enough
    /// ("ara", "fas", "urd", "heb", "ell", "kor", "jpn", "zho", "tha", "rus"), else null.
    pub language: Option<&'static str>,
    /// Dominant script: arabic, latin, cyrillic, hebrew, greek, cjk, hangul, thai, other.
    pub script: &'static str,
    /// Share of letters in the dominant script (0..1).
    pub confidence: f32,
    /// Share of cues that look like SDH annotations ([door creaks], ♪, SPEAKER:).
    #[serde(rename = "sdhRatio")]
    pub sdh_ratio: f32,
}

fn script_of(c: char) -> Option<&'static str> {
    let u = c as u32;
    Some(match u {
        0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF => "arabic",
        0x0590..=0x05FF => "hebrew",
        0x0370..=0x03FF => "greek",
        0x0400..=0x04FF => "cyrillic",
        0x0E00..=0x0E7F => "thai",
        0xAC00..=0xD7AF | 0x1100..=0x11FF => "hangul",
        0x3040..=0x30FF => "kana",
        0x4E00..=0x9FFF => "cjk",
        _ if c.is_alphabetic() && (c.is_ascii() || (0x00C0..=0x024F).contains(&u)) => "latin",
        _ => return None,
    })
}

pub fn analyze(cues: &[Cue]) -> ContentInfo {
    use std::collections::HashMap;
    let mut counts: HashMap<&'static str, usize> = HashMap::new();
    // Letters that distinguish Persian and Urdu from Arabic.
    let (mut persian, mut urdu, mut arabic_only) = (0usize, 0usize, 0usize);
    let mut sdh = 0usize;
    for cue in cues.iter().take(4000) {
        if is_sdh_line(&cue.text) {
            sdh += 1;
        }
        for c in cue.text.chars() {
            if let Some(s) = script_of(c) {
                *counts.entry(s).or_insert(0) += 1;
            }
            match c {
                'پ' | 'چ' | 'ژ' | 'گ' | 'ی' | 'ک' => persian += 1,
                'ے' | 'ں' | 'ٹ' | 'ڈ' | 'ڑ' | 'ھ' => urdu += 1,
                'ي' | 'ك' | 'ة' | 'ى' => arabic_only += 1,
                _ => {}
            }
        }
    }
    let total: usize = counts.values().sum();
    let (script, n) = counts
        .iter()
        .max_by_key(|(_, n)| **n)
        .map(|(s, n)| (*s, *n))
        .unwrap_or(("other", 0));
    let confidence = if total > 0 { n as f32 / total as f32 } else { 0.0 };
    let script = if script == "kana" { "cjk" } else { script };
    let language = match script {
        "arabic" => {
            if urdu > arabic_only && urdu > persian / 2 {
                Some("urd")
            } else if persian > arabic_only {
                Some("fas")
            } else {
                Some("ara")
            }
        }
        "hebrew" => Some("heb"),
        "greek" => Some("ell"),
        "hangul" => Some("kor"),
        "thai" => Some("tha"),
        "cjk" => {
            if counts.get("kana").copied().unwrap_or(0) * 10 > n {
                Some("jpn")
            } else {
                Some("zho")
            }
        }
        _ => None,
    };
    ContentInfo {
        language,
        script,
        confidence,
        sdh_ratio: if cues.is_empty() { 0.0 } else { sdh as f32 / cues.len().min(4000) as f32 },
    }
}

fn is_sdh_line(text: &str) -> bool {
    let t = text.trim();
    if t.contains('♪') || t.contains('♫') {
        return true;
    }
    let bracketed = (t.starts_with('[') && t.contains(']')) || (t.starts_with('(') && t.contains(')'));
    if bracketed {
        return true;
    }
    // "JOHN: line" speaker labels in capitals.
    if let Some((label, _)) = t.split_once(':') {
        let letters: Vec<char> = label.chars().filter(|c| c.is_alphabetic()).collect();
        if letters.len() >= 2 && label.len() <= 24 && letters.iter().all(|c| c.is_uppercase()) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cues(lines: &[&str]) -> Vec<Cue> {
        lines.iter().enumerate().map(|(i, t)| Cue { start: i as f32, end: i as f32 + 0.5, text: t.to_string() }).collect()
    }

    #[test]
    fn detects_arabic() {
        let i = analyze(&cues(&["مرحبا، كيف حالك؟", "هذه جملة عربية طويلة مع أرقام ١٢٣ و 456", "OK يا صديقي"]));
        assert_eq!(i.script, "arabic");
        assert_eq!(i.language, Some("ara"));
        assert!(i.confidence > 0.8);
    }

    #[test]
    fn distinguishes_persian_mislabeled_as_arabic() {
        let i = analyze(&cues(&["سلام، چطوری؟", "من فکر می‌کنم که این خیلی خوبه", "کجا می‌ری؟ پیش دوستم"]));
        assert_eq!(i.language, Some("fas"));
    }

    #[test]
    fn latin_has_no_language_claim() {
        let i = analyze(&cues(&["Hello there", "How are you?"]));
        assert_eq!(i.script, "latin");
        assert_eq!(i.language, None);
    }

    #[test]
    fn measures_sdh() {
        let i = analyze(&cues(&["[door creaks]", "JOHN: Who's there?", "♪ music ♪", "Nobody."]));
        assert!((i.sdh_ratio - 0.75).abs() < 1e-3, "{}", i.sdh_ratio);
    }
}
