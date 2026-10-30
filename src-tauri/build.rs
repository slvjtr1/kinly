fn main() {
    // libmpv2-sys links `mpv`. Linux finds libmpv.so through the system or
    // scripts/env.sh. On Windows, point KINLY_MPV_DIR at the folder holding the
    // import library: `mpv.lib` for MSVC (generated from libmpv-2.dll by
    // scripts/fetch-windows-deps.ps1) or `libmpv.dll.a` for GNU.
    println!("cargo:rerun-if-env-changed=KINLY_MPV_DIR");
    if let Ok(dir) = std::env::var("KINLY_MPV_DIR") {
        if !dir.is_empty() {
            println!("cargo:rustc-link-search=native={dir}");
        }
    }
    tauri_build::build()
}
