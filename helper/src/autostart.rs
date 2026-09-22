//! "Start with Windows": an HKCU Run entry pointing at this exe.
//!
//! Uses `reg.exe` (present on every Windows), operating on the current user's
//! hive — no admin rights needed. A portable exe path is stored verbatim (and
//! quoted), which is why the value breaks if the folder later moves; the tray
//! toggle shows the live state, so it's self-correcting.

use std::process::Command;

use anyhow::{bail, Context, Result};

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "golive-helper";

/// Whether the Run entry currently exists.
pub fn enabled() -> bool {
    Command::new("reg")
        .args(["query", RUN_KEY, "/v", VALUE_NAME])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// Add (when `true`) or remove the Run entry.
pub fn set(enabled: bool) -> Result<()> {
    if enabled {
        let exe = std::env::current_exe().context("current exe")?;
        let quoted = format!("\"{}\"", exe.display());
        let out = Command::new("reg")
            .args(["add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d"])
            .arg(&quoted)
            .arg("/f")
            .output()
            .context("run `reg add`")?;
        if !out.status.success() {
            bail!(
                "reg add failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
    } else {
        let out = Command::new("reg")
            .args(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"])
            .output()
            .context("run `reg delete`")?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if stderr.contains("unable to find") {
                return Ok(()); // value already absent
            }
            bail!("reg delete failed: {}", stderr.trim());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_name_and_key_are_stable() {
        assert_eq!(VALUE_NAME, "golive-helper");
        assert!(RUN_KEY.contains("CurrentVersion\\Run"));
    }
}
