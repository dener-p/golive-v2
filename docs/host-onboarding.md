# Host onboarding (for friends, no dev setup)

You only need a **Windows 10/11 PC** and a browser (Chrome or Edge recommended).
No installers, no accounts beyond Discord, no terminal skills beyond one copy-paste.

> Everything in this guide happens at **https://golive.puhl.dev**.

---

## 1. Sign in (Discord)

Open the host page and sign in with Discord. Only people who stream need this —
**viewers never sign in**, they just open the watch link you send them.

## 2. Create a room

On the landing page, start a room. A **host page** opens. Send the **watch link**
(`golive.puhl.dev/watch/{code}`) to whoever should watch you. Viewers just open it.

## 3. Get the helper

The helper is a small **Windows program** that captures your screen and encodes it.
It does not require admin rights.

1. On the host page you'll see a card offering to **download the helper** (it appears
   because the helper isn't running yet). Click it and save
   `golive-helper-0.1.0-windows-x64.exe` (≈ 3.8 MB) — Downloads is fine.
2. Double-click the exe. Windows SmartScreen will warn because the file isn't
   digitally signed:
   - click **More info** → **Run anyway**.
   - It's our own build; the checksum is listed on the site under the download card.
3. The helper has no window — it lives in the **system tray** (the `^` arrow next to
   the clock). Right-click its icon for the menu (open host page / start-stop /
   NAT self-test / start with Windows / quit).

## 4. Pair it (one-time)

The helper authenticates with its own device token, not your browser session.

1. Back on the host page, click **Get pairing code**.
2. A code and a ready-made command appear, e.g.:
   `golive-helper.exe pair https://golive.puhl.dev ABCD2XYZ`
3. Open **PowerShell or Terminal** in the folder where you saved the exe
   (in Explorer: `Shift`+right-click the folder → *Open in Terminal*), paste the
   command, press Enter.
4. You'll see `paired with … as user …`. Go back to the host page and **refresh** —
   your PC now appears under *Paired devices*.

## 5. Go live

1. On the host page click **Start live**. The tray tooltip/diagnostics show the
   stream is running.
2. Share the watch link. Viewers are anonymous — a phone/tablet/etc. can open it
   straight from your message.

**Stop** = *Stop live* on the host page, or the tray menu's **Stop streaming**.

---

## Handy extras

| Thing | How |
| --- | --- |
| Start helper when Windows starts | tray menu → **Start with Windows** (checkbox) |
| Check whether your connection is the problem | host page → **NAT self-test** (a one-line verdict about your router/NAT) |
| Remove a device you no longer use | host page → *Paired devices* → **Revoke** |
| Start the helper later | double-click the exe again (or it starts with Windows) |

## Troubleshooting

- **SmartScreen warning** — *More info → Run anyway*. Expected: the exe isn't code-signed.
- **"Run this command" step fails** — make sure the terminal is in the same folder as
  the exe (the command starts with `golive-helper.exe`, not a path).
- **Code expired** — codes last 5 minutes; mint a new one and run again.
- **"Start live" stays disabled/grey** — the helper isn't online. Open the tray,
  check the helper is running, then refresh the host page so it sees the helper.
- **Viewer can't connect** — most common on cellular connections (carrier NAT).
  Run the **NAT self-test**; if it says your network needs TURN, ask the operator to
  configure TURN (see `docs/self-host.md`), or use a normal home Wi-Fi network.
- **Antivirus blocks the exe** — allow the file for the folder it's in; it's a
  portable exe with no installer and no services.