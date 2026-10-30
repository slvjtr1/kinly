//! Calibrate Auto Sync on real media: peak statistics for the correct subtitle
//! (should be accepted) vs. shuffled-timing subtitles (must be rejected), per
//! speech-detector variant.
//!
//!   cargo run --release --example synccal -- <media> <correct.srt> <variants,comma> <start+len>...
//!
//! Variants: plain, centre, auto (the shipped detector), normN / cnormN (VAD and
//! N dB above the local floor; `c` also requires the centre gate).
use kinly_lib::subs::parse;
use kinly_lib::sync::{correlate::{estimate_window, Window}, extract, vad};
use std::collections::HashMap;
use std::time::Duration;

fn shuffled(cues: &[(f32, f32)], seed: u32) -> Vec<(f32, f32)> {
    let mut s = seed.wrapping_mul(2654435761).wrapping_add(1);
    let mut rnd = || { s = s.wrapping_mul(1103515245).wrapping_add(12345); (s >> 8) as f32 / (1u32 << 24) as f32 };
    let mut durs: Vec<f32> = cues.iter().map(|(a, b)| b - a).collect();
    let mut gaps: Vec<f32> = cues.windows(2).map(|w| (w[1].0 - w[0].1).max(0.1)).collect();
    for i in (1..durs.len()).rev() { let j = (rnd() * (i + 1) as f32) as usize; durs.swap(i, j.min(i)); }
    for i in (1..gaps.len()).rev() { let j = (rnd() * (i + 1) as f32) as usize; gaps.swap(i, j.min(i)); }
    let mut t = cues[0].0;
    let mut out = Vec::new();
    for (i, d) in durs.iter().enumerate() { out.push((t, t + d)); t += d + gaps.get(i).copied().unwrap_or(1.0); }
    out
}

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (media, srt) = (&a[1], &a[2]);
    let variants: Vec<&str> = a[3].split(',').collect();
    let (text, _) = parse::decode(&std::fs::read(srt).unwrap());
    let cues = parse::dialogue_intervals(&parse::parse(&text, parse::detect_format(&text).unwrap()));
    let cfg = vad::VadConfig::default();
    let windows: Vec<Window> = a[4..].iter().map(|w| { let (s, l) = w.split_once('+').unwrap(); Window { start: s.parse().unwrap(), len: l.parse().unwrap() } }).collect();
    let lag = std::env::var("MAX_LAG").ok().and_then(|v| v.parse().ok()).unwrap_or(90.0f32);
    for w in &windows {
        let pair = extract::decode_dialogue_pair(media, &HashMap::new(), None, w.start, w.len, Duration::from_secs(120)).await.unwrap();
        for v in &variants {
            let sp = vad::detect_variant(&pair, w.start, &cfg, v);
            let cover = sp.iter().map(|(a, b)| b - a).sum::<f32>() / w.len;
            let mut good = Vec::new();
            for b in [0.0f32, -7.25, 23.0] {
                let sh: Vec<(f32, f32)> = cues.iter().map(|&(s, e)| (s - b, e - b)).collect();
                match estimate_window(&sp, &sh, 1.0, *w, lag) {
                    Some(f) => good.push(format!("{}z{:.1}/d{:.2}", if (f.offset - b).abs() < 0.2 { "ok ".to_string() } else { format!("BAD{:+.2}", f.offset - b) }, f.z, f.dominance)),
                    None => good.push("none".into()),
                }
            }
            let (mut fz, mut fd) = (Vec::new(), Vec::new());
            for seed in 0..30 {
                if let Some(f) = estimate_window(&sp, &shuffled(&cues, seed), 1.0, *w, lag) { fz.push(f.z); fd.push(f.dominance); }
            }
            let mx = |v: &Vec<f32>| v.iter().cloned().fold(0.0f32, f32::max);
            println!("{:>5.0}+{:<4.0} {:<8} speech {:>3.0}% | {} | shuffled max z {:.1} dom {:.2}", w.start, w.len, v, cover * 100.0, good.join(" "), mx(&fz), mx(&fd));
        }
    }
}
