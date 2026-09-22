//! Pairing HTTP calls: exchange a one-time code for a long-lived token, and
//! revoke that token when the user unpairs.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeOk {
    pub token: String,
    pub user_id: String,
    pub device_id: String,
}

/// Exchange a pairing code (from the Host page) for a stored token.
pub async fn exchange_code(base: &str, code: &str, device_name: &str) -> Result<ExchangeOk> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{base}/api/pair/exchange"))
        .json(&serde_json::json!({ "code": code.trim(), "deviceName": device_name }))
        .send()
        .await
        .context("pair exchange request")?;
    if !res.status().is_success() {
        return Err(anyhow!("pair exchange failed with HTTP {}", res.status()));
    }
    res.json().await.context("parse pair exchange response")
}

/// Revoke this helper's own token on the server (best effort on "unpair").
pub async fn revoke(base: &str, token: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{base}/api/pair/revoke"))
        .bearer_auth(token)
        .send()
        .await
        .context("revoke request")?;
    if !res.status().is_success() {
        return Err(anyhow!("revoke failed with HTTP {}", res.status()));
    }
    Ok(())
}