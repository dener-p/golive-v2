//! Windows system-tray icon: state tooltip + actions (open host page,
//! start/stop streaming, NAT self-test, Start-with-Windows, Quit).
//!
//! The tray needs a live Windows message loop on the thread that owns its
//! hidden window, so it lives on its own thread: create the icon, then pump
//! `PeekMessageW`/`DispatchMessageW` while draining menu + status events.
//!
//! Commands flow to the app thread via the same `Inbound` channel the WS uses;
//! the GStreamer thread publishes `TrayStatus` snapshots back here.

use std::io::Cursor;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use log::{info, warn};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

use crate::autostart;
use crate::Inbound;

/// Actions the tray menu can hand to the app thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayCmd {
    StartStream,
    StopStream,
    NatTest,
    Quit,
}

/// Status snapshot the GStreamer/app thread publishes for the tooltip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrayStatus {
    pub live: bool,
    pub viewers: usize,
    pub has_room: bool,
}

pub fn tooltip(status: TrayStatus) -> String {
    let state = if status.live { "live" } else { "idle" };
    match status.viewers {
        0 => format!("golive helper · {state}"),
        n => format!("golive helper · {state} · {n} viewer(s)"),
    }
}

/// Spawn the tray thread. Fails silently (warn) when the icon can't be built,
/// so the helper still runs fine in odd environments.
pub fn spawn(
    in_tx: tokio::sync::mpsc::UnboundedSender<Inbound>,
    status_rx: Receiver<TrayStatus>,
    base_url: String,
) {
    std::thread::Builder::new()
        .name("tray".into())
        .spawn(move || {
            if let Err(e) = tray_main(in_tx, status_rx, &base_url) {
                warn!("tray unavailable ({e:#}) — running without a tray icon");
            }
        })
        .expect("spawn tray thread");
}

fn tray_main(
    in_tx: tokio::sync::mpsc::UnboundedSender<Inbound>,
    status_rx: Receiver<TrayStatus>,
    base_url: &str,
) -> Result<()> {
    // --- build the menu ------------------------------------------------------
    let open_i = MenuItem::with_id("open", "Open host page", true, None);
    let start_i = MenuItem::with_id("start", "Start streaming", false, None);
    let stop_i = MenuItem::with_id("stop", "Stop streaming", false, None);
    let nat_i = MenuItem::with_id("nat", "NAT self-test", true, None);
    let autostart_i = CheckMenuItem::with_id(
        "autostart",
        "Start with Windows",
        true,
        autostart::enabled(),
        None,
    );
    let quit_i = MenuItem::with_id("quit", "Quit", true, None);

    let menu = Menu::new();
    menu.append_items(&[
        &open_i,
        &start_i,
        &stop_i,
        &nat_i,
        &PredefinedMenuItem::separator(),
        &autostart_i,
        &PredefinedMenuItem::separator(),
        &quit_i,
    ])
    .context("build tray menu")?;

    // --- build the tray icon (must outlive the loop) -------------------------
    let tray: TrayIcon = TrayIconBuilder::new()
        .with_tooltip("golive helper · starting…")
        .with_icon(load_icon()?)
        .with_menu(Box::new(menu))
        .build()
        .context("create tray icon")?;
    info!("tray icon ready");

    // --- pump loop -----------------------------------------------------------
    loop {
        pump_windows_messages();

        while let Ok(event) = MenuEvent::receiver().try_recv() {
            match event.id().as_ref() {
                "open" => open_host_page(base_url),
                "start" => {
                    let _ = in_tx.send(Inbound::Local(TrayCmd::StartStream));
                }
                "stop" => {
                    let _ = in_tx.send(Inbound::Local(TrayCmd::StopStream));
                }
                "nat" => {
                    let _ = in_tx.send(Inbound::Local(TrayCmd::NatTest));
                }
                "autostart" => {
                    let enable = autostart_i.is_checked();
                    match autostart::set(enable) {
                        Ok(()) => {
                            info!("autostart {}", if enable { "enabled" } else { "disabled" })
                        }
                        Err(e) => warn!("autostart toggle failed: {e:#}"),
                    }
                }
                "quit" => {
                    info!("tray: quit requested");
                    let _ = in_tx.send(Inbound::Local(TrayCmd::Quit));
                    return Ok(());
                }
                _ => {}
            }
        }

        while let Ok(status) = status_rx.try_recv() {
            let _ = tray.set_tooltip(Some(&tooltip(status)));
            start_i.set_enabled(status.has_room);
            stop_i.set_enabled(status.live);
        }

        std::thread::sleep(Duration::from_millis(40));
    }
}

/// Dispatch pending Win32 messages so the tray's hidden window stays live.
fn pump_windows_messages() {
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while unsafe { PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Embedded 32×32 RGBA icon, derived from `web/public/favicon.png` (see
/// tools/release/make-tray-icon.ps1 — regenerate there if the favicon changes).
fn load_icon() -> Result<Icon> {
    let (rgba, w, h) = decode_icon_png()?;
    Icon::from_rgba(rgba, w, h).context("build tray icon")
}

/// Decode `assets/tray.png` (embedded) into 8-bit RGBA + dimensions.
fn decode_icon_png() -> Result<(Vec<u8>, u32, u32)> {
    let bytes = include_bytes!("../assets/tray.png");
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder.read_info().context("read tray icon png")?;
    let buf_len = reader
        .output_buffer_size()
        .ok_or_else(|| anyhow!("decoder could not size the output buffer"))?;
    let mut buf = vec![0u8; buf_len];
    let info = reader.next_frame(&mut buf).context("decode tray icon")?;
    let (w, h) = (info.width as usize, info.height as usize);
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..w * h * 4].to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(w * h * 4);
            for px in buf[..w * h * 3].chunks_exact(3) {
                out.extend_from_slice(px);
                out.push(0xFF);
            }
            out
        }
        other => return Err(anyhow!("unexpected tray icon color type {other:?}")),
    };
    Ok((rgba, info.width, info.height))
}

/// Open the host page in the default browser.
fn open_host_page(base_url: &str) {
    let url = format!("{base_url}/#/host");
    if let Err(e) = std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn()
    {
        warn!("could not open host page: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltip_reflects_state_and_viewers() {
        assert_eq!(
            tooltip(TrayStatus {
                live: false,
                viewers: 0,
                has_room: false
            }),
            "golive helper · idle"
        );
        assert_eq!(
            tooltip(TrayStatus {
                live: true,
                viewers: 2,
                has_room: true
            }),
            "golive helper · live · 2 viewer(s)"
        );
    }

    #[test]
    fn embedded_icon_decodes_to_32x32_rgba() {
        let (rgba, w, h) = decode_icon_png().expect("tray icon embeds a valid png");
        assert_eq!((w, h), (32, 32));
        assert_eq!(rgba.len(), 32 * 32 * 4, "expected RGBA pixel data");
        // from_rgba must also accept it (sanity: square + <=256px).
        load_icon().expect("icon builds from the decoded png");
    }
}
