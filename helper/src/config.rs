//! Local helper config: `%APPDATA%\golive\config.json`.
//!
//! The paired token is a long-lived bearer credential exchanged from a
//! one-time pairing code (see server/src/tokens.ts). The helper keeps it on
//! disk so it can reconnect to `/ws/helper` without user interaction.

use std::env;
use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Backend used when nothing (env/config) says otherwise.
pub const DEFAULT_BASE_URL: &str = "https://golive.puhl.dev";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct HelperConfig {
    pub base_url: String,
    pub token: String,
}

pub fn config_dir() -> Result<PathBuf> {
    let base = env::var("APPDATA")
        .or_else(|_| env::var("HOME"))
        .context("neither APPDATA nor HOME is set")?;
    Ok(PathBuf::from(base).join("golive"))
}

pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.json"))
}

pub fn load() -> Option<HelperConfig> {
    let path = config_path().ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save(config: &HelperConfig) -> Result<()> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).context("create config directory")?;
    let raw = serde_json::to_string_pretty(config).context("serialize config")?;
    fs::write(dir.join("config.json"), raw).context("write config.json")?;
    Ok(())
}

pub fn remove() -> Result<()> {
    let path = config_path()?;
    if path.exists() {
        fs::remove_file(&path).context("remove config.json")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json() {
        let cfg = HelperConfig {
            base_url: "http://localhost:3000".into(),
            token: "abc.def_123".into(),
        };
        let raw = serde_json::to_string(&cfg).unwrap();
        let back: HelperConfig = serde_json::from_str(&raw).unwrap();
        assert_eq!(cfg, back);
        assert!(!raw.contains("baseUrl")); // serde keeps snake_case
    }

    #[test]
    fn default_base_url_is_the_public_backend() {
        assert!(DEFAULT_BASE_URL.starts_with("https://"));
    }

    #[test]
    fn config_path_is_named_config_json() {
        if let Ok(p) = config_path() {
            assert_eq!(p.file_name().map(|s| s.to_string_lossy().into_owned()), Some("config.json".into()));
        }
    }
}