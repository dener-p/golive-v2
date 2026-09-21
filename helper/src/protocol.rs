//! Wire types for the helper <-> backend channel (`/ws/helper`).
//!
//! Mirrors `packages/shared/src/index.ts` (HelperMessage / ServerHelperMessage).
//! Client (helper) -> server messages are `Client`; server -> helper messages
//! are `Server`. Room media signaling rides this same socket (helper is host).

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdpMessage {
    #[serde(rename = "type")]
    pub sdp_type: String,
    pub sdp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IceCandidate {
    pub candidate: String,
    #[serde(rename = "sdpMid")]
    pub sdp_mid: Option<String>,
    #[serde(rename = "sdpMLineIndex")]
    pub sdp_mline_index: Option<u32>,
    #[serde(rename = "usernameFragment")]
    pub username_fragment: Option<String>,
}

impl IceCandidate {
    pub fn full_candidate(candidate: String, mline: u32) -> Self {
        Self {
            candidate,
            sdp_mid: Some(format!("video{mline}")),
            sdp_mline_index: Some(mline),
            username_fragment: None,
        }
    }
}

/// Helper -> server.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Client {
    Hello { version: String },
    Status { state: String, detail: Option<String> },
    Ack {
        id: String,
        ok: bool,
        state: String,
        detail: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    AttachRoom { room_id: String },
    DetachRoom,
    #[serde(rename_all = "camelCase")]
    RoomSdp {
        room_id: String,
        peer_id: String,
        sdp: SdpMessage,
    },
    #[serde(rename_all = "camelCase")]
    RoomIce {
        room_id: String,
        peer_id: String,
        candidate: IceCandidate,
    },
}

impl Client {
    pub fn ack(id: &str, ok: bool, state: &str, detail: Option<String>) -> Self {
        Client::Ack {
            id: id.to_string(),
            ok,
            state: state.to_string(),
            detail,
        }
    }
}

/// The `start` command payload carries the room the helper should host.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartPayload {
    pub room_id: Option<String>,
    #[allow(dead_code)]
    pub viewer_count: Option<u32>,
}

/// Mirrors `IceServerInfo` from the shared protocol: `urls` may be a single
/// string or an array. `username`/`credential` are only present for TURN
/// servers (used by later milestones).
#[derive(Debug, Clone, Deserialize)]
pub struct IceServer {
    pub urls: Json,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

impl IceServer {
    /// Flatten `urls` (string or list of strings) into a Vec of URL strings.
    pub fn stun_urls(&self) -> Vec<String> {
        match &self.urls {
            Json::Array(items) => items
                .iter()
                .filter_map(|u| u.as_str().map(String::from))
                .collect(),
            Json::String(single) => vec![single.clone()],
            _ => Vec::new(),
        }
    }
}

/// Server -> helper.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Server {
    #[serde(rename_all = "camelCase")]
    HelloAck {
        server_time: String,
        #[serde(default)]
        ice_servers: Option<Vec<IceServer>>,
    },
    Ping,
    Command {
        id: String,
        command: String,
        payload: Option<Json>,
    },
    #[serde(rename_all = "camelCase")]
    AttachAck {
        ok: bool,
        room_id: Option<String>,
        viewer_count: Option<u32>,
        viewers: Option<Vec<String>>,
        error: Option<Json>,
    },
    #[serde(rename_all = "camelCase")]
    PeerJoined { room_id: String, peer_id: String },
    #[serde(rename_all = "camelCase")]
    PeerLeft { room_id: String, peer_id: String },
    #[serde(rename_all = "camelCase")]
    RoomSdp {
        room_id: String,
        peer_id: String,
        sdp: SdpMessage,
    },
    #[serde(rename_all = "camelCase")]
    RoomIce {
        room_id: String,
        peer_id: String,
        candidate: IceCandidate,
    },
}

pub fn parse_server(raw: &str) -> Option<Server> {
    serde_json::from_str::<Server>(raw).ok()
}