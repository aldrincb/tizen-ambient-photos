# Ambient Photos for Samsung Tizen TV

A lightweight, **Chromecast Ambient Mode** experience for Samsung Tizen Smart TVs (including older models, The Serif, QLED, and Crystal UHD) powered directly by any shared **Google Photos** album.

## Features

- **100% Standalone on the TV:** Runs natively as a sideloaded `.wgt` app (with an embedded Tizen Node.js fetch service)—no external server, Raspberry Pi, or PC required once installed.
- **Zero Local Photo Storage:** Paginates your entire Google Photos shared album into memory (supports 5,000+ photo albums), shuffles live, and streams each frame on demand.
- **Photos Only (No Video Play-Button Clutter):** Automatically filters out video items and suppresses server-side overlays.
- **Chromecast Ambient Styling:**
  - Pairs vertical (portrait) phone photos side-by-side over a soft blurred backdrop
  - Smart full-bleed or fit-entire-photo modes for horizontal shots
  - Double-buffered crossfade transitions with image preloading
  - Live clock, day/date, and photo capture dates with subtle pixel-shift to prevent OLED/QLED burn-in
  - Requests Tizen `SCREEN_NORMAL` wake-lock so the TV doesn't dim or sleep while displaying photos
- **Auto-Updating:** Periodically re-checks your shared Google Photos album in the background so newly added photos enter the shuffle automatically.

---

## Quick Start: Install on Your Samsung TV

### 1. Enable Developer Mode on Your Samsung TV
1. Open the **Apps** screen on your TV *(on newer 2022–2026 Smart Hub menus, scroll all the way down and open **App Settings**)*.
2. Enter **`12345`** using your remote's number pad, the **SmartThings** phone app keypad, or a USB keyboard.
3. Toggle **Developer Mode → ON** and enter your computer's local IP address under **Host PC IP**.
4. **Cold-reboot the TV** (hold the remote Power button down for ~6 seconds until the Samsung boot logo appears, or unplug the TV for 10 seconds).

### 2. Install `AmbientPhotos.wgt`

#### Option A: Using TizenBrew Installer (GUI — Windows / macOS / Linux / Android)
1. Download [`dist/AmbientPhotos.wgt`](./dist/AmbientPhotos.wgt) from this repository (or Releases).
2. Open [TizenBrew Installer Desktop](https://github.com/reisxd/TizenBrewInstaller/releases), connect to your TV's IP address, and choose **Select to Install** → `AmbientPhotos.wgt` *(automatically handles Samsung Account certificate signing on Tizen 7/8/9+)*.

#### Option B: Using the Included CLI Script (Node.js — No Tizen Studio Needed)
```bash
cd tools
npm install
cd ..
node tools/sign_and_install.js <YOUR_TV_IP>
```
- On **Tizen 7/8/9+**, the first run starts a local callback on `http://localhost:4794` so you can sign in once with your Samsung Account to mint a free developer certificate for your TV's DUID (saved locally in `tools/samsung_cert.json`, which is git-ignored).

---

## First Launch Setup on TV

1. Open **Ambient Photos** on your TV *(tip: go to **Apps → Downloaded Apps → Ambient Photos → Add to Home** to pin it)*.
2. In the **Settings** prompt, enter your Google Photos shared album link (`https://photos.app.goo.gl/...`) **or just its short share code** (e.g. `AbCdEf123456`) and click **Save & Apply**.

### Remote & Keyboard Controls

| Action | Samsung TV Remote | Desktop Preview |
| :--- | :--- | :--- |
| Next / Previous Shuffled Slide | `Right` / `Left` | `ArrowRight` / `ArrowLeft` |
| Pause / Resume | `Play/Pause` | `Space` |
| Open Settings | `Select (Enter)` | `Enter` or `S` |
| Reshuffle Deck | — | `R` |
| Exit App / Close Settings | `Back / Return` | `Esc` |

---

## Preview & Debug Locally (macOS / Linux / Windows)

You can preview and tweak the UI in any desktop browser before sideloading:

```bash
python3 dev_server.py
```
Then open **http://localhost:8090** in Chrome or Safari.

To rebuild the generic release `.wgt` package after making changes to `app/`:
```bash
node tools/build_release_wgt.js
```

## License

[MIT](./LICENSE)
