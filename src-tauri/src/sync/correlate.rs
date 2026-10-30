//! Speech/cue alignment.
//!
//! Model: `audio_time = ratio * cue_time + offset` (mpv applies this exactly as
//! `sub-speed = ratio`, `sub-delay = offset`). For each candidate frame-rate
//! ratio, every analysis window gets its own offset estimate by FFT
//! cross-correlation of the speech mask against the (rescaled) cue mask. A fit is
//! accepted only when enough windows agree, which separates a constant offset or
//! standard fps drift from timing that changes in other ways (different cut).
//!
//! The FFT cross-correlation (`fft_xcorr`) and the peak statistics are adapted
//! from Compass (src-tauri/src/subsync/correlate.rs @ a4adad6, Copyright (c) 2026
//! Compass, MIT; see THIRD_PARTY_NOTICES.md); windowing, zero-mean weighting and
//! the multi-window consensus are Kinly's.

use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

pub const GRID_HZ: f32 = 100.0;
// Acceptance gates, calibrated on real film audio (examples/synccal.rs): correct
// alignments vs. 40 shuffled-timing subtitles per window. NCC is reported but not
// used as a gate: it did not separate correct from wrong subtitles.
/// One window must stand on its own (used for media shorter than 15 minutes).
const SINGLE: (f32, f32) = (3.8, 1.55);
/// With several windows, each passes a looser gate and two or more must agree.
const MULTI: (f32, f32) = (3.0, 1.2);
/// Window offsets within this many seconds count as agreeing.
const AGREE_SEC: f32 = 0.3;
/// Below this the subtitle is already in sync.
pub const ALIGNED_SEC: f32 = 0.12;

/// Identity first: ties go to "no drift".
pub const RATIOS: &[f32] = &[
    1.0,
    25.0 / 23.976,
    23.976 / 25.0,
    25.0 / 24.0,
    24.0 / 25.0,
    24.0 / 23.976,
    23.976 / 24.0,
];

#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub start: f32,
    pub len: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct WindowFit {
    pub offset: f32,
    pub z: f32,
    pub dominance: f32,
    pub ncc: f32,
}

impl WindowFit {
    fn passes(&self, gate: (f32, f32)) -> bool {
        self.z >= gate.0 && self.dominance >= gate.1
    }
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Fit {
        offset: f32,
        ratio: f32,
        /// Mean peak z-score of the agreeing windows.
        strength: f32,
        agreeing: usize,
        window_offsets: Vec<Option<f32>>,
        reason: String,
    },
    /// Different offsets in consecutive parts of the video (a cut that differs:
    /// an extra recap, intro or ad break). mpv cannot apply this; the subtitle
    /// is rewritten instead.
    Piecewise {
        ratio: f32,
        segments: Vec<Segment>,
        strength: f32,
        agreeing: usize,
        window_offsets: Vec<Option<f32>>,
        reason: String,
    },
    /// Windows locked on clearly but disagree: not a constant offset or fps drift.
    Inconsistent { window_offsets: Vec<Option<f32>>, reason: String },
    /// Not enough evidence in the audio.
    Uncertain { reason: String },
}

impl Outcome {
    pub fn uncertain(reason: impl Into<String>) -> Outcome {
        Outcome::Uncertain { reason: reason.into() }
    }
    pub fn reason_mut(&mut self) -> &mut String {
        match self {
            Outcome::Fit { reason, .. }
            | Outcome::Piecewise { reason, .. }
            | Outcome::Inconsistent { reason, .. }
            | Outcome::Uncertain { reason } => reason,
        }
    }
    /// The correction as a map from subtitle time to `(ratio, offset)`.
    pub fn mapping(&self) -> Option<Box<dyn Fn(f32) -> (f32, f32) + Send + Sync>> {
        match self {
            Outcome::Fit { offset, ratio, .. } => {
                let (r, o) = (*ratio, *offset);
                Some(Box::new(move |_| (r, o)))
            }
            Outcome::Piecewise { ratio, segments, .. } => {
                let (r, segs) = (*ratio, segments.clone());
                Some(Box::new(move |s| (r, segment_offset(&segs, s))))
            }
            _ => None,
        }
    }
}

/// Part of a piecewise correction: from subtitle time `from_sec` on (until the
/// next segment), `audio = ratio * sub + offset`.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub from_sec: f32,
    pub offset: f32,
}

pub fn segment_offset(segments: &[Segment], sub_time: f32) -> f32 {
    segments.iter().rev().find(|g| sub_time >= g.from_sec).or(segments.first()).map(|g| g.offset).unwrap_or(0.0)
}

/// Windows at least this long may be trusted alone (calibration: 240 s windows
/// never produced a false peak passing [`SINGLE`]; 120 s windows did).
pub const MIN_SINGLE_WINDOW_SEC: f32 = 240.0;

pub fn ratio_label(r: f32) -> &'static str {
    const NAMES: [(f32, &str); 7] = [
        (1.0, "1"),
        (25.0 / 23.976, "25/23.976"),
        (23.976 / 25.0, "23.976/25"),
        (25.0 / 24.0, "25/24"),
        (24.0 / 25.0, "24/25"),
        (24.0 / 23.976, "24/23.976"),
        (23.976 / 24.0, "23.976/24"),
    ];
    NAMES.iter().find(|(v, _)| (v - r).abs() < 1e-6).map(|(_, n)| *n).unwrap_or("custom")
}

fn raster(intervals: &[(f32, f32)], ratio: f32, origin: f32, n: usize, hz: f32) -> Vec<f32> {
    let mut m = vec![0f32; n];
    for &(a, b) in intervals {
        let s = ((a * ratio - origin) * hz).round();
        let e = ((b * ratio - origin) * hz).round();
        if e <= 0.0 || s >= n as f32 {
            continue;
        }
        for x in &mut m[s.max(0.0) as usize..(e as usize).min(n)] {
            *x = 1.0;
        }
    }
    m
}

/// `res[max_lag + l] = sum_i a[i + l] * b[i]`.
fn fft_xcorr(a: &[f32], b: &[f32], max_lag: usize) -> Vec<f32> {
    let n = a.len().max(b.len());
    let m = (n + max_lag + 1).next_power_of_two();
    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(m);
    let inv = planner.plan_fft_inverse(m);
    let mut abuf = fwd.make_input_vec();
    let mut bbuf = fwd.make_input_vec();
    abuf[..a.len()].copy_from_slice(a);
    bbuf[..b.len()].copy_from_slice(b);
    let mut aspec = fwd.make_output_vec();
    let mut bspec = fwd.make_output_vec();
    if fwd.process(&mut abuf, &mut aspec).is_err() || fwd.process(&mut bbuf, &mut bspec).is_err() {
        return vec![0f32; 2 * max_lag + 1];
    }
    let mut prod: Vec<Complex<f32>> = aspec.iter().zip(&bspec).map(|(&x, &y)| x * y.conj()).collect();
    let mut out = inv.make_output_vec();
    if inv.process(&mut prod, &mut out).is_err() {
        return vec![0f32; 2 * max_lag + 1];
    }
    let norm = m as f32;
    let mut res = vec![0f32; 2 * max_lag + 1];
    for l in 0..=max_lag {
        res[max_lag + l] = out[l] / norm;
        if l > 0 {
            res[max_lag - l] = out[m - l] / norm;
        }
    }
    res
}

/// Peak index, z-score of the peak, and peak / best value at least 1 s away.
fn peak_stats(corr: &[f32], hz: f32) -> (usize, f32, f32) {
    let (pidx, peak) = corr
        .iter()
        .copied()
        .enumerate()
        .fold((0, f32::MIN), |acc, (i, v)| if v > acc.1 { (i, v) } else { acc });
    let n = corr.len() as f32;
    let mean = corr.iter().sum::<f32>() / n;
    let std = (corr.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / n).sqrt().max(1e-9);
    let guard = hz as usize;
    let second = corr
        .iter()
        .enumerate()
        .filter(|(i, _)| i + guard < pidx || *i > pidx + guard)
        .map(|(_, v)| *v)
        .fold(f32::MIN, f32::max);
    let dominance = if second > 1e-6 { peak / second } else { f32::INFINITY };
    (pidx, (peak - mean) / std, dominance)
}

/// Pearson correlation of the speech window against the cue mask at `lag`.
fn ncc_window(a: &[f32], b: &[f32], lo: usize, hi: usize, lag: isize) -> f32 {
    let idx = |i: usize| i as isize - lag;
    let pairs = (lo..hi).filter(|&i| idx(i) >= 0 && (idx(i) as usize) < b.len());
    let (mut sx, mut sy, mut cnt) = (0.0f32, 0.0f32, 0.0f32);
    for i in pairs.clone() {
        sx += a[i];
        sy += b[idx(i) as usize];
        cnt += 1.0;
    }
    if cnt < 1.0 {
        return 0.0;
    }
    let (mx, my) = (sx / cnt, sy / cnt);
    let (mut xy, mut xx, mut yy) = (0.0f32, 0.0f32, 0.0f32);
    for i in pairs {
        let dx = a[i] - mx;
        let dy = b[idx(i) as usize] - my;
        xy += dx * dy;
        xx += dx * dx;
        yy += dy * dy;
    }
    let d = (xx * yy).sqrt();
    if d < 1e-9 {
        0.0
    } else {
        xy / d
    }
}

/// Coarse grid for the wide lag search; peaks are then refined on [`GRID_HZ`].
pub const COARSE_HZ: f32 = 20.0;

/// Offset of one window: a wide search on a coarse grid (peak statistics are
/// taken from this curve), then the peak is refined at 10 ms resolution.
pub fn estimate_window(
    speech: &[(f32, f32)],
    cues: &[(f32, f32)],
    ratio: f32,
    w: Window,
    max_lag_sec: f32,
) -> Option<WindowFit> {
    let coarse = correlate_at(speech, cues, ratio, w, max_lag_sec, COARSE_HZ)?;
    let (pidx, z, dominance) = peak_stats(&coarse.corr, COARSE_HZ);
    let coarse_lag = (pidx as f32 - coarse.max_lag as f32) / COARSE_HZ;
    // Refine: 100 Hz rasters, direct correlation within ±1 coarse step.
    let fine = Grid::new(w, coarse_lag.abs() + 0.2, GRID_HZ);
    let mut a = fine.raster(speech, 1.0);
    let b = fine.raster(cues, ratio);
    fine.zero_mean(&mut a);
    let centre = (coarse_lag * GRID_HZ).round() as isize;
    let step = (GRID_HZ / COARSE_HZ).ceil() as isize;
    let mut best = (centre, f32::MIN);
    for lag in centre - step..=centre + step {
        let v = fine.dot(&a, &b, lag);
        if v > best.1 + 1e-6 || (v >= best.1 - 1e-6 && (lag - centre).abs() < (best.0 - centre).abs()) {
            best = (lag, v);
        }
    }
    let plain = fine.raster(speech, 1.0);
    Some(WindowFit {
        offset: best.0 as f32 / GRID_HZ,
        z,
        dominance,
        ncc: ncc_window(&plain, &b, fine.lo, fine.hi, best.0),
    })
}

/// A raster over a window plus `max_lag` on each side.
struct Grid {
    origin: f32,
    n: usize,
    lo: usize,
    hi: usize,
    hz: f32,
}

impl Grid {
    fn new(w: Window, max_lag_sec: f32, hz: f32) -> Grid {
        let origin = w.start - max_lag_sec;
        let n = ((w.len + 2.0 * max_lag_sec) * hz).ceil() as usize;
        let lo = (max_lag_sec * hz) as usize;
        let hi = (lo + (w.len * hz) as usize).min(n);
        Grid { origin, n, lo, hi, hz }
    }
    fn raster(&self, iv: &[(f32, f32)], ratio: f32) -> Vec<f32> {
        raster(iv, ratio, self.origin, self.n, self.hz)
    }
    /// Zero-mean the speech inside the window (zero outside); returns the speech share.
    fn zero_mean(&self, a: &mut [f32]) -> f32 {
        let frac = a[self.lo..self.hi].iter().sum::<f32>() / (self.hi - self.lo).max(1) as f32;
        for (i, x) in a.iter_mut().enumerate() {
            *x = if (self.lo..self.hi).contains(&i) { *x - frac } else { 0.0 };
        }
        frac
    }
    /// `sum_i a[i + lag] * b[i]` (a = speech, b = cues: cues shifted by `lag`).
    fn dot(&self, a: &[f32], b: &[f32], lag: isize) -> f32 {
        let mut v = 0.0;
        for i in self.lo..self.hi {
            let j = i as isize - lag;
            if j >= 0 && (j as usize) < b.len() {
                v += a[i] * b[j as usize];
            }
        }
        v
    }
}

struct Curve {
    corr: Vec<f32>,
    max_lag: usize,
}

fn correlate_at(speech: &[(f32, f32)], cues: &[(f32, f32)], ratio: f32, w: Window, max_lag_sec: f32, hz: f32) -> Option<Curve> {
    let g = Grid::new(w, max_lag_sec, hz);
    let mut a = g.raster(speech, 1.0);
    let b = g.raster(cues, ratio);
    let speech_frac = a[g.lo..g.hi].iter().sum::<f32>() / (g.hi - g.lo).max(1) as f32;
    if speech_frac < 0.02 || b.iter().all(|&v| v == 0.0) {
        return None;
    }
    // Zero-mean inside the window so lags that land on denser cue regions are
    // not favoured just for having more cue frames.
    g.zero_mean(&mut a);
    let max_lag = (max_lag_sec * hz) as usize;
    Some(Curve { corr: fft_xcorr(&a, &b, max_lag), max_lag })
}

fn median(v: &mut [f32]) -> f32 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = v.len() / 2;
    if v.len() % 2 == 0 {
        (v[m - 1] + v[m]) / 2.0
    } else {
        v[m]
    }
}

/// Largest set of window fits passing `gate` that agree with each other.
fn consensus(fits: &[Option<WindowFit>], gate: (f32, f32)) -> Vec<WindowFit> {
    let good: Vec<WindowFit> = fits.iter().flatten().filter(|f| f.passes(gate)).copied().collect();
    let mut best: Vec<WindowFit> = Vec::new();
    for anchor in &good {
        let group: Vec<WindowFit> =
            good.iter().filter(|f| (f.offset - anchor.offset).abs() <= AGREE_SEC).copied().collect();
        if group.len() > best.len() {
            best = group;
        }
    }
    best
}

struct Candidate {
    ratio: f32,
    group: Vec<WindowFit>,
    offsets: Vec<Option<f32>>,
    /// [`joint_score`] at the group's median offset.
    joint: f32,
}

impl Candidate {
    fn mean_z(&self) -> f32 {
        self.group.iter().map(|f| f.z).sum::<f32>() / self.group.len().max(1) as f32
    }
}

/// A non-identity ratio must explain this much more speech than "no drift" to win a tie.
const JOINT_MARGIN: f32 = 0.03;

/// Tie-break between ratios with the same number of agreeing windows: the one
/// whose single common offset explains the most speech over all windows.
/// Close ratios (25/24 vs 25/23.976, 1 vs 24/23.976) give the same per-window
/// offsets within the agreement tolerance, but only the true one keeps every
/// line aligned from the first window to the last.
fn beats(cand: &Candidate, best: &Candidate) -> bool {
    let margin = if best.ratio == 1.0 { JOINT_MARGIN } else { 0.0 };
    cand.joint > best.joint * (1.0 + margin) + 1e-6
}

/// Mean zero-mean speech/cue overlap of all windows at one common offset,
/// searched within ±0.3 s of `offset` (10 ms steps). Returns (offset, score).
pub fn joint_score(windows: &[(Window, Vec<(f32, f32)>)], cues: &[(f32, f32)], ratio: f32, offset: f32) -> (f32, f32) {
    const REACH: isize = (0.3 * GRID_HZ) as isize;
    let centre = (offset * GRID_HZ).round() as isize;
    let mut total = vec![0f32; (2 * REACH + 1) as usize];
    let mut samples = 0usize;
    for (w, speech) in windows {
        let g = Grid::new(*w, offset.abs() + 0.5, GRID_HZ);
        let mut a = g.raster(speech, 1.0);
        let b = g.raster(cues, ratio);
        g.zero_mean(&mut a);
        samples += g.hi - g.lo;
        for (k, t) in total.iter_mut().enumerate() {
            *t += g.dot(&a, &b, centre - REACH + k as isize);
        }
    }
    let (k, best) = total.iter().copied().enumerate().fold((REACH as usize, f32::MIN), |acc, (k, v)| if v > acc.1 { (k, v) } else { acc });
    ((centre - REACH + k as isize) as f32 / GRID_HZ, best / samples.max(1) as f32)
}

/// Fit `audio = ratio * cue + offset` over the analysed windows.
///
/// Every candidate frame-rate ratio is scored; the winner has the most agreeing
/// windows, then the best [`joint_score`]. A non-identity ratio must beat "no
/// drift" by [`JOINT_MARGIN`] on a tie, so identity wins when the data cannot tell.
/// With several windows and no agreeing pair, one window that passes the strict
/// single-window gate on its own still gives a constant offset, unless another
/// window clearly locked onto a different offset.
pub fn solve(windows: &[(Window, Vec<(f32, f32)>)], cues: &[(f32, f32)], max_lag_sec: f32) -> Outcome {
    if windows.is_empty() {
        return Outcome::uncertain("no speech was detected in the analysed audio");
    }
    if cues.is_empty() {
        return Outcome::uncertain("the subtitle has no timed lines");
    }
    let multi = windows.len() > 1;
    let (gate, required) = if multi { (MULTI, 2) } else { (SINGLE, 1) };
    let mut best: Option<Candidate> = None;
    let mut identity: Vec<Option<WindowFit>> = Vec::new();
    let mut strongest = 0.0f32;
    for &ratio in RATIOS {
        let fits: Vec<Option<WindowFit>> = windows
            .iter()
            .map(|(w, speech)| estimate_window(speech, cues, ratio, *w, max_lag_sec))
            .collect();
        strongest = fits.iter().flatten().map(|f| f.z).fold(strongest, f32::max);
        if std::env::var_os("KINLY_SYNC_DEBUG").is_some() {
            let list: Vec<String> = fits
                .iter()
                .zip(windows)
                .map(|(f, (w, _))| match f {
                    Some(f) => format!("{:.0}+{:.0}: {:+.2} z{:.1} d{:.2}", w.start, w.len, f.offset, f.z, f.dominance),
                    None => format!("{:.0}: -", w.start),
                })
                .collect();
            eprintln!("ratio {:<10} {}", ratio_label(ratio), list.join(" | "));
        }
        let offsets: Vec<Option<f32>> = fits.iter().map(|f| f.filter(|f| f.passes(gate)).map(|f| f.offset)).collect();
        let group = consensus(&fits, gate);
        if ratio == 1.0 {
            identity = fits;
        }
        if group.len() < required {
            continue;
        }
        let mut offs: Vec<f32> = group.iter().map(|f| f.offset).collect();
        let joint = joint_score(windows, cues, ratio, median(&mut offs)).1;
        let cand = Candidate { ratio, group, offsets, joint };
        let better = match &best {
            None => true,
            Some(b) => cand.group.len() > b.group.len() || (cand.group.len() == b.group.len() && beats(&cand, b)),
        };
        if better {
            best = Some(cand);
        }
    }
    if let Some(c) = best {
        let mut offs: Vec<f32> = c.group.iter().map(|f| f.offset).collect();
        let offset = median(&mut offs);
        let drift = if c.ratio == 1.0 { String::new() } else { format!(" with frame-rate drift {}", ratio_label(c.ratio)) };
        return Outcome::Fit {
            offset,
            ratio: c.ratio,
            strength: c.mean_z(),
            agreeing: c.group.len(),
            reason: format!("{} of {} windows agree on {offset:+.2} s{drift}", c.group.len(), windows.len()),
            window_offsets: c.offsets,
        };
    }
    let measurable = identity.iter().flatten().count();
    if measurable == 0 {
        return Outcome::uncertain("too little speech in the analysed audio (music, effects or silence)");
    }
    let passing: Vec<(usize, WindowFit)> =
        identity.iter().enumerate().filter_map(|(i, f)| f.filter(|f| f.passes(MULTI)).map(|f| (i, f))).collect();
    let offsets: Vec<Option<f32>> = identity.iter().map(|f| f.filter(|f| f.passes(MULTI)).map(|f| f.offset)).collect();
    if multi {
        // One long window strong enough on its own: a constant offset, unless
        // another window clearly locked onto a different one. Identity only: with
        // every ratio allowed, a shuffled-timing control passed at 25/23.976
        // (validation matrix), and short local files are analysed whole instead.
        let mut strong: Option<(f32, WindowFit, Vec<Option<WindowFit>>)> = None;
        for &ratio in &RATIOS[..1] {
            let fits: Vec<Option<WindowFit>> = if ratio == 1.0 {
                identity.clone()
            } else {
                windows.iter().map(|(w, sp)| estimate_window(sp, cues, ratio, *w, max_lag_sec)).collect()
            };
            let top = fits
                .iter()
                .enumerate()
                .filter_map(|(i, f)| f.filter(|f| windows[i].0.len >= MIN_SINGLE_WINDOW_SEC && f.passes(SINGLE)))
                .max_by(|a, b| a.z.total_cmp(&b.z));
            if let Some(f) = top {
                if strong.as_ref().is_none_or(|(_, s, _)| f.z > s.z + 0.3) {
                    strong = Some((ratio, f, fits));
                }
            }
        }
        if let Some((ratio, f, fits)) = strong {
            let at_ratio: Vec<WindowFit> = fits.iter().flatten().filter(|o| o.passes(MULTI)).copied().collect();
            let contradicted = at_ratio.iter().any(|o| (o.offset - f.offset).abs() > AGREE_SEC);
            if !contradicted {
                let drift = if ratio == 1.0 { String::new() } else { format!(" with frame-rate drift {}", ratio_label(ratio)) };
                return Outcome::Fit {
                    offset: f.offset,
                    ratio,
                    strength: f.z,
                    agreeing: 1,
                    reason: format!(
                        "constant offset {:+.2} s from one clear window{drift}; the other {} were unclear",
                        f.offset,
                        windows.len() - 1
                    ),
                    window_offsets: fits.iter().map(|f| f.filter(|f| f.passes(MULTI)).map(|f| f.offset)).collect(),
                };
            }
        }
        if passing.len() >= 2 {
            let list = passing.iter().map(|(_, f)| format!("{:+.1} s", f.offset)).collect::<Vec<_>>().join(", ");
            return Outcome::Inconsistent {
                window_offsets: offsets,
                reason: format!("windows locked onto different offsets ({list}): timing changes across the video (another cut?)"),
            };
        }
    }
    let why = if multi {
        format!("no two windows agree and none is clear alone; best peak z {strongest:.1}")
    } else {
        format!("best peak z {strongest:.1}, needs {:.1}", gate.0)
    };
    Outcome::uncertain(format!("dialogue does not line up clearly with this subtitle ({why}); wrong subtitle or too little dialogue"))
}

/// Consecutive windows sharing one offset.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub offset: f32,
    /// Indices into the (time-ordered) windows.
    pub windows: Vec<usize>,
}

/// Windows that lock onto two or more offsets, each in one consecutive stretch.
#[derive(Clone, Debug)]
pub struct Split {
    pub ratio: f32,
    pub runs: Vec<Run>,
}

fn has_evidence(run: &Run, fits: &[Option<WindowFit>], windows: &[(Window, Vec<(f32, f32)>)]) -> bool {
    run.windows.len() >= 2
        || run.windows.iter().any(|&i| fits[i].is_some_and(|f| f.passes(SINGLE)) && windows[i].0.len >= MIN_SINGLE_WINDOW_SEC)
}

/// Group passing windows (time-ordered) by offset; `None` unless every group is
/// one consecutive stretch. Lone windows of a weak group that break the order
/// are treated as chance peaks and dropped.
fn runs_of(fits: &[Option<WindowFit>], windows: &[(Window, Vec<(f32, f32)>)]) -> Option<Vec<Run>> {
    let passing: Vec<(usize, f32)> =
        fits.iter().enumerate().filter_map(|(i, f)| f.filter(|f| f.passes(MULTI)).map(|f| (i, f.offset))).collect();
    let mut centres: Vec<f32> = Vec::new();
    let mut labels: Vec<(usize, usize)> = Vec::new();
    for &(i, o) in &passing {
        let c = match centres.iter().position(|c| (c - o).abs() <= AGREE_SEC) {
            Some(c) => c,
            None => {
                centres.push(o);
                centres.len() - 1
            }
        };
        labels.push((i, c));
    }
    let build = |labels: &[(usize, usize)]| -> Option<Vec<Run>> {
        let mut runs: Vec<(usize, Vec<usize>)> = Vec::new();
        for &(i, c) in labels {
            match runs.last_mut() {
                Some((lc, ws)) if *lc == c => ws.push(i),
                _ => {
                    if runs.iter().any(|(lc, _)| *lc == c) {
                        return None;
                    }
                    runs.push((c, vec![i]));
                }
            }
        }
        Some(
            runs.into_iter()
                .map(|(_, ws)| {
                    let mut offs: Vec<f32> = ws.iter().filter_map(|&i| fits[i].map(|f| f.offset)).collect();
                    Run { offset: median(&mut offs), windows: ws }
                })
                .collect(),
        )
    };
    build(&labels).or_else(|| {
        let size = |c: usize| labels.iter().filter(|l| l.1 == c).count();
        let strong: Vec<(usize, usize)> = labels
            .iter()
            .copied()
            .filter(|&(i, c)| size(c) >= 2 || fits[i].is_some_and(|f| f.passes(SINGLE)) && windows[i].0.len >= MIN_SINGLE_WINDOW_SEC)
            .collect();
        build(&strong)
    })
}

/// A candidate split for [`solve_piecewise`] to verify (with more audio between
/// the stretches): windows that lock onto different offsets in time order.
/// `windows` must be sorted by start.
pub fn propose_split(windows: &[(Window, Vec<(f32, f32)>)], cues: &[(f32, f32)], max_lag_sec: f32) -> Option<Split> {
    let mut best: Option<(usize, Split)> = None;
    for &ratio in RATIOS {
        let fits: Vec<Option<WindowFit>> =
            windows.iter().map(|(w, sp)| estimate_window(sp, cues, ratio, *w, max_lag_sec)).collect();
        let Some(runs) = runs_of(&fits, windows) else { continue };
        if runs.len() < 2 || runs.len() > 4 || !runs.iter().any(|r| has_evidence(r, &fits, windows)) {
            continue;
        }
        let n: usize = runs.iter().map(|r| r.windows.len()).sum();
        if best.as_ref().is_none_or(|(bn, _)| n > *bn) {
            best = Some((n, Split { ratio, runs }));
        }
    }
    best.map(|(_, s)| s)
}

/// Total time `speech` covers inside [a, b] (speech sorted, non-overlapping).
fn covered(speech: &[(f32, f32)], a: f32, b: f32) -> f32 {
    let start = speech.partition_point(|iv| iv.1 <= a);
    speech[start..].iter().take_while(|iv| iv.0 < b).map(|&(s, e)| (e.min(b) - s.max(a)).max(0.0)).sum()
}

/// Zero-mean agreement of one mapped cue [a, b] with the analysed speech.
fn cue_gain(windows: &[(Window, Vec<(f32, f32)>, f32)], a: f32, b: f32) -> f32 {
    windows
        .iter()
        .map(|(w, sp, frac)| {
            let (a, b) = (a.max(w.start), b.min(w.start + w.len));
            if b <= a {
                0.0
            } else {
                covered(sp, a, b) - frac * (b - a)
            }
        })
        .sum()
}

/// Verify a split on all analysed audio and place the boundaries.
///
/// Every window is re-estimated at the split's ratio. The stretches must still
/// be consecutive, each backed like a constant fit (two agreeing windows, or one
/// long window passing the strict gate), and each boundary is put between the
/// two cues where switching offsets explains the speech best. The piecewise
/// model must also explain clearly more speech than the best constant offset.
pub fn solve_piecewise(windows: &[(Window, Vec<(f32, f32)>)], cues: &[(f32, f32)], ratio: f32, max_lag_sec: f32) -> Option<Outcome> {
    let fits: Vec<Option<WindowFit>> =
        windows.iter().map(|(w, sp)| estimate_window(sp, cues, ratio, *w, max_lag_sec)).collect();
    let runs = runs_of(&fits, windows)?;
    if runs.len() < 2 || !runs.iter().all(|r| has_evidence(r, &fits, windows)) {
        return None;
    }
    let with_frac: Vec<(Window, Vec<(f32, f32)>, f32)> = windows
        .iter()
        .map(|(w, sp)| (*w, sp.clone(), covered(sp, w.start, w.start + w.len) / w.len.max(1e-3)))
        .collect();
    let gain = |k: usize, o: f32| cue_gain(&with_frac, ratio * cues[k].0 + o, ratio * cues[k].1 + o);
    let mut segments = vec![Segment { from_sec: 0.0, offset: runs[0].offset }];
    for pair in runs.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        let lo_audio = windows[*a.windows.last()?].0.start;
        let hi_audio = { let w = windows[b.windows[0]].0; w.start + w.len };
        let lo = (lo_audio - a.offset) / ratio;
        let hi = (hi_audio - b.offset) / ratio;
        let ks: Vec<usize> = (0..cues.len()).filter(|&k| cues[k].0 >= lo && cues[k].0 <= hi).collect();
        if ks.is_empty() {
            return None;
        }
        let ga: Vec<f32> = ks.iter().map(|&k| gain(k, a.offset)).collect();
        let gb: Vec<f32> = ks.iter().map(|&k| gain(k, b.offset)).collect();
        // score(j): cues ks[..j] use a, ks[j..] use b.
        let total_b: f32 = gb.iter().sum();
        let (mut acc, mut best, mut best_j) = (total_b, total_b, vec![0usize]);
        for j in 1..=ks.len() {
            acc += ga[j - 1] - gb[j - 1];
            if acc > best + 1e-4 {
                best = acc;
                best_j = vec![j];
            } else if (acc - best).abs() <= 1e-4 {
                best_j.push(j);
            }
        }
        let j = best_j[best_j.len() / 2];
        let from = if j == 0 {
            cues[ks[0]].0 - 0.05
        } else if j == ks.len() {
            cues[ks[j - 1]].1 + 0.05
        } else {
            (cues[ks[j - 1]].1 + cues[ks[j]].0) / 2.0
        };
        segments.push(Segment { from_sec: from.max(segments.last()?.from_sec + 0.01), offset: b.offset });
    }
    // Compare with the best constant offset on the same audio.
    let score = |f: &dyn Fn(usize) -> f32| -> f32 { (0..cues.len()).map(|k| gain(k, f(k))).sum() };
    let piecewise = score(&|k| segment_offset(&segments, cues[k].0));
    let constant = runs.iter().map(|r| score(&|_| r.offset)).fold(f32::MIN, f32::max);
    if std::env::var_os("KINLY_SYNC_DEBUG").is_some() {
        eprintln!("piecewise score {piecewise:.1} vs constant {constant:.1}; segments {segments:?}");
    }
    if piecewise - constant < 4.0 {
        return None;
    }
    let group: Vec<WindowFit> = runs.iter().flat_map(|r| r.windows.iter().filter_map(|&i| fits[i])).collect();
    let strength = group.iter().map(|f| f.z).sum::<f32>() / group.len().max(1) as f32;
    let drift = if ratio == 1.0 { String::new() } else { format!(" with frame-rate drift {}", ratio_label(ratio)) };
    let parts = segments
        .iter()
        .map(|g| format!("{:+.2} s from {}", g.offset, clock(g.from_sec)))
        .collect::<Vec<_>>()
        .join(", ");
    Some(Outcome::Piecewise {
        ratio,
        strength,
        agreeing: group.len(),
        window_offsets: fits.iter().map(|f| f.filter(|f| f.passes(MULTI)).map(|f| f.offset)).collect(),
        reason: format!("timing changes during the video: {parts}{drift}"),
        segments,
    })
}

pub fn clock(sec: f32) -> String {
    let s = sec.max(0.0).round() as u32;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Deterministic irregular dialogue pattern over `total` seconds.
    pub fn cue_pattern(total: f32) -> Vec<(f32, f32)> {
        let mut seed: u32 = 12345;
        let mut rnd = || {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            (seed >> 8) as f32 / (1u32 << 24) as f32
        };
        let mut t = 3.0;
        let mut v = Vec::new();
        while t < total {
            let d = 0.8 + rnd() * 3.2;
            v.push((t, t + d));
            t += d + 0.3 + rnd() * rnd() * 9.0;
        }
        v
    }

    /// Speech derived from cues via `audio = r*cue + b`, with VAD-like errors:
    /// boundary jitter, dropped lines, and extra non-dialogue noise.
    pub fn speech_from(cues: &[(f32, f32)], r: f32, b: f32, w: Window) -> Vec<(f32, f32)> {
        let mut out = Vec::new();
        for (i, &(s, e)) in cues.iter().enumerate() {
            if i % 7 == 3 {
                continue;
            }
            let j = ((i * 37) % 11) as f32 * 0.02 - 0.1;
            let (s, e) = (r * s + b + j, r * e + b - j);
            if e > w.start && s < w.start + w.len {
                out.push((s.max(w.start), e.min(w.start + w.len)));
            }
        }
        let mut t = w.start + 5.0;
        while t < w.start + w.len {
            out.push((t, t + 0.6));
            t += 23.0;
        }
        out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        out
    }

    fn three(total: f32) -> Vec<Window> {
        [0.15, 0.5, 0.8].iter().map(|f| Window { start: total * f, len: 90.0 }).collect()
    }

    fn run(r: f32, b: f32) -> Outcome {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let ws: Vec<_> = three(total).into_iter().map(|w| (w, speech_from(&cues, r, b, w))).collect();
        solve(&ws, &cues, 90.0)
    }

    fn fit(o: &Outcome) -> (f32, f32) {
        match o {
            Outcome::Fit { offset, ratio, .. } => (*offset, *ratio),
            other => panic!("expected fit, got {other:?}"),
        }
    }

    #[test]
    fn recovers_positive_offset() {
        let (o, r) = fit(&run(1.0, 7.3));
        assert!((o - 7.3).abs() < 0.08, "offset {o}");
        assert_eq!(r, 1.0);
    }

    #[test]
    fn recovers_negative_offset() {
        let (o, _) = fit(&run(1.0, -42.6));
        assert!((o + 42.6).abs() < 0.08, "offset {o}");
    }

    #[test]
    fn already_aligned_stays_zero() {
        let (o, r) = fit(&run(1.0, 0.0));
        assert!(o.abs() < ALIGNED_SEC, "offset {o}");
        assert_eq!(r, 1.0);
    }

    #[test]
    fn recovers_pal_drift_with_offset() {
        let r_true = 25.0 / 23.976;
        let (o, r) = fit(&run(r_true, 2.0));
        assert!((r - r_true).abs() < 1e-4, "ratio {r}");
        assert!((o - 2.0).abs() < 0.1, "offset {o}");
    }

    #[test]
    fn recovers_inverse_drift() {
        let r_true = 23.976 / 25.0;
        let (_, r) = fit(&run(r_true, -1.0));
        assert!((r - r_true).abs() < 1e-4, "ratio {r}");
    }

    #[test]
    fn different_offsets_per_window_are_inconsistent() {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let ws: Vec<_> = three(total)
            .into_iter()
            .zip([0.0f32, 15.0, 31.0])
            .map(|(w, b)| (w, speech_from(&cues, 1.0, b, w)))
            .collect();
        assert!(matches!(solve(&ws, &cues, 90.0), Outcome::Inconsistent { .. }));
    }

    #[test]
    fn continuous_speech_has_no_structure() {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let ws: Vec<_> = three(total).into_iter().map(|w| (w, vec![(w.start, w.start + w.len)])).collect();
        assert!(matches!(solve(&ws, &cues, 90.0), Outcome::Uncertain { .. }));
    }

    #[test]
    fn unrelated_subtitle_is_rejected() {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let other: Vec<(f32, f32)> = cue_pattern(total * 1.37).iter().map(|&(a, b)| (a * 0.73 + 11.0, b * 0.73 + 11.0)).collect();
        let ws: Vec<_> = three(total).into_iter().map(|w| (w, speech_from(&other, 1.0, 0.0, w))).collect();
        assert!(!matches!(solve(&ws, &cues, 90.0), Outcome::Fit { .. }));
    }

    #[test]
    fn every_listed_ratio_is_recovered() {
        for &r_true in &RATIOS[1..] {
            let (o, r) = fit(&run(r_true, -3.0));
            assert!((r - r_true).abs() < 1e-5, "want {r_true}, got {r}");
            assert!((o + 3.0).abs() < 0.1, "ratio {r_true}: offset {o}");
        }
    }

    #[test]
    fn one_strong_long_window_gives_a_constant_offset() {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let ws: Vec<_> = [0.15f32, 0.5, 0.8]
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let w = Window { start: total * f, len: 300.0 };
                // Only the first window has dialogue; the others hear continuous music.
                let speech = if i == 0 { speech_from(&cues, 1.0, 5.5, w) } else { vec![(w.start, w.start + w.len)] };
                (w, speech)
            })
            .collect();
        match solve(&ws, &cues, 90.0) {
            Outcome::Fit { offset, ratio, agreeing, reason, .. } => {
                assert!((offset - 5.5).abs() < 0.1, "offset {offset}");
                assert_eq!((ratio, agreeing), (1.0, 1));
                assert!(reason.contains("one clear window"), "{reason}");
            }
            other => panic!("expected fit, got {other:?}"),
        }
    }

    #[test]
    fn no_speech_is_uncertain_with_a_reason() {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let ws: Vec<_> = three(total).into_iter().map(|w| (w, Vec::new())).collect();
        match solve(&ws, &cues, 90.0) {
            Outcome::Uncertain { reason } => assert!(reason.contains("too little speech"), "{reason}"),
            other => panic!("expected uncertain, got {other:?}"),
        }
        assert!(matches!(solve(&[], &cues, 90.0), Outcome::Uncertain { .. }));
    }

    /// Speech for a video whose audio has `b1` before audio time `at` and `b2` after.
    fn piecewise_speech(cues: &[(f32, f32)], at: f32, b1: f32, b2: f32, w: Window) -> Vec<(f32, f32)> {
        let mut a = speech_from(cues, 1.0, b1, w);
        a.retain(|iv| iv.1 <= at);
        let mut b = speech_from(cues, 1.0, b2, w);
        b.retain(|iv| iv.0 >= at);
        a.extend(b);
        a
    }

    #[test]
    fn piecewise_offset_is_split_and_placed() {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let (at, b1, b2) = (2500.0, 1.5, 16.0);
        let plan: Vec<Window> = (0..5).map(|i| Window { start: 200.0 + i as f32 * 1000.0, len: 300.0 }).collect();
        let ws: Vec<_> = plan.iter().map(|&w| (w, piecewise_speech(&cues, at, b1, b2, w))).collect();
        let split = propose_split(&ws, &cues, 90.0).expect("split proposed");
        assert_eq!(split.runs.len(), 2, "{split:?}");
        // Audio between the stretches, as the driver decodes it.
        let mut all = ws.clone();
        for k in 0..4 {
            let w = Window { start: 2500.0 + k as f32 * 175.0, len: 175.0 };
            all.push((w, piecewise_speech(&cues, at, b1, b2, w)));
        }
        all.sort_by(|a, b| a.0.start.total_cmp(&b.0.start));
        match solve_piecewise(&all, &cues, 1.0, 90.0) {
            Some(Outcome::Piecewise { segments, ratio, .. }) => {
                assert_eq!(ratio, 1.0);
                assert_eq!(segments.len(), 2, "{segments:?}");
                assert!((segments[0].offset - b1).abs() < 0.1 && (segments[1].offset - b2).abs() < 0.1, "{segments:?}");
                // Every cue lands on its audio time.
                let wrong = cues
                    .iter()
                    .filter(|&&(s, _)| {
                        let t = if s + b1 < at { s + b1 } else { s + b2 };
                        let truth_side = if s + b2 >= at { s + b2 } else { s + b1 };
                        let mapped = s + segment_offset(&segments, s);
                        (mapped - t).abs() > 0.15 && (mapped - truth_side).abs() > 0.15
                    })
                    .count();
                assert!(wrong <= 2, "{wrong} cues misplaced; {segments:?}");
            }
            other => panic!("expected piecewise, got {other:?}"),
        }
    }

    #[test]
    fn constant_offset_is_not_split() {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let plan: Vec<Window> = (0..5).map(|i| Window { start: 200.0 + i as f32 * 1000.0, len: 300.0 }).collect();
        let ws: Vec<_> = plan.iter().map(|&w| (w, speech_from(&cues, 1.0, 4.0, w))).collect();
        assert!(propose_split(&ws, &cues, 90.0).is_none());
        assert!(solve_piecewise(&ws, &cues, 1.0, 90.0).is_none());
    }

    #[test]
    fn unrelated_subtitle_is_not_split() {
        let total = 5400.0;
        let cues = cue_pattern(total);
        let other: Vec<(f32, f32)> = cue_pattern(total * 1.37).iter().map(|&(a, b)| (a * 0.73 + 11.0, b * 0.73 + 11.0)).collect();
        let ws: Vec<_> = (0..12)
            .map(|i| Window { start: i as f32 * 440.0, len: 300.0 })
            .map(|w| (w, speech_from(&other, 1.0, 0.0, w)))
            .collect();
        assert!(solve_piecewise(&ws, &cues, 1.0, 90.0).is_none());
    }

    #[test]
    fn segment_lookup() {
        let g = [Segment { from_sec: 0.0, offset: 1.0 }, Segment { from_sec: 100.0, offset: 5.0 }];
        assert_eq!(segment_offset(&g, -3.0), 1.0);
        assert_eq!(segment_offset(&g, 99.9), 1.0);
        assert_eq!(segment_offset(&g, 100.0), 5.0);
        assert_eq!(clock(3725.0), "1:02:05");
    }
}
