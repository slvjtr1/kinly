//! Dialogue detection for Auto Sync.
//!
//! A 10 ms frame counts as dialogue when WebRTC VAD hears speech in the mid
//! (L+R) signal *and* the mid energy clearly exceeds the side (L-R) energy:
//! dialogue is mixed to the centre, while score and effects are mostly wide.
//! On real film audio (Tears of Steel, music-heavy) this raised the correlation
//! peak dominance from ~1.1 (mono VAD, wrong peak) to ~2.0 (correct peak).
//! Frames must also stand clearly above the local energy floor (energy-normalised
//! in the 200-3400 Hz voice band ffmpeg delivers), which removes steady music or
//! noise beds the VAD hears as voice and keeps mono mixes usable.
//!
//! `hysteresis` is adapted from Compass (src-tauri/src/subsync/vad.rs @ a4adad6, MIT).

pub const SR: u32 = 16000;
const FRAME_MS: f32 = 10.0;
/// Mid must carry this many times the side energy (about 5 dB).
const MIN_CENTRE_RATIO: f32 = 3.0;
/// A speech frame must stand this far above the local floor ([`above_floor`]).
/// Calibrated on Tears of Steel variants (stereo, mono, 5.1, 32 kbit/s AAC,
/// added music): the correct peak's z rose from 2.3-3.5 to 3.9-6.5 on windows
/// where the VAD alone heard the music bed as speech; shuffled subtitles stayed
/// at the same z. 6 dB kept too much of the bed, 10 dB too little dialogue.
pub const MIN_SNR_DB: f32 = 8.0;

#[derive(Clone)]
pub struct VadConfig {
    pub min_speech_ms: u32,
    pub min_silence_ms: u32,
    pub speech_pad_ms: u32,
}

impl Default for VadConfig {
    fn default() -> Self {
        VadConfig { min_speech_ms: 180, min_silence_ms: 220, speech_pad_ms: 120 }
    }
}

/// When the centre gate keeps less than this share of the frames plain VAD hears
/// as speech, the gate is treated as failed for this window (music-heavy mixes
/// with wide dialogue, phase-shifted "fake stereo") and plain VAD is used.
/// On normal film mixes the gate keeps ~80 % (Tears of Steel: 172 s of 215 s).
const MIN_GATE_KEEP: f32 = 0.35;
/// Plain VAD must hear at least this share of the window to be worth using.
const MIN_PLAIN_FRAC: f32 = 0.03;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechSource {
    /// WebRTC VAD on the mid signal above the local floor, gated by mid/side energy.
    Centre,
    /// WebRTC VAD on the mid signal above the local floor, no centre gate (fallback).
    Plain,
}

#[derive(Clone, Debug)]
pub struct Speech {
    pub intervals: Vec<(f32, f32)>,
    pub source: SpeechSource,
    /// Share of frames flagged by the gated and by the plain detector.
    pub gated_frac: f32,
    pub plain_frac: f32,
}

/// Which detector to trust for a window, from the share of frames each flagged.
pub fn choose_source(gated_frac: f32, plain_frac: f32) -> SpeechSource {
    if plain_frac >= MIN_PLAIN_FRAC && gated_frac < plain_frac * MIN_GATE_KEEP {
        SpeechSource::Plain
    } else {
        SpeechSource::Centre
    }
}

/// Per-frame measurements shared by the detectors.
pub struct Frames {
    /// WebRTC VAD on the mid signal.
    pub voice: Vec<bool>,
    /// Mid energy clearly above side energy (dialogue is mixed to the centre).
    pub centre: Vec<bool>,
    /// Mid energy in dB.
    pub mid_db: Vec<f32>,
}

pub fn frames(stereo: &[f32]) -> Frames {
    use webrtc_vad::{SampleRate, Vad, VadMode};
    let mut vad = Vad::new_with_rate_and_mode(SampleRate::Rate16kHz, VadMode::VeryAggressive);
    let frame = (SR as f32 * FRAME_MS / 1000.0) as usize;
    let mut mid = vec![0i16; frame];
    let n = stereo.len() / (frame * 2);
    let mut f = Frames { voice: Vec::with_capacity(n), centre: Vec::with_capacity(n), mid_db: Vec::with_capacity(n) };
    for chunk in stereo.chunks_exact(frame * 2) {
        let (mut em, mut es) = (0.0f32, 0.0f32);
        for (i, lr) in chunk.chunks_exact(2).enumerate() {
            let (m, s) = ((lr[0] + lr[1]) * 0.5, (lr[0] - lr[1]) * 0.5);
            em += m * m;
            es += s * s;
            mid[i] = (m.clamp(-1.0, 1.0) * 32767.0) as i16;
        }
        f.voice.push(em > 1e-9 && vad.is_voice_segment(&mid).unwrap_or(false));
        f.centre.push(em > es * MIN_CENTRE_RATIO);
        f.mid_db.push(10.0 * (em / frame as f32 + 1e-10).log10());
    }
    f
}

/// Frames standing at least `min_db` above the local noise floor: the lowest
/// 20th-percentile level of the 250 ms blocks within about ±1.5 s. Speech rises and falls by 10-20 dB with
/// each syllable, while a steady music or noise bed stays near its own floor, so
/// this keeps dialogue over a bed and drops the bed itself.
pub fn above_floor(mid_db: &[f32], min_db: f32) -> Vec<bool> {
    const BLOCK: usize = 25;
    const REACH: usize = 6;
    let floors: Vec<f32> = mid_db
        .chunks(BLOCK)
        .map(|b| {
            let mut v = b.to_vec();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            v[v.len() / 5]
        })
        .collect();
    mid_db
        .iter()
        .enumerate()
        .map(|(i, &db)| {
            let b = i / BLOCK;
            let lo = b.saturating_sub(REACH);
            let hi = (b + REACH + 1).min(floors.len());
            let floor = floors[lo..hi].iter().copied().fold(f32::MAX, f32::min);
            db - floor >= min_db
        })
        .collect()
}

/// `stereo` is interleaved L/R f32 at 16 kHz starting at `origin_sec`.
pub fn detect(stereo: &[f32], origin_sec: f32, cfg: &VadConfig) -> Speech {
    let f = frames(stereo);
    let loud = above_floor(&f.mid_db, MIN_SNR_DB);
    let plain: Vec<bool> = f.voice.iter().zip(&loud).map(|(v, l)| *v && *l).collect();
    let gated: Vec<bool> = plain.iter().zip(&f.centre).map(|(v, c)| *v && *c).collect();
    let frac = |f: &[bool]| f.iter().filter(|x| **x).count() as f32 / f.len().max(1) as f32;
    let (gated_frac, plain_frac) = (frac(&gated), frac(&plain));
    let source = choose_source(gated_frac, plain_frac);
    let flags = if source == SpeechSource::Plain { &plain } else { &gated };
    let end = origin_sec + (stereo.len() / 2) as f32 / SR as f32;
    Speech { intervals: hysteresis(flags, FRAME_MS, cfg, origin_sec, end), source, gated_frac, plain_frac }
}

/// Experimental detector variants (for calibration).
pub fn detect_variant(stereo: &[f32], origin_sec: f32, cfg: &VadConfig, variant: &str) -> Vec<(f32, f32)> {
    let f = frames(stereo);
    let end = origin_sec + (stereo.len() / 2) as f32 / SR as f32;
    let snr = |db: f32| above_floor(&f.mid_db, db);
    let flags: Vec<bool> = match variant {
        "plain" => f.voice.clone(),
        "centre" => f.voice.iter().zip(&f.centre).map(|(v, c)| *v && *c).collect(),
        v if v.starts_with("norm") || v.starts_with("cnorm") => {
            let db: f32 = v.trim_start_matches(|c: char| c.is_alphabetic()).parse().unwrap_or(6.0);
            let ok = snr(db);
            let centre = v.starts_with('c');
            (0..f.voice.len()).map(|i| f.voice[i] && ok[i] && (!centre || f.centre[i])).collect()
        }
        _ => return detect(stereo, origin_sec, cfg).intervals,
    };
    hysteresis(&flags, FRAME_MS, cfg, origin_sec, end)
}

/// Centre-gated dialogue only (no fallback).
pub fn dialogue_intervals(stereo: &[f32], origin_sec: f32, cfg: &VadConfig) -> Vec<(f32, f32)> {
    let s = detect(stereo, origin_sec, cfg);
    if s.source == SpeechSource::Centre {
        s.intervals
    } else {
        Vec::new()
    }
}

/// Turn per-frame speech flags into intervals: drop blips shorter than
/// `min_speech_ms`, bridge gaps shorter than `min_silence_ms`, pad, and merge.
pub fn hysteresis(flags: &[bool], frame_ms: f32, cfg: &VadConfig, origin_sec: f32, end_sec: f32) -> Vec<(f32, f32)> {
    if flags.is_empty() {
        return Vec::new();
    }
    let to_frames = |ms: u32| ((ms as f32 / frame_ms).round() as usize).max(1);
    let min_speech = to_frames(cfg.min_speech_ms);
    let min_sil = to_frames(cfg.min_silence_ms);
    let pad = to_frames(cfg.speech_pad_ms);
    let dt = frame_ms / 1000.0;

    let mut raw: Vec<(usize, usize)> = Vec::new();
    let mut in_speech = false;
    let mut seg_start = 0usize;
    let mut sil_run = 0usize;
    for (i, &on) in flags.iter().enumerate() {
        if on {
            if !in_speech {
                in_speech = true;
                seg_start = i;
            }
            sil_run = 0;
        } else if in_speech {
            sil_run += 1;
            if sil_run >= min_sil {
                let seg_end = i - sil_run + 1;
                if seg_end > seg_start + min_speech {
                    raw.push((seg_start, seg_end));
                }
                in_speech = false;
            }
        }
    }
    if in_speech && flags.len() > seg_start + min_speech {
        raw.push((seg_start, flags.len()));
    }

    let mut out: Vec<(f32, f32)> = Vec::new();
    for (s, e) in raw {
        let a = origin_sec + s.saturating_sub(pad) as f32 * dt;
        let b = (origin_sec + (e + pad).min(flags.len()) as f32 * dt).min(end_sec);
        if let Some(last) = out.last_mut() {
            if a <= last.1 {
                last.1 = last.1.max(b);
                continue;
            }
        }
        out.push((a, b));
    }
    out
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn flags(on: &[std::ops::Range<usize>], n: usize) -> Vec<bool> {
        (0..n).map(|i| on.iter().any(|r| r.contains(&i))).collect()
    }

    #[test]
    fn hysteresis_merges_padded_neighbors() {
        let cfg = VadConfig { speech_pad_ms: 200, min_silence_ms: 100, ..Default::default() };
        let iv = hysteresis(&flags(&[20..40, 60..80], 200), 10.0, &cfg, 0.0, 2.0);
        assert_eq!(iv.len(), 1, "padded neighbors should merge: {iv:?}");
    }

    #[test]
    fn hysteresis_drops_short_blips() {
        let iv = hysteresis(&flags(&[50..52], 200), 10.0, &VadConfig::default(), 0.0, 2.0);
        assert!(iv.is_empty(), "20ms blip should be dropped: {iv:?}");
    }

    #[test]
    fn hysteresis_offsets_to_absolute_time() {
        let cfg = VadConfig { speech_pad_ms: 0, min_speech_ms: 50, ..Default::default() };
        let iv = hysteresis(&flags(&[100..200], 300), 10.0, &cfg, 180.0, 183.0);
        assert_eq!(iv.len(), 1);
        assert!((iv[0].0 - 181.0).abs() < 0.05, "start {}", iv[0].0);
    }

    fn tone(freq: f32, secs: f32, am_hz: f32) -> Vec<f32> {
        (0..(SR as f32 * secs) as usize)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let am = 0.5 * (1.0 + (2.0 * std::f32::consts::PI * am_hz * t).sin());
                0.3 * am * (2.0 * std::f32::consts::PI * freq * t).sin()
            })
            .collect()
    }

    #[test]
    fn wide_stereo_content_is_not_dialogue() {
        // Opposite-phase channels: all energy is in the side signal.
        let mono = tone(220.0, 3.0, 4.0);
        let stereo: Vec<f32> = mono.iter().flat_map(|&x| [x, -x]).collect();
        assert!(dialogue_intervals(&stereo, 0.0, &VadConfig::default()).is_empty());
    }

    /// Voice-like test signal: a 110-190 Hz harmonic series shaped by three
    /// formants, with a 4 Hz syllable envelope, inside the given intervals.
    pub fn voice(total_sec: f32, on: &[(f32, f32)]) -> Vec<f32> {
        use std::f32::consts::PI;
        let n = (SR as f32 * total_sec) as usize;
        let mut out = vec![0f32; n];
        let mut phase = 0f32;
        for (i, x) in out.iter_mut().enumerate() {
            let t = i as f32 / SR as f32;
            let Some(&(a, _)) = on.iter().find(|&&(a, b)| t >= a && t < b) else { continue };
            let f0 = 150.0 + 40.0 * (2.0 * PI * 0.7 * (t - a)).sin();
            phase += 2.0 * PI * f0 / SR as f32;
            let mut v = 0f32;
            for k in 1..=20 {
                let f = k as f32 * f0;
                let amp: f32 = [(600.0f32, 1.0f32), (1400.0, 0.6), (2600.0, 0.3)]
                    .iter()
                    .map(|(c, g)| g * (-((f - c) / 250.0).powi(2)).exp())
                    .sum();
                v += amp * (k as f32 * phase).sin();
            }
            let syl = 0.55 + 0.45 * (2.0 * PI * 4.0 * (t - a)).sin();
            *x = 0.12 * syl * v;
        }
        out
    }

    #[test]
    fn synthetic_voice_is_detected() {
        let on = [(1.0, 3.0), (5.0, 6.5)];
        let mono = voice(8.0, &on);
        let stereo: Vec<f32> = mono.iter().flat_map(|&x| [x, x]).collect();
        let s = detect(&stereo, 0.0, &VadConfig::default());
        assert_eq!(s.source, SpeechSource::Centre);
        assert_eq!(s.intervals.len(), 2, "{:?}", s.intervals);
        assert!((s.intervals[0].0 - 1.0).abs() < 0.3 && (s.intervals[1].1 - 6.5).abs() < 0.3, "{:?}", s.intervals);
    }

    #[test]
    fn falls_back_to_plain_vad_when_the_gate_removes_the_dialogue() {
        // Dialogue panned hard left with a quiet wide bed: mid/side < 3 everywhere.
        let on = [(1.0, 3.0), (4.0, 6.0), (7.0, 9.5)];
        let v = voice(10.0, &on);
        let stereo: Vec<f32> = v.iter().flat_map(|&x| [x, 0.0]).collect();
        assert!(dialogue_intervals(&stereo, 0.0, &VadConfig::default()).is_empty());
        let s = detect(&stereo, 0.0, &VadConfig::default());
        assert_eq!(s.source, SpeechSource::Plain);
        assert_eq!(s.intervals.len(), 3, "{:?}", s.intervals);
    }

    #[test]
    fn source_choice() {
        assert_eq!(choose_source(0.30, 0.40), SpeechSource::Centre);
        assert_eq!(choose_source(0.05, 0.40), SpeechSource::Plain);
        assert_eq!(choose_source(0.0, 0.01), SpeechSource::Centre);
    }

    #[test]
    fn silence_is_empty() {
        assert!(dialogue_intervals(&vec![0.0; SR as usize * 4], 0.0, &VadConfig::default()).is_empty());
    }

    #[test]
    fn floor_gate_keeps_syllables_and_drops_a_steady_bed() {
        // 6 s steady bed at -30 dB with louder 150 ms "syllables" every 300 ms in 2..4 s.
        let db: Vec<f32> = (0..600).map(|i| if (200..400).contains(&i) && (i - 200) % 30 < 15 { -12.0 } else { -30.0 }).collect();
        let ok = above_floor(&db, MIN_SNR_DB);
        assert!(ok[..200].iter().all(|x| !x), "bed dropped");
        assert!(ok[200..215].iter().all(|x| *x), "syllable kept");
        assert!(ok[215..230].iter().all(|x| !x), "dip between syllables dropped");
    }

    #[test]
    fn voice_over_a_steady_bed_is_found() {
        let on = [(2.0, 4.0), (6.0, 7.5)];
        let v = voice(9.0, &on);
        let stereo: Vec<f32> = v
            .iter()
            .enumerate()
            .flat_map(|(i, &x)| {
                let t = i as f32 / SR as f32;
                let bed = 0.01 * (2.0 * std::f32::consts::PI * 440.0 * t).sin();
                [x + bed, x + bed]
            })
            .collect();
        let s = detect(&stereo, 0.0, &VadConfig::default());
        assert_eq!(s.intervals.len(), 2, "{:?}", s.intervals);
    }
}
