//! Path helpers with no app state (unit tested): command-line file arguments, folder
//! de-duplication and release "sample" detection.

use std::path::{Path, PathBuf};

/// The first argument (after the program name) that names an existing file. Relative paths are
/// resolved against `cwd`, the directory the command was started in: for a second instance that
/// forwards its arguments, that is not this process's own working directory. `file://` URLs are
/// decoded (`%20` and so on).
pub fn video_arg(args: &[String], cwd: &Path) -> Option<String> {
    args.iter().skip(1).find_map(|a| {
        let p = if a.starts_with("file://") {
            reqwest::Url::parse(a).ok()?.to_file_path().ok()?
        } else {
            let p = PathBuf::from(a);
            if p.is_absolute() {
                p
            } else {
                cwd.join(p)
            }
        };
        let p = std::path::absolute(&p).unwrap_or(p);
        p.is_file().then(|| p.display().to_string())
    })
}

/// The existing directories among `dirs`, each once. On case-insensitive file systems (Windows,
/// macOS) `Subs` and `subs` are the same folder.
pub fn unique_dirs(dirs: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|d| d.is_dir())
        .filter(|d| seen.insert(std::fs::canonicalize(d).unwrap_or_else(|_| d.clone())))
        .collect()
}

/// A release's preview clip: "sample" as a whole word of the file name (`movie-sample.mkv`,
/// `Sample.Movie.mkv`), or a `Sample`/`Samples` folder between `root` and the file. Titles that
/// merely contain the letters ("The Sampler", "Free Samples") are not samples.
pub fn is_sample(path: &Path, root: &Path) -> bool {
    let word = |s: &str| s.split(|c: char| !c.is_alphanumeric()).any(|t| t.eq_ignore_ascii_case("sample"));
    if path.file_stem().map(|s| word(&s.to_string_lossy())).unwrap_or(false) {
        return true;
    }
    let inside = path.parent().and_then(|p| p.strip_prefix(root).ok());
    inside.is_some_and(|rel| {
        rel.components().any(|c| {
            let c = c.as_os_str().to_string_lossy();
            c.eq_ignore_ascii_case("sample") || c.eq_ignore_ascii_case("samples")
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kinly-paths-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn args(a: &[&str]) -> Vec<String> {
        std::iter::once("kinly").chain(a.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn resolves_relative_paths_against_the_callers_directory() {
        let d = tmp("rel");
        std::fs::create_dir_all(d.join("shows")).unwrap();
        std::fs::write(d.join("shows").join("ep 1.mkv"), b"x").unwrap();
        let got = video_arg(&args(&["--flag", "shows/ep 1.mkv"]), &d).expect("found");
        assert_eq!(PathBuf::from(got), std::path::absolute(d.join("shows").join("ep 1.mkv")).unwrap());
        // Not found relative to some other directory.
        assert_eq!(video_arg(&args(&["shows/ep 1.mkv"]), &d.join("shows")), None);
    }

    #[test]
    fn accepts_absolute_paths_and_file_urls() {
        let d = tmp("abs");
        let f = d.join("my movie.mkv");
        std::fs::write(&f, b"x").unwrap();
        let elsewhere = std::env::temp_dir();
        assert_eq!(video_arg(&args(&[&f.display().to_string()]), &elsewhere).map(PathBuf::from), Some(f.clone()));
        let url = reqwest::Url::from_file_path(&f).unwrap().to_string();
        assert!(url.contains("%20"));
        assert_eq!(video_arg(&args(&[&url]), &elsewhere).map(PathBuf::from), Some(f));
    }

    #[test]
    fn ignores_the_program_name_folders_and_missing_files() {
        let d = tmp("none");
        assert_eq!(video_arg(&[d.display().to_string()], &d), None);
        assert_eq!(video_arg(&args(&[&d.display().to_string(), "missing.mkv", "file://%zz"]), &d), None);
    }

    #[test]
    fn lists_each_folder_once() {
        let d = tmp("dirs");
        std::fs::create_dir_all(d.join("Subs")).unwrap();
        let case_insensitive = d.join("subs").is_dir();
        let got = unique_dirs(["Subs", "subs", "Subtitles"].map(|s| d.join(s)));
        assert_eq!(got.len(), 1, "{got:?}");
        assert!(case_insensitive || got[0].ends_with("Subs"));
        assert_eq!(unique_dirs([d.clone(), d.join("."), d.join("missing")]).len(), 1);
    }

    #[test]
    fn detects_samples_by_word_or_folder() {
        let root = Path::new("/media/dl");
        for p in ["/media/dl/Movie.2020.1080p-sample.mkv", "/media/dl/sample-movie.mkv", "/media/dl/Movie/Sample/movie.mkv", "/media/dl/x/SAMPLES/a.mkv"] {
            assert!(is_sample(Path::new(p), root), "{p}");
        }
        for p in ["/media/dl/The.Sampler.2021.mkv", "/media/dl/Free Samples (2012).mkv", "/media/dl/Sampled/a.mkv", "/media/dl/a.mkv"] {
            assert!(!is_sample(Path::new(p), root), "{p}");
        }
        // A library that itself lives in a folder called "Samples" is not skipped.
        assert!(!is_sample(Path::new("/home/me/Samples/Movie.mkv"), Path::new("/home/me/Samples")));
    }
}
