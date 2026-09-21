# M7 regression matrix runner

Headless-Chrome viewer harness that drives the **real** stack — backend `:3000`, Vite
`web` `:5173`, and the native helper streaming — opens the watch page in headless Chrome
and samples `getStats()` + `<video>` playback. It is the repeatable instrument behind
Milestone 7's "re-run the known network matrix after any networking change".

## Prerequisites

- `bun` on PATH (or run with plain `node`).
- Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`
  (edit `CHROME` in `repro.mjs` if elsewhere).
- Backend running on `:3000`, Vite dev server on `:5173`.
- The native helper running **and logged in** (`dev-auth` is fine), base URL
  `http://localhost:3000`. The harness starts/stops the stream via
  `POST /api/helper/command`.

## Usage

```
bun repro.mjs --trials 3 --seconds 20 --label "LAN (repro, same host)" --json matrix-results.jsonl
```

- `--trials N` — number of start/stop/broadcast cycles (default 1).
- `--seconds S` — seconds of sampling per trial (default 24; headless Chrome needs
  ~5 s for ICE to settle + first frame on a LAN).
- `--label "…"` — network identifier recorded on every JSON line.
- `--json path` — append one JSON line per trial to a results file.
- `--room id` — reuse a specific room instead of creating one.

Every trial emits a verdict line and appends a row to the JSON file:

```json
{"ts":"…","label":"…","room":"…","trial":1,"result":"WORKS",
 "connected":true,"gotBytes":true,"anyDecoded":true,"path":"direct host",
 "pairLocal":"host:127.0.0.1:61234:udp","pairRemote":"host:127.0.0.1:61235:udp",
 "rttMs":2,"rxBytes":123456,"fps":30,"stream":"Receiving live media.","conn":"Peer connected."}
```

## Network matrix (the M7 regression catalog)

| Label | What it verifies | How |
| --- | --- | --- |
| LAN (repro, same host) | baseline — host ⇄ host | `bun repro.mjs --label "LAN" --json matrix-results.jsonl` |
| Tailscale / overlay | host ⇄ host through an overlay tunnel | attach the other tailnet device to the LAN repro and record |
| Residential A ⇄ Residential B | srflx ⇄ srflx across two home routers | real viewer on network B→ watch link; append with `--label` on the network-B machine |
| Mobile hot spot | cellular NAT without a carrier CGNAT | phone hot spot → PC or phone viewer |
| Carrier CGNAT (cellular) | expected **TURN-required** when strict | phone viewer on cellular; autocreates a classified failure |
| IPv6 networks | path should prefer/direct over v6 host candidates | any network handing the viewer a global IPv6 |

The headless-Chrome side of the matrix **only ever sits on the host's own LAN**, so LAN
rows are fully automated; remote-network rows are recorded by running the harness next to
a real viewer, or appended by hand after a device test. Historical field rows from M6 are
pre-seeded in `matrix-results.jsonl` (`source: "field-m6"`).

Run the full LAN leg after any change to signaling, ICE handling, the helper pipeline, or
the browser `webrtc.ts`/watch page. A matrix run is "green" when the LAN leg is 100%
`WORKS` and every non-LAN row keeps its expected classification (direct across residential
NATs, TURN-required on strict CGNAT).