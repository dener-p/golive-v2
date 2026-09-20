/**
 * Shared protocol + API types for golive.
 *
 * Consumed by the signaling backend (Bun/Hono), the web frontend (Vite), and the
 * native helper (future). All JSON-over-WebSocket/REST payloads are described here.
 */

// ---------------------------------------------------------------------------
// Identities & rooms
// ---------------------------------------------------------------------------

export interface PublicUser {
  id: string;
  username: string;
  avatar: string | null;
}

export interface RoomInfo {
  roomId: string;
  hostId: string;
  hostName: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helper presence
// ---------------------------------------------------------------------------

export type HelperState = 'idle' | 'live' | 'error';

/** Result of the most recent host→helper command, as acked by the helper. */
export interface LastCommandResult {
  id: string;
  command: string;
  ok: boolean;
  detail?: string;
  state?: HelperState;
  at: string;
}

export interface HelperStatus {
  connected: boolean;
  lastSeenAt: string | null;
  state: HelperState | null;
  /** Version string from the helper's `hello` handshake. */
  helperVersion?: string | null;
  lastCommand?: LastCommandResult | null;
}

// ---------------------------------------------------------------------------
// ICE servers handed to WebRTC peers
// ---------------------------------------------------------------------------

export interface IceServerInfo {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceServersResponse {
  iceServers: IceServerInfo[];
  turnConfigured: boolean;
}

export interface TurnConfigRequest {
  urls: string[];
  username: string;
  credential: string;
}

export interface IceRetryState {
  attempt: number;
  maxAttempts: number;
  turnAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Room signaling (browser / helper <-> server over /ws)
// ---------------------------------------------------------------------------

export type Role = 'host' | 'viewer';

export interface SdpMessage {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp: string;
}

export interface IceCandidateMessage {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

export type ClientSignal =
  | { type: 'join'; roomId: string; role: Role; peerId: string }
  | { type: 'sdp'; roomId: string; sdp: SdpMessage; target?: string }
  | { type: 'ice'; roomId: string; candidate: IceCandidateMessage; target?: string }
  | { type: 'leave' };

export type ServerSignal =
  | {
      type: 'joined';
      roomId: string;
      role: Role;
      peerId: string;
      viewerCount: number;
      /** Existing viewer peerIds — only populated when role === 'host'. */
      viewers?: string[];
    }
  | { type: 'peer-joined'; roomId: string; role: Role; peerId: string }
  | { type: 'peer-left'; roomId: string; role: Role; peerId: string }
  | { type: 'sdp'; roomId: string; from: Role; peerId: string; sdp: SdpMessage }
  | { type: 'ice'; roomId: string; from: Role; peerId: string; candidate: IceCandidateMessage }
  | { type: 'error'; code: string; message: string };

export type ServerErrorCode =
  | 'unauthorized'
  | 'room_not_found'
  | 'not_room_host'
  | 'host_already_connected'
  | 'bad_request';

// ---------------------------------------------------------------------------
// Helper channel (persistent /ws/helper) and control relay
// ---------------------------------------------------------------------------

export type HelperMessage =
  | { type: 'hello'; version: string }
  | { type: 'status'; state: HelperState; detail?: string }
  | {
      /** Per-command acknowledgement, keyed by the `id` from `ServerHelperMessage.command`. */
      type: 'ack';
      id: string;
      ok: boolean;
      state?: HelperState;
      detail?: string;
    }
  | { type: 'attach-room'; roomId: string }
  | { type: 'detach-room'; roomId?: string }
  | {
      /** Host→viewer SDP: `peerId` is the target viewer (helper acts as room host). */
      type: 'room-sdp';
      roomId: string;
      peerId: string;
      sdp: SdpMessage;
    }
  | {
      /** Host→viewer ICE: `peerId` is the target viewer. */
      type: 'room-ice';
      roomId: string;
      peerId: string;
      candidate: IceCandidateMessage;
    };

export type ServerHelperMessage =
  | { type: 'hello-ack'; serverTime: string }
  | { type: 'ping' }
  | { type: 'command'; id: string; command: string; payload?: unknown }
  | {
      type: 'attach-ack';
      ok: boolean;
      roomId?: string;
      viewerCount?: number;
      viewers?: string[];
      error?: { code: string; message: string };
    }
  | { type: 'peer-joined'; roomId: string; peerId: string }
  | { type: 'peer-left'; roomId: string; peerId: string }
  | { type: 'room-sdp'; roomId: string; peerId: string; sdp: SdpMessage }
  | { type: 'room-ice'; roomId: string; peerId: string; candidate: IceCandidateMessage };

export interface CommandRequest {
  command: string;
  payload?: unknown;
}