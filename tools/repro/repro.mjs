// Headless-Chrome viewer reproduction harness for the golive black-screen bug.
// Repo copy = the M7 NAT regression matrix runner.
// Usage: bun repro.mjs [--room roomId] [--trials N] [--seconds S]
//                     [--label "network id"] [--json results.jsonl]
//
// Drives the real backend on http://localhost:3000 and the real Vite app on
// http://localhost:5173, starts the native helper streaming, then opens the
// watch page in headless Chrome and samples getStats() + <video> playback.
//
// Matrix recording: pass --label plus --json and every trial is appended as
// one JSON line: { ts, label, room, trial, result, path, rttMs, rxBytes, fps }.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = 'http://localhost:3000';
const WEB = 'http://localhost:5173';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
let roomId = flag('--room');
const trials = Number(flag('--trials')) || 1;
const seconds = Number(flag('--seconds')) || 24;
const label = flag('--label') ?? 'unlabeled';
const jsonFile = flag('--json');
let trialIndex = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Backend helpers (Bun fetch does not keep cookies; we pass them manually)
// ---------------------------------------------------------------------------
let cookie = '';

async function api(path, init = {}) {
  const res = await fetch(SERVER + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/session=[^;]+/);
    if (m) cookie = m[0];
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function ensureSetup() {
  const login = await api('/auth/dev', { method: 'POST' });
  if (login.status !== 200) throw new Error(`dev login failed: ${login.status} ${JSON.stringify(login.body)}`);
  if (!roomId) {
    const created = await api('/api/rooms', { method: 'POST' });
    roomId = created.body?.room?.roomId;
    if (!roomId) throw new Error(`createRoom failed: ${JSON.stringify(created)}`);
  }
  const status = await api('/api/helper/status');
  return status.body?.status;
}

async function startHelper(rid) {
  const res = await api('/api/helper/command', {
    method: 'POST',
    body: JSON.stringify({ command: 'start', payload: { roomId: rid } }),
  });
  return res.body;
}

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
    ws.onerror = (e) => reject(new Error('cdp ws error: ' + String(e?.message ?? e)));
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
      });
  });
}

async function waitForDevtools(base) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + '/json/version');
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('devtools endpoint never came up');
}

// Inject before app code so we can reach the RTCPeerConnection instances.
const INJECT = `
  (() => {
    window.__pcs = [];
    window.__tracks = [];
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...a) {
      const pc = new Orig(...a);
      window.__pcs.push(pc);
      pc.addEventListener('track', (e) => {
        window.__tracks.push({
          kind: e.track.kind,
          id: e.track.id,
          streams: e.streams.map((s) => s.id),
          mid: e.transceiver && e.transceiver.mid,
          direction: e.transceiver && e.transceiver.direction,
          at: Math.round(performance.now()),
        });
      });
      return pc;
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, Orig);
    const origSRD = Orig.prototype.setRemoteDescription;
    Orig.prototype.setRemoteDescription = function (desc) {
      try {
        if (desc && typeof desc === 'object' && desc.sdp) {
          window.__offer = { type: desc.type, sdp: desc.sdp };
        }
      } catch {}
      return origSRD.apply(this, arguments);
    };
  })();
`;

const SAMPLE = `(async () => {
  const v = document.querySelector('#player');
  const out = {
    href: location.href,
    bodyText: (document.body?.innerText ?? '').slice(0, 160),
    hidden: v ? v.classList.contains('hidden') : null,
    readyState: v ? v.readyState : null,
    videoWidth: v ? v.videoWidth : null,
    videoHeight: v ? v.videoHeight : null,
    currentTime: v ? +v.currentTime.toFixed(2) : null,
    totalVideoFrames: v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null,
    droppedVideoFrames: v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().droppedVideoFrames : null,
    pcStates: (window.__pcs || []).map((p) => p.connectionState),
    tracks: window.__tracks || [],
    srcObjectId: v && v.srcObject ? v.srcObject.id : null,
    srcObjectTracks: v && v.srcObject ? v.srcObject.getTracks().map((t) => ({ id: t.id, kind: t.kind, muted: t.muted, readyState: t.readyState })) : null,
    streamStatus: document.querySelector('#stream-status')?.textContent ?? null,
    connStatus: document.querySelector('#conn-status')?.textContent ?? null,
    waitingText: document.querySelector('#waiting-text')?.textContent ?? null,
  };
  if (window.__offer) {
    const lines = window.__offer.sdp.split(/\\r?\\n/);
    out.offer = {
      type: window.__offer.type,
      mlines: lines.filter((l) => l.startsWith('m=')),
      mids: lines.filter((l) => l.startsWith('a=mid:')),
      dirs: lines.filter((l) => /^a=(sendonly|recvonly|sendrecv|inactive)/.test(l)),
      ssrc: lines.filter((l) => l.startsWith('a=ssrc:')),
    };
  }
  const reports = await Promise.all((window.__pcs || []).map((p) => p.getStats().catch(() => null)));
  out.inbound = [];
  out.pairs = [];
  for (const rep of reports) {
    if (!rep) continue;
    const byId = new Map();
    rep.forEach((s) => byId.set(s.id, s));
    rep.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        out.inbound.push({
          bytesReceived: s.bytesReceived, packetsReceived: s.packetsReceived,
          framesReceived: s.framesReceived, framesDecoded: s.framesDecoded,
          keyFramesDecoded: s.keyFramesDecoded, frameWidth: s.frameWidth, frameHeight: s.frameHeight,
          nackCount: s.nackCount, pliCount: s.pliCount, firCount: s.firCount,
          jitter: s.jitter, packetsLost: s.packetsLost, framesPerSecond: s.framesPerSecond,
        });
      }
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
        const l = byId.get(s.localCandidateId), r = byId.get(s.remoteCandidateId);
        out.pairs.push({
          rtt: s.currentRoundTripTime,
          local: l ? l.candidateType + ':' + l.address + ':' + l.port + ':' + (l.protocol || '') : s.localCandidateId,
          remote: r ? r.candidateType + ':' + r.address + ':' + r.port + ':' + (r.protocol || '') : s.remoteCandidateId,
          bytesReceived: s.bytesReceived,
        });
      }
    });
  }
  return out;
})()`;

async function runTrial(rid, devtoolsBase) {
  // New blank target so the injected script applies before the app runs.
  let target;
  const newRes = await fetch(devtoolsBase + '/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' });
  target = await newRes.json();
  const cdp = await cdpConnect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });
  const url = `${WEB}/#/watch/${encodeURIComponent(rid)}`;
  await cdp.send('Page.navigate', { url });

  const samples = [];
  for (let t = 0; t <= seconds; t += 2) {
    await sleep(2000);
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: SAMPLE,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r?.result?.value) samples.push({ t: t + 2, ...r.result.value });
      else if (r?.exceptionDetails) samples.push({ t: t + 2, error: JSON.stringify(r.exceptionDetails) });
    } catch (e) {
      samples.push({ t: t + 2, error: String(e) });
    }
  }
  try { cdp.ws.close(); } catch {}
  try { await fetch(devtoolsBase + '/json/close/' + target.id); } catch {}
  return samples;
}

// ---------------------------------------------------------------------------
// Matrix recording (--label / --json): one JSON line per trial.
// ---------------------------------------------------------------------------
function recordTrial(v) {
  if (!jsonFile) return;
  trialIndex++;
  const pair = (v.lastPairs ?? [])[0] ?? null;
  const local = (pair?.local ?? '').split(':')[0] || null;
  const path = local ? (local === 'relay' ? 'TURN relay' : `direct ${local}`) : 'no pair';
  const rxBytes = (v.lastInbound ?? []).map((i) => i.bytesReceived ?? 0).reduce((a, b) => a + b, 0) || null;
  appendFileSync(jsonFile, JSON.stringify({
    ts: new Date().toISOString(),
    label,
    room: roomId,
    trial: trialIndex,
    result: v.result,
    connected: v.connected,
    gotBytes: v.gotBytes,
    anyDecoded: v.anyDecoded,
    path,
    pairLocal: pair?.local ?? null,
    pairRemote: pair?.remote ?? null,
    rttMs: pair && pair.rtt != null ? Math.round(pair.rtt * 1000) : null,
    rxBytes,
    fps: (v.lastInbound ?? [])[0]?.framesPerSecond ?? null,
    stream: v.lastStatus?.stream ?? null,
    conn: v.lastStatus?.conn ?? null,
  }) + '\n');
}

function verdict(samples) {
  const last = samples[samples.length - 1] ?? {};
  const anyDecoded = samples.some((s) => (s.inbound ?? []).some((i) => (i.framesDecoded ?? 0) > 0));
  const anyRendered = samples.some((s) => (s.totalVideoFrames ?? 0) > 0);
  const gotBytes = samples.some((s) => (s.inbound ?? []).some((i) => (i.bytesReceived ?? 0) > 0));
  const connected = samples.some((s) => (s.pcStates ?? []).includes('connected'));
  return {
    connected,
    gotBytes,
    anyDecoded,
    anyRendered,
    result: anyRendered ? 'WORKS' : gotBytes ? 'BLACK (media in, no frames rendered)' : connected ? 'CONNECTED BUT NO MEDIA' : 'NO CONNECTION',
    lastInbound: last.inbound ?? null,
    lastOffer: last.offer ?? null,
    lastTracks: last.tracks ?? null,
    srcObjectId: last.srcObjectId ?? null,
    srcObjectTracks: last.srcObjectTracks ?? null,
    lastPairs: last.pairs ?? null,
    lastStatus: { stream: last.streamStatus, conn: last.connStatus, waiting: last.waitingText, frames: last.totalVideoFrames, vw: last.videoWidth, vh: last.videoHeight },
  };
}

// ---------------------------------------------------------------------------
async function main() {
  const helper = await ensureSetup();
  console.log('[setup] helper:', JSON.stringify(helper));
  console.log('[setup] room:', roomId);

  const userDataDir = mkdtempSync(join(tmpdir(), 'golive-chrome-'));
  const devtoolsPort = 9222 + (process.pid % 100);
  const devtoolsBase = `http://127.0.0.1:${devtoolsPort}`;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${devtoolsPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  try {
    await waitForDevtools(devtoolsBase);

    const results = [];
    for (let i = 0; i < trials; i++) {
      const startRes = await startHelper(roomId);
      console.log(`[trial ${i + 1}] start →`, JSON.stringify(startRes));
      // Give the helper a beat to build the pipeline and emit its offer.
      await sleep(1500);
      const samples = await runTrial(roomId, devtoolsBase);
      const v = verdict(samples);
      console.log(`[trial ${i + 1}]`, JSON.stringify(v));
      console.log(`[trial ${i + 1}] samples`, JSON.stringify(samples, null, 0));
      results.push(v);
      recordTrial(v);

      // stop between trials so each start is a fresh stream
      await api('/api/helper/command', { method: 'POST', body: JSON.stringify({ command: 'stop' }) });
      await sleep(1200);
    }
    const tally = {};
    for (const r of results) tally[r.result] = (tally[r.result] || 0) + 1;
    console.log('[summary]', JSON.stringify(tally));
  } finally {
    chrome.kill();
    await sleep(500);
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { console.warn('[cleanup]', String(e)); }
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
