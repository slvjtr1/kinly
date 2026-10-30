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
    // Windows (MSVC): load libmpv-2.dll on first use instead of at process start, so a missing or
    // blocked DLL (an incomplete install, or a security program that removed it) is reported in
    // the app by player::engine_available() instead of the loader refusing to start Kinly.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:libmpv-2.dll");
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
    }
    tauri_build::build()
}
