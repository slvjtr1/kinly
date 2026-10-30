//! Windows video surface: mpv's own d3d11 VO in a child window under a
//! transparent WebView2.
//!
//! mpv is created with `wid=<main window HWND>`, `vo=gpu-next,gpu` and
//! `gpu-api=d3d11`. When a video starts, mpv's VO creates a child window
//! (class `mpv`) that fills the main window's client area and follows its size.
//! WebView2 is a sibling child of the same window; Kinly keeps the mpv window
//! at the bottom of the z-order and switches the WebView2 default background
//! to transparent while video is shown, so the HTML player UI composites over
//! the video exactly as the GLArea under WebKitGTK does on Linux.
//!
//! Why `wid` and not the libmpv render API: on Windows the render API only
//! offers OpenGL, which means WGL plus a `WGL_NV_DX_interop` hop for D3D11VA
//! frames (or copy-back decoding), a GL context Kinly must drive on the UI
//! thread, and no D3D11 frames for `d3d11vpp`, so no RTX Video Super Resolution.
//! The native d3d11 VO is mpv's best-tested Windows path: zero-copy D3D11VA,
//! a flip-model swap chain, its own render thread, and `d3d11vpp` works. Apps
//! that ship this layout (Compass, parts of which Kinly adapts for Linux;
//! Stremio's Windows shell) do the same.
//!
//! Stacking: a new child window is created at the top of the z-order, above
//! WebView2, so a WinEvent hook (EVENT_OBJECT_CREATE/SHOW for this process)
//! pushes every mpv child to the bottom the moment it appears; mpv events
//! re-assert it as a fallback. The mpv window also gets WS_EX_TRANSPARENT and
//! WS_EX_NOACTIVATE so it never takes input or focus from the webview.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Controller2, COREWEBVIEW2_COLOR};
use windows::core::{Interface, BOOL};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetParent, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindowAsync,
    CHILDID_SELF, EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, GWL_EXSTYLE, HWND_BOTTOM, OBJID_WINDOW, SWP_ASYNCWINDOWPOS,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNA, WINEVENT_OUTOFCONTEXT, WS_EX_NOACTIVATE,
    WS_EX_TRANSPARENT,
};

/// The app's opaque background (tauri.conf.json `backgroundColor`).
const OPAQUE: COREWEBVIEW2_COLOR = COREWEBVIEW2_COLOR { A: 255, R: 11, G: 12, B: 16 };
const CLEAR: COREWEBVIEW2_COLOR = COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 };

static MAIN: AtomicIsize = AtomicIsize::new(0);
static HOOKED: AtomicBool = AtomicBool::new(false);
static VIDEO_HIDDEN: AtomicBool = AtomicBool::new(true);

/// The `wid` value for mpv: the main window's HWND.
pub fn wid(window: &tauri::WebviewWindow) -> Result<i64, String> {
    let h = window.hwnd().map_err(|e| format!("hwnd: {e}"))?;
    Ok(h.0 as isize as i64)
}

fn main_hwnd() -> Option<HWND> {
    let v = MAIN.load(Ordering::Relaxed);
    (v != 0).then(|| HWND(v as *mut _))
}

fn is_mpv_child(hwnd: HWND) -> bool {
    let Some(main) = main_hwnd() else { return false };
    if unsafe { GetParent(hwnd) }.ok() != Some(main) {
        return false;
    }
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) }.max(0) as usize;
    let class = String::from_utf16_lossy(&buf[..n]);
    class == "mpv" || class.starts_with("mpv ")
}

/// Bottom of the z-order, no input, no activation.
fn send_to_back(hwnd: HWND) {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let want = ex | (WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0) as isize;
        if want != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
        // Async: the window belongs to mpv's VO thread; never block on it.
        let _ = SetWindowPos(hwnd, Some(HWND_BOTTOM), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
        if VIDEO_HIDDEN.load(Ordering::Relaxed) {
            let _ = ShowWindowAsync(hwnd, SW_HIDE);
        }
    }
}

unsafe extern "system" fn on_win_event(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if id_object == OBJID_WINDOW.0 && id_child == CHILDID_SELF as i32 && !hwnd.is_invalid() && is_mpv_child(hwnd) {
        send_to_back(hwnd);
    }
}

fn mpv_children() -> Vec<HWND> {
    unsafe extern "system" fn collect(hwnd: HWND, lp: LPARAM) -> BOOL {
        if is_mpv_child(hwnd) {
            (*(lp.0 as *mut Vec<isize>)).push(hwnd.0 as isize);
        }
        BOOL(1)
    }
    let Some(main) = main_hwnd() else { return vec![] };
    let mut found: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(Some(main), Some(collect), LPARAM(&mut found as *mut Vec<isize> as isize));
    }
    found.into_iter().map(|h| HWND(h as *mut _)).collect()
}

/// Remember the main window and install the stacking hook. Call on the main
/// thread (the hook's callbacks arrive through that thread's message loop).
pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let h = window.hwnd().map_err(|e| format!("hwnd: {e}"))?;
    MAIN.store(h.0 as isize, Ordering::Relaxed);
    if !HOOKED.swap(true, Ordering::SeqCst) {
        let hook = unsafe {
            SetWinEventHook(
                EVENT_OBJECT_CREATE,
                EVENT_OBJECT_SHOW,
                None,
                Some(on_win_event),
                std::process::id(),
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.is_invalid() {
            HOOKED.store(false, Ordering::SeqCst);
            crate::log_warn!("render", "SetWinEventHook failed; relying on mpv events to keep video under the UI");
        }
    }
    crate::log_info!("render", "windows: mpv renders into a child of hwnd {:#x} under the WebView2", h.0 as isize);
    Ok(())
}

/// Put any mpv window back under the webview (fallback for the hook).
pub fn restack() {
    for h in mpv_children() {
        send_to_back(h);
    }
}

fn set_webview_background(window: &tauri::WebviewWindow, color: COREWEBVIEW2_COLOR) {
    let res = window.with_webview(move |pw| unsafe {
        match pw.controller().cast::<ICoreWebView2Controller2>() {
            Ok(c2) => {
                if let Err(e) = c2.SetDefaultBackgroundColor(color) {
                    crate::log_warn!("render", "WebView2 SetDefaultBackgroundColor: {e:?}");
                }
            }
            Err(e) => crate::log_warn!("render", "WebView2 controller has no ICoreWebView2Controller2: {e:?}"),
        }
    });
    if let Err(e) = res {
        crate::log_warn!("render", "with_webview: {e:?}");
    }
}

/// Show or hide the video. Call on the main thread.
pub fn set_video_visible(window: &tauri::WebviewWindow, visible: bool) {
    VIDEO_HIDDEN.store(!visible, Ordering::Relaxed);
    set_webview_background(window, if visible { CLEAR } else { OPAQUE });
    for h in mpv_children() {
        unsafe {
            let _ = ShowWindowAsync(h, if visible { SW_SHOWNA } else { SW_HIDE });
        }
        send_to_back(h);
    }
}
