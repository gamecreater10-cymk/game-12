# IRONVEIL: HOLD THE YARD — LAN co-op shooting range

Two players on the same Wi-Fi share the IRONVEIL shooting range. Each player keeps their own first-person arms and weapon and sees the other as a fully animated third-person soldier. The partner walks, runs, crouches, turns, aims up and down, fires with muzzle flash and sound, reloads and switches weapons. Target hits, knock-downs, resets and the moving target are shared.
It is not PvP: bullets pass through your partner.

Single-player (DEPLOY and SHOOTING RANGE) is unchanged. It still works by double-clicking `public/index.html`, with no server and no internet.

---

## 1. What is in the folder

```
IRONVEIL/
├── server.js              Node.js server: serves the game + Socket.IO rooms, validation, shared target state
├── package.json           dependencies (express, socket.io) and scripts (start, test, lan-check)
├── README.md              this file
├── public/
│   ├── index.html         the game (your IRONVEIL file + small multiplayer hooks, LAN menu and HUD)
│   ├── js/multiplayer.js  client networking, interpolation, remote soldier controller, LAN menu/HUD
│   └── vendor/three/      local copy of three.js r128 + the post-processing scripts (used when offline)
├── test/server.test.js    automated server test (26 checks)
└── tools/lan-check.js     connection test you can run from another computer
```

The game still loads three.js r128 from the CDN first. If there is no internet, it falls back to `public/vendor/three/`. A LAN with no internet therefore works too; only the web font is replaced by a system font.

## 2. Host: install and start (once per computer)

1. Install **Node.js 18 or newer** from https://nodejs.org (the LTS version).
2. Open a terminal in the `IRONVEIL` folder:
   - macOS: Terminal → `cd ` then drag the folder in → Enter
   - Windows: open the folder, click the address bar, type `cmd`, then Enter
3. Install the dependencies (first time only):
   ```
   npm install
   ```
4. Start the server:
   ```
   npm start
   ```
   It prints something like:
   ```
     IRONVEIL LAN server is running
     On this computer:      http://localhost:3000
     Other devices (Wi-Fi): http://192.168.1.25:3000    (en0)
     Connection test:       http://<address above>:3000/status
   ```
5. On the host computer open **http://localhost:3000**, then:
   1. Click **LAN CO-OP**.
   2. Type a callsign.
   3. Click **HOST LAN GAME**.
   4. A 4-letter room code appears (letters only, no I or O). Tell your friend the code.
   5. Click **ENTER RANGE**. You can wait inside; your friend appears when they join.

Keep the terminal window open while you play. Press `Ctrl+C` in it to stop the server.

Options: `PORT=3100 npm start` changes the port. `MAX_PLAYERS=4 npm start` allows more players per room; the code supports up to 8. On Windows `cmd`, use `set PORT=3100 && npm start`.

## 3. Friend: join from the second device

1. Connect to **the same Wi-Fi network** as the host.
2. In a browser, open the host's address from the server printout, for example **http://192.168.1.25:3000**. Use the real address the server prints; this one is only an example.
3. Click **LAN CO-OP**, type a callsign and the room code, then click **JOIN LAN GAME** (or press Enter).
4. Click **ENTER RANGE**. You spawn next to the host at the firing line.

Nothing needs installing on the friend's device. It only needs a browser that can already run IRONVEIL.

## 4. Finding the host computer's LAN IP address

The server prints it on startup under "Other devices". To find it yourself:

- **macOS:**
  - System Settings → Wi-Fi → **Details…** next to the connected network → *IP address*.
  - Or in Terminal: `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1`.
- **Windows:**
  - Settings → Network & internet → Wi-Fi → *(your network)* properties → **IPv4 address**.
  - Or in `cmd`: `ipconfig`, then look for *IPv4 Address* under "Wireless LAN adapter Wi-Fi".

It usually looks like `192.168.x.x`, `10.x.x.x` or `172.16–31.x.x`. Do not use `127.0.0.1` or `localhost`; those only mean "this computer".

## 5. Connection test

Use any one of these:

- **From the friend's browser:** open `http://<host-ip>:3000/status`. It shows JSON with the open rooms and who is in each one. When both of you are in, it lists both callsigns under the same code.
- **From any computer with Node.js** (in the IRONVEIL folder): `npm run lan-check -- http://<host-ip>:3000`. It checks HTTP, the WebSocket, round-trip time, and creating a room.
- **In game:**
  - The top-right LAN panel shows the room code, your partner's status (green = connected) and the ping.
  - The pause menu (ESC) shows the room and your partner as well.

## 6. Firewall and network notes

- **macOS:**
  - The first time `node` listens, macOS may ask "Do you want the application node to accept incoming network connections?". Click **Allow**.
  - If you missed the prompt: System Settings → Network → Firewall → Options → set *node* to "Allow incoming connections".
- **Windows:**
  - When Windows Defender Firewall asks about Node.js, tick **Private networks** and click Allow.
  - If you missed it, run this in an *Administrator* command prompt:
    ```
    netsh advfirewall firewall add rule name="IRONVEIL LAN 3000" dir=in action=allow protocol=TCP localport=3000
    ```
  - Your Wi-Fi network should be set to **Private**, not Public: Settings → Network & internet → Wi-Fi → network → Network profile type.
- **Same network:** both devices must be on the same network. These setups often block device-to-device traffic:
  - **Guest Wi-Fi**
  - **"AP/client isolation"** on the router
  - Hotel, school or office Wi-Fi
  - A **VPN** on either device

  If joining fails on one of these, try a phone hotspot that both devices join, or turn the VPN off.
- No router port-forwarding and no internet hosting are needed for LAN play.

## 7. Playing

- Everything from the single-player range works as before: WASD, sprint, crouch, ADS, every weapon and attachment, reload, inspect, the armory (B), grenades and melee.
- **T** resets the targets for both players.
- The armory's *START/STOP MOVER* button controls the moving popper for both players, and it stays in the same position on both screens.
- Mannequin damage, knocked-down poppers, swinging gongs and paper-target holes are shared.
- **ESC** opens the pause menu.
  - The range keeps running for your partner.
  - **LEAVE LAN ROOM** takes you back to the menu. The other player sees "PLAYER LEFT THE RANGE".
- If the connection drops:
  - A red *CONNECTION LOST · RECONNECTING…* banner appears, and the game reconnects automatically.
  - Your seat is held for 30 seconds, so you come back as the same soldier, not a duplicate.

---

## 8. How it works

```
 Host computer                                            Friend's device
 ┌───────────────────────────────┐                        ┌─────────────────────────┐
 │ node server.js  (0.0.0.0:3000)│◄──── Wi-Fi / LAN ─────►│ browser: IRONVEIL page  │
 │  • serves public/ (the game)  │   HTTP + Socket.IO     │  (loaded from the host) │
 │  • rooms, player IDs, tokens  │                        └─────────────────────────┘
 │  • validates + relays state   │◄──── localhost ───────►┌─────────────────────────┐
 │  • owns shared target state   │                        │ browser: IRONVEIL page  │
 └───────────────────────────────┘                        └─────────────────────────┘
```

- **One origin.** The page and the Socket.IO connection come from the same host and port. The client calls `io()` with no URL, so it always connects to whichever server served the page. Nothing is hard-coded to `localhost`.
- **Local first.**
  - Your movement, camera, weapon, recoil and shooting run immediately on your own machine, exactly as in single-player.
  - About 20 times a second, `MP.update()` (called from the game's `tick`) sends a small JSON state.
  - The state is sent only when something changed, plus a heartbeat every 0.4 s.
- **Remote players** are drawn 110 ms in the past and interpolated between server-timestamped samples:
  - Position and view direction are interpolated, with short extrapolation and then hold if packets stop.
  - A clock sync (`time:ping`) aligns the timelines.
  - Spawns snap instead of interpolating.
- **Third-person soldier.** This is the game's own rigged soldier: `makeSoldier` + `poseSoldier`, the same skeleton, uniform, gear and IK as the enemies and range mannequins.
  - It is driven only by synchronized state:
    - Speed and direction come from the interpolated motion.
    - Body yaw comes from the partner's view yaw. Turning on the spot shuffles the feet.
    - Head and rifle pitch come from their camera pitch.
    - ADS and the moments after firing raise the weapon to the shoulder.
    - Crouch is synced, and so are reload (support hand to the magazine and pouch) and recoil.
  - The partner's weapon is a third-person copy of the real weapon model, including the suppressor. Handguns are held in a two-handed stance.
  - A nameplate shows the callsign and current weapon.
- **Shots** are events, not state.
  - Every shot is one `player:fire` with a sequence number, the muzzle origin and the impact points: one, or up to 9 for a shotgun.
  - The other player draws the flash, smoke and tracer, plays the gun's sound, and shows wall and ground impacts.
  - Automatic fire stays within the weapon's fire rate, which the server enforces.
- **Shared targets.**
  - Each target has a stable ID: its index in the range, which is built identically everywhere.
  - A hit is reported as `target:hit` with the shot sequence and pellet number.
  - The server checks that hit against the shot it just relayed, the weapon's maximum damage, the target's position and the shooter's distance.
  - It then updates its own copy of the range: mannequin health and knock-downs, popper state, paper holes.
  - Finally it forwards the hit to the other player, whose game applies it through the target's normal `damage()` call.
  - Players who join later get the server's current target state.

### Socket.IO events

The server identifies players by their socket connection. Player IDs are created by the server and never taken from client messages. Every event is checked for room membership and rate-limited per player.

Client → server events:

| Event | Fields | Server validation | Sent on to |
|---|---|---|---|
| `room:create` | `name, ver, cfg{layout, weapons}` | protocol version; sane range layout and weapon table | creator gets `room:created` |
| `room:join` | `code, name, ver, cfg, token?` | code format; room exists; same game build (cfg hash); room not full; a valid `token` reclaims a dropped seat | joiner gets `room:joined`; others get `player:joined` |
| `room:rejoin` | `code, token` | token belongs to this room and the seat is still held | `room:joined` (rejoin); others get `player:status` |
| `room:leave` | — | member | others get `player:left` |
| `player:state` | `p[x,y,z], y (yaw), pi (pitch), cr, sp, ad, w, rl, gr, pa, tp` | numbers finite; position inside the range bounds; no jumps faster than 16 m/s except a respawn at the firing line; ≤ 40/s | others: `player:state` (volatile) with `id, t` |
| `player:fire` | `seq, w, o[x,y,z], e[[x,y,z]…], sup` | known weapon; increasing seq; impacts ≤ pellets; origin at the player; not faster than the weapon's fire rate | others: `player:fire` |
| `player:reload` | `w, dur, e` | known weapon; 0.2–8 s; ≤ 4/s | others: `player:reload` |
| `player:weapon` | `w, sup` | known weapon; ≤ 8/s | others: `player:weapon` |
| `target:hit` | `tid, seq, k, part, dmg, pt, d` | target exists; belongs to a shot from the last 1.5 s; one hit per pellet; damage ≤ weapon max × head multiplier; hit point near the target; shooter within 360 m | others: `target:hit` |
| `range:reset` | — | member; ≤ 2/s | others: `range:reset` |
| `range:mover` | `moving` | member; ≤ 2/s | everyone: `range:mover {moving, ph0, t0}` |
| `time:ping` | ack callback | ≤ 6/s | ack with the server time |

Server → client events:

| Event | Payload | Sent to |
|---|---|---|
| `room:created`, `room:joined` | `code, you{id, slot, token, host}, room{players, targets, mover, serverNow}` | the requester |
| `player:joined` | public player info | the room |
| `player:left` | `id, name, reason (left/timeout), newHost` | the room |
| `player:status` | `id, connected` | the room |
| `multiplayer:error` | `code, message` | the requester |

Error codes: `INVALID_CODE`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `VERSION_MISMATCH`, `REJOIN_FAILED`, `RATE_LIMIT`, `BAD_REQUEST`.

**Reliability.**
- All handlers are wrapped so malformed messages can't crash the server.
- Rooms are deleted when the last player leaves.
- A disconnected player keeps their seat (and model) for 30 s, then is removed.
- If the host leaves, the room continues and the host badge passes to the remaining player.
- The room lives on the server, not in the host's browser.

### Changes to the existing game (`public/index.html`)

All additions are guarded with `typeof MP !== 'undefined'`, so the game runs unchanged without `multiplayer.js`.

- **`<head>`:** a local three.js fallback after the CDN tags, plus CSS for the LAN menu, multiplayer HUD and toasts.
- **Title screen:**
  - A **LAN CO-OP** button next to DEPLOY and SHOOTING RANGE.
  - A LAN panel with callsign, HOST LAN GAME, code entry with JOIN LAN GAME, room code, player list, ENTER RANGE and BACK.
  - The title box now scrolls on very short screens.
- **HUD:** `#mpHud` (top right; free in range mode), `#mpToast` and `#mpWarn`. The pause menu shows the room info and **EXIT TO MENU** becomes **LEAVE LAN ROOM**.
- **Soldier rig:**
  - `makeSoldier(heavy, look)` takes an optional uniform.
  - `poseSoldier` accepts `look` (head pitch when not aiming), `noGlance` (no random idle glances) and `rl` (reload phase).
  - It also accepts a handgun support-hand grip. Existing callers are unaffected.
- **`hitscan`:** returns the impact point, and reports range-target hits to `MP.onTargetHit`.
- **`fire`:** brackets each shot with `MP.beginShot()` and `MP.endShot()`, which sends one fire event plus its hits.
- **`tick`:** calls `MP.update(dt)` once per frame (no extra loop).
- **Range controls:**
  - **T** and the mover toggle also notify the room.
  - The moving popper follows the room's shared phase.
- **Range spawn:** offset by the player's slot so players don't overlap.
- **`exitToMenu`:** leaves the room.
- **Key handler:** ignores keys while you type in the LAN text fields; ESC closes the LAN panel.

No other gameplay code changed, and there is still only one renderer and one animation loop.

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| Friend's browser can't open `http://<ip>:3000` (times out) | Check the IP address (section 4) and that `npm start` is still running. Allow Node.js in the host's firewall (section 6). Make sure both devices are on the same non-guest network with no VPN. Test with `/status`. |
| Page opens but LAN CO-OP says "Can't reach the IRONVEIL server" | The page was opened from a file or another web server. Open it from the IRONVEIL server's address instead. |
| "LAN play needs the IRONVEIL server" | You double-clicked `index.html`. That's fine for single-player; for LAN, open `http://localhost:3000` (host) or `http://<host-ip>:3000` (friend). |
| "No room ABCD on this server" | Check the code (letters only, no I or O). The friend must open the **same** server's address. A restarted server forgets its rooms, so host again. |
| "Room ABCD is full" | Two players are already in it. If someone just dropped, their seat is held for 30 s. |
| "Your copy of the game differs from the host's" | Both players must load the game from the host's server. Hard-refresh with Ctrl+F5 or Cmd+Shift+R. |
| Red "CONNECTION LOST · RECONNECTING…" | Wi-Fi dropped or the server stopped. It reconnects by itself within 30 s; otherwise go back to the menu and join again. |
| Partner stutters or jumps | Weak Wi-Fi or a busy network. Move closer to the router, or use 5 GHz or Ethernet for the host. |
| `Port 3000 is already in use` | Another program uses it. Run `PORT=3100 npm start` (Windows: `set PORT=3100 && npm start`) and use port 3100 in the address. |
| No sound | Click once inside the game; browsers need a click before playing audio. |

## 10. Testing

- **Automated server test:** `npm test`.
  - It starts its own server and runs 26 checks.
  - Rooms and codes, wrong, malformed and full rooms, and version mismatch.
  - State relay, teleport and bounds rejection, and fire relay with fire-rate limits.
  - Target hits are accepted only for real shots, once per pellet, and only with sane damage. Shotgun pellets are covered.
  - Shared target state for late joiners, reset and mover sync, and malformed-message robustness.
  - Disconnect and rejoin with the same ID (no duplicate), rate limiting, leaving, and room cleanup.
- **LAN check:** `npm run lan-check -- http://<host-ip>:3000`.

Manual checklist (two devices, about 10 minutes):

1. Double-click `public/index.html` (no server). DEPLOY and SHOOTING RANGE work as before.
2. Run `npm start` on the host. It prints the addresses with no errors.
3. Host: open `localhost:3000`, then LAN CO-OP → HOST LAN GAME. A code and "WAITING FOR ANOTHER PLAYER…" appear. Click ENTER RANGE.
4. Friend: open `http://<host-ip>:3000`. The game loads; `/status` shows the room.
5. Friend: enter a wrong code and see a clear error. Enter the right code, then JOIN → ENTER RANGE. Both see "… JOINED THE RANGE" and each other's nameplate.
6. Walk, run, strafe and stop. The partner's soldier moves the same way with planted feet, and stops where you stop.
7. Turn on the spot. The body turns with you. Look up and down while aiming (right mouse); the partner's rifle pitches with you.
8. Crouch with C and jump. Both are visible.
9. Fire every weapon. The partner sees muzzle flash, smoke, tracers and impacts and hears the shot. Automatic fire doesn't flood (one event per shot).
10. Reload (R) and switch weapons (1–7, armory, suppressor). The partner sees the reload motion and the matching weapon.
11. Shoot a mannequin, a popper, a gong and a paper target. Both screens show the same damage, falls, swings and holes. Press T: both ranges reset. Toggle the mover in the armory: both see it stop or start in the same place.
12. ESC → LEAVE LAN ROOM. The other player's partner model disappears with a "LEFT" message.
13. Turn Wi-Fi off on one device for 5–10 s, then back on. "LOST CONNECTION", then "RECONNECTED", with no second soldier.
14. A third device trying the same code gets "Room … is full".
15. After leaving, single-player DEPLOY and SHOOTING RANGE still work normally.

## 11. Notes and limits

- Friendly co-op only: there is no player damage, scoring between players or teams. Your bullets pass through your partner.
- Rooms live in the server's memory; restarting the server closes them.
- The server trusts each game client for its own movement and aim, which is fine for a LAN game with friends. It does reject impossible movement, fire rates, damage and hits.
