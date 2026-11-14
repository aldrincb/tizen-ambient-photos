(function () {
  "use strict";

  var DEFAULT_ALBUM_URL = "";
  var REFRESH_ALBUM_MS = 30 * 60 * 1000; // Re-check Google Photos every 30 min
  var isTizen = typeof window.tizen !== "undefined" || window.location.protocol === "file:";

  // Load saved preferences
  var prefs = loadPrefs();
  var allPhotos = [];
  var deck = [];       // Array of slide descriptors: either [photo] or [photo1, photo2]
  var deckIndex = -1;
  var activeSlot = "a";
  var slideTimer = null;
  var isPaused = false;
  var idleTimer = null;
  var albumTitle = "Google Photos";

  // DOM Elements
  var els = {
    slideA: document.getElementById("slide-a"),
    slideB: document.getElementById("slide-b"),
    backdropA: document.getElementById("backdrop-a"),
    backdropB: document.getElementById("backdrop-b"),
    frameA: document.getElementById("frame-a"),
    frameB: document.getElementById("frame-b"),
    photoDate: document.getElementById("photo-date"),
    albumTitle: document.getElementById("album-title"),
    syncDot: document.getElementById("sync-dot"),
    syncStatus: document.getElementById("sync-status"),
    clockTime: document.getElementById("clock-time"),
    clockDay: document.getElementById("clock-day"),
    ambientHud: document.getElementById("ambient-hud"),
    controlsBar: document.getElementById("controls-bar"),
    btnPrev: document.getElementById("btn-prev"),
    btnPause: document.getElementById("btn-pause"),
    btnNext: document.getElementById("btn-next"),
    btnReshuffle: document.getElementById("btn-reshuffle"),
    btnFullscreen: document.getElementById("btn-fullscreen"),
    btnSettings: document.getElementById("btn-settings"),
    modal: document.getElementById("settings-modal"),
    inpUrl: document.getElementById("inp-album-url"),
    selInterval: document.getElementById("sel-interval"),
    selPortrait: document.getElementById("sel-portrait"),
    selLandscape: document.getElementById("sel-landscape"),
    btnCancelSettings: document.getElementById("btn-cancel-settings"),
    btnSaveSettings: document.getElementById("btn-save-settings"),
  };

  function loadPrefs() {
    try {
      var raw = localStorage.getItem("ambient_prefs_v1");
      if (raw) {
        var p = JSON.parse(raw);
        return {
          albumUrl: p.albumUrl || DEFAULT_ALBUM_URL,
          intervalSec: Number(p.intervalSec) || 30,
          portraitMode: p.portraitMode || "pair",
          landscapeMode: p.landscapeMode || "smart",
        };
      }
    } catch (e) {}
    return {
      albumUrl: DEFAULT_ALBUM_URL,
      intervalSec: 30,
      portraitMode: "pair",
      landscapeMode: "smart",
    };
  }

  function savePrefs() {
    try {
      localStorage.setItem("ambient_prefs_v1", JSON.stringify(prefs));
    } catch (e) {}
  }

  // Initialize Samsung Tizen TV hardware integration when running inside .wgt
  function initTizenHardware() {
    if (!window.tizen) return;
    try {
      if (tizen.power) {
        tizen.power.request("SCREEN", "SCREEN_NORMAL");
      }
      if (tizen.tvinputdevice) {
        ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaFastForward", "MediaRewind", "Info", "Tools"].forEach(function (k) {
          try { tizen.tvinputdevice.registerKey(k); } catch (e) {}
        });
      }
    } catch (err) {
      console.warn("Tizen API init note:", err);
    }
  }

  // Live Clock + OLED/QLED subtle pixel shift
  function updateClock() {
    var now = new Date();
    var hours = now.getHours();
    var mins = now.getMinutes();
    var h12 = hours % 12 || 12;
    var mm = mins < 10 ? "0" + mins : String(mins);
    els.clockTime.textContent = h12 + ":" + mm;

    var dayStr = now.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    els.clockDay.textContent = dayStr;

    // Gentle 4px drift every minute to prevent static text burn-in on TVs
    var dx = (mins % 5) - 2;
    var dy = ((Math.floor(mins / 5)) % 5) - 2;
    els.ambientHud.style.transform = "translate(" + dx + "px, " + dy + "px)";
  }

  function tvLog() {}

  function xhrRequest(method, url, body, contentType) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      if (contentType) {
        xhr.setRequestHeader("Content-Type", contentType);
      }
      xhr.timeout = 25000;
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 400 || (xhr.status === 0 && xhr.responseText)) {
          resolve({
            finalUrl: xhr.responseURL || url,
            text: xhr.responseText,
          });
        } else {
          reject(new Error("XHR HTTP " + xhr.status));
        }
      };
      xhr.onerror = function () {
        reject(new Error("XHR network/CORS error (status=" + xhr.status + ")"));
      };
      xhr.ontimeout = function () {
        reject(new Error("XHR timeout"));
      };
      xhr.send(body || null);
    });
  }

  var API_BASE = isTizen ? "http://127.0.0.1:8192" : "";

  async function ensureTizenLocalService() {
    if (!isTizen) return;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var r = await xhrRequest("GET", API_BASE + "/ping", null, null);
        if (r && r.text === "ok") {
          tvLog("SERVICE_ALREADY_UP");
          return;
        }
      } catch (e) {}

      if (window.tizen && tizen.application) {
        await new Promise(function (resolve) {
          try {
            var pkgId = tizen.application.getCurrentApplication().appInfo.packageId;
            var serviceId = pkgId + ".PhotoProxy";
            tvLog("LAUNCHING_SERVICE " + serviceId);
            tizen.application.launchAppControl(
              new tizen.ApplicationControl("http://tizen.org/appcontrol/operation/service"),
              serviceId,
              function () {
                tvLog("SERVICE_LAUNCH_CALLBACK_OK");
                setTimeout(resolve, 600);
              },
              function (err) {
                tvLog("SERVICE_LAUNCH_ERR " + (err && err.message ? err.message : String(err)));
                setTimeout(resolve, 600);
              }
            );
          } catch (ex) {
            tvLog("SERVICE_LAUNCH_EX " + String(ex));
            setTimeout(resolve, 600);
          }
        });
      }
    }
    // Wait up to 4 seconds for 127.0.0.1:8192/ping to come online
    for (var w = 0; w < 10; w++) {
      try {
        var pingRes = await xhrRequest("GET", API_BASE + "/ping", null, null);
        if (pingRes && pingRes.text === "ok") {
          tvLog("SERVICE_PING_OK");
          return;
        }
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    tvLog("SERVICE_PING_TIMEOUT");
  }

  // Network transport: Internal Tizen NodeJS service (127.0.0.1:8192) on TV, local dev_server on Mac
  async function fetchPage1(shareUrl) {
    await ensureTizenLocalService();
    var res = await xhrRequest("GET", API_BASE + "/api/page1?url=" + encodeURIComponent(shareUrl), null, null);
    return JSON.parse(res.text);
  }

  async function fetchBatchPage(albumId, token, authKey) {
    var rpcPayload = JSON.stringify([albumId, token, null, authKey]);
    var formBody = "f.req=" + encodeURIComponent(JSON.stringify([[["snAcKc", rpcPayload, null, "generic"]]]));
    var res = await xhrRequest(
      "POST",
      API_BASE + "/api/batchexecute",
      formBody,
      "application/x-www-form-urlencoded;charset=UTF-8"
    );
    return res.text;
  }

  function parseRawItem(item) {
    if (!Array.isArray(item) || !Array.isArray(item[1]) || typeof item[1][0] !== "string") return null;
    // Filter out all video items (Google Photos protobuf VideoInfo extension key "76647426")
    for (var i = 0; i < item.length; i++) {
      if (item[i] && typeof item[i] === "object" && !Array.isArray(item[i]) && "76647426" in item[i]) {
        return null;
      }
    }
    var id = item[0];
    var baseUrl = item[1][0];
    var width = Number(item[1][1]) || 1920;
    var height = Number(item[1][2]) || 1080;
    var tsMs = typeof item[2] === "number" ? item[2] : 0;
    return {
      id: id,
      url: baseUrl,
      w: width,
      h: height,
      ts: tsMs,
      isPortrait: height > width * 1.05,
    };
  }

  function formatPhotoDate(tsMs) {
    if (!tsMs) return "";
    var d = new Date(tsMs);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  // Fisher-Yates shuffle
  function shuffleArray(arr) {
    var copy = arr.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  }

  // Build Chromecast-style shuffled slide deck (pairs portrait shots when enabled)
  function buildShuffledDeck(items) {
    var shuffled = shuffleArray(items);
    if (prefs.portraitMode !== "pair") {
      return shuffled.map(function (p) { return [p]; });
    }

    var slides = [];
    var pendingPortrait = null;
    for (var i = 0; i < shuffled.length; i++) {
      var p = shuffled[i];
      if (p.isPortrait) {
        if (pendingPortrait) {
          slides.push([pendingPortrait, p]);
          pendingPortrait = null;
        } else {
          pendingPortrait = p;
        }
      } else {
        slides.push([p]);
      }
    }
    if (pendingPortrait) {
      slides.push([pendingPortrait]);
    }
    return shuffleArray(slides);
  }

  function setStatus(text) {
    if (!text) {
      els.syncDot.style.display = "none";
      els.syncStatus.textContent = "";
    } else {
      els.syncDot.style.display = "inline";
      els.syncStatus.textContent = text;
    }
  }

  function normalizeAlbumInput(val) {
    var s = (val || "").trim();
    if (!s) return "";
    // Allow typing just the short 17-char Google Photos share code on a TV remote!
    if (s.indexOf("http://") !== 0 && s.indexOf("https://") !== 0 && s.indexOf("/") === -1) {
      return "https://photos.app.goo.gl/" + s;
    }
    if (s.indexOf("photos.app.goo.gl/") === 0 || s.indexOf("photos.google.com/") === 0) {
      return "https://" + s;
    }
    return s;
  }

  // Load full Google Photos shared album (starts slideshow immediately after page 1!)
  async function syncGooglePhotosAlbum() {
    if (!prefs.albumUrl) {
      els.photoDate.textContent = "Welcome to Ambient Photos";
      setStatus("Enter a shared Google Photos album link in Settings");
      openSettings();
      return;
    }
    try {
      setStatus("Syncing Google Photos…");
      var p1 = await fetchPage1(prefs.albumUrl);

      // If Google's shortlink (photos.app.goo.gl) returned an HTML JS-redirect wrapper instead of HTTP 302,
      // extract the canonical https://photos.google.com/share/... URL and fetch it automatically!
      if (p1.finalUrl.indexOf("/share/") === -1) {
        var shareLinkMatch = p1.html.match(/https:\/\/photos\.google\.com\/share\/[A-Za-z0-9_\-?=&%]+/);
        if (shareLinkMatch) {
          var resolvedShareUrl = shareLinkMatch[0].replace(/&amp;/g, "&");
          p1 = await fetchPage1(resolvedShareUrl);
        }
      }

      var parsedUrl = new URL(p1.finalUrl);
      var shareParts = parsedUrl.pathname.split("/share/");
      if (shareParts.length < 2) {
        throw new Error("URL does not look like a public Google Photos shared album.");
      }
      var albumId = shareParts[1].split("/")[0];
      var authKey = parsedUrl.searchParams.get("key") || "";

      var match = p1.html.match(/AF_initDataCallback\(\{key:\s*'ds:1'[\s\S]*?data:([\s\S]*?),\s*sideChannel:/);
      if (!match) {
        throw new Error("Could not parse Google Photos album payload.");
      }

      var data = JSON.parse(match[1]);
      if (Array.isArray(data[3]) && typeof data[3][1] === "string" && data[3][1]) {
        albumTitle = data[3][1];
        els.albumTitle.textContent = albumTitle;
      }

      var seen = new Set();
      var collected = [];
      function ingestBatch(rawList) {
        if (!Array.isArray(rawList)) return;
        for (var i = 0; i < rawList.length; i++) {
          var parsed = parseRawItem(rawList[i]);
          if (parsed && !seen.has(parsed.id)) {
            seen.add(parsed.id);
            collected.push(parsed);
          }
        }
      }

      ingestBatch(data[1]);
      var nextToken = typeof data[2] === "string" ? data[2] : "";

      // Start shuffled slideshow right away using the first 300 items if nothing is showing yet!
      var startedEarly = false;
      if (allPhotos.length === 0 && collected.length > 0) {
        tvLog("PAGE1_OK count=" + collected.length);
        allPhotos = collected.slice();
        deck = buildShuffledDeck(allPhotos);
        deckIndex = -1;
        startedEarly = true;
        showStep(1);
        resetSlideTimer();
      }

      // Quietly paginate remaining pages in the background
      var page = 1;
      while (nextToken && page < 80) {
        page++;
        setStatus("Loading album… " + collected.length.toLocaleString() + " photos");
        var braw = await fetchBatchPage(albumId, nextToken, authKey);
        var foundNext = "";
        var lines = braw.split("\n");
        for (var l = 0; l < lines.length; l++) {
          var line = lines[l];
          if (line.indexOf("wrb.fr") !== -1 && line.indexOf("snAcKc") !== -1) {
            try {
              var outer = JSON.parse(line);
              for (var e = 0; e < outer.length; e++) {
                var entry = outer[e];
                if (Array.isArray(entry) && entry[0] === "wrb.fr" && entry[1] === "snAcKc") {
                  var inner = JSON.parse(entry[2]);
                  ingestBatch(inner[1]);
                  foundNext = typeof inner[2] === "string" ? inner[2] : "";
                }
              }
            } catch (err) {}
          }
        }
        nextToken = foundNext;
      }

      if (collected.length > 0) {
        allPhotos = collected;
        deck = buildShuffledDeck(allPhotos);
        deckIndex = 0;
        setStatus(allPhotos.length.toLocaleString() + " photos · Shuffled");
        if (!startedEarly) {
          showStep(1);
          resetSlideTimer();
        }
      }
    } catch (err) {
      console.error("Album sync error:", err);
      tvLog("SYNC_ERROR: " + (err && err.stack ? err.stack : String(err)));
      setStatus("Error: " + (err && err.message ? err.message : String(err)));
      if (allPhotos.length === 0) {
        els.photoDate.textContent = "Could not load Google Photos album";
      }
    }
  }

  function preloadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  async function renderSlide(slideItems) {
    if (!slideItems || slideItems.length === 0) return;

    var nextSlot = activeSlot === "a" ? "b" : "a";
    var nextSlideEl = nextSlot === "a" ? els.slideA : els.slideB;
    var curSlideEl = activeSlot === "a" ? els.slideA : els.slideB;
    var nextBackdrop = nextSlot === "a" ? els.backdropA : els.backdropB;
    var nextFrame = nextSlot === "a" ? els.frameA : els.frameB;

    var isPair = slideItems.length === 2;
    // -no suppresses any Google Photos server-side play icon overlays
    var sizeTag = isPair ? "=w1280-h1440-no" : "=w1920-h1080-no";

    try {
      var loadedImgs = await Promise.all(
        slideItems.map(function (item) {
          return preloadImage(item.url + sizeTag);
        })
      );

      // Configure blurred backdrop from primary photo
      nextBackdrop.style.backgroundImage = 'url("' + slideItems[0].url + '=w640-h360-no")';

      // Configure foreground layout class
      nextFrame.className = "photo-frame";
      if (isPair) {
        nextFrame.classList.add("pair-portraits");
      } else {
        var single = slideItems[0];
        var ratio = single.w / single.h;
        if (!single.isPortrait && prefs.landscapeMode === "smart" && ratio >= 1.45) {
          nextFrame.classList.add("full-bleed");
        } else {
          nextFrame.classList.add("single-contain");
        }
      }

      nextFrame.innerHTML = "";
      loadedImgs.forEach(function (img) {
        nextFrame.appendChild(img);
      });

      // Format Chromecast date caption
      var dates = slideItems.map(function (it) { return formatPhotoDate(it.ts); }).filter(Boolean);
      if (dates.length === 2 && dates[0] !== dates[1]) {
        els.photoDate.textContent = dates[0] + "   ·   " + dates[1];
      } else {
        els.photoDate.textContent = dates[0] || "";
      }

      // Crossfade buffers
      nextSlideEl.classList.add("active");
      curSlideEl.classList.remove("active");
      activeSlot = nextSlot;
    } catch (err) {
      console.warn("Skipping image that failed to load:", err);
      setTimeout(function () { showStep(1); }, 300);
    }
  }

  function showStep(delta) {
    if (deck.length === 0) return;
    deckIndex = (deckIndex + delta + deck.length) % deck.length;
    // Re-shuffle automatically once we complete a full pass through the deck
    if (delta > 0 && deckIndex === 0 && allPhotos.length > 2) {
      deck = buildShuffledDeck(allPhotos);
    }
    renderSlide(deck[deckIndex]);
  }

  function resetSlideTimer() {
    if (slideTimer) clearInterval(slideTimer);
    if (!isPaused) {
      slideTimer = setInterval(function () {
        showStep(1);
      }, prefs.intervalSec * 1000);
    }
  }

  function togglePause() {
    isPaused = !isPaused;
    els.btnPause.textContent = isPaused ? "▶ Resume" : "⏸ Pause";
    resetSlideTimer();
    wakeHud();
  }

  function reshuffleNow() {
    if (allPhotos.length === 0) return;
    deck = buildShuffledDeck(allPhotos);
    deckIndex = 0;
    renderSlide(deck[0]);
    resetSlideTimer();
    wakeHud();
  }

  // Auto-hide top control bar & mouse cursor when idle
  function wakeHud() {
    document.body.classList.remove("idle-cursor");
    els.controlsBar.classList.remove("hidden-hud");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (els.modal.classList.contains("hidden")) {
        els.controlsBar.classList.add("hidden-hud");
        document.body.classList.add("idle-cursor");
      }
    }, 3500);
  }

  function openSettings() {
    els.inpUrl.value = prefs.albumUrl;
    els.selInterval.value = String(prefs.intervalSec);
    els.selPortrait.value = prefs.portraitMode;
    els.selLandscape.value = prefs.landscapeMode;
    els.modal.classList.remove("hidden");
    wakeHud();
    els.selInterval.focus();
  }

  function closeSettings() {
    els.modal.classList.add("hidden");
    wakeHud();
  }

  function applySettings() {
    var prevUrl = prefs.albumUrl;
    prefs.albumUrl = normalizeAlbumInput(els.inpUrl.value);
    prefs.intervalSec = Number(els.selInterval.value) || 30;
    prefs.portraitMode = els.selPortrait.value;
    prefs.landscapeMode = els.selLandscape.value;
    savePrefs();
    closeSettings();

    if (prefs.albumUrl !== prevUrl) {
      allPhotos = [];
      deck = [];
      syncGooglePhotosAlbum();
    } else {
      deck = buildShuffledDeck(allPhotos);
      deckIndex = 0;
      renderSlide(deck[0]);
      resetSlideTimer();
    }
  }

  // Event Listeners (Works with Mac keyboard/mouse AND Samsung Tizen TV Remote!)
  document.addEventListener("mousemove", wakeHud);
  document.addEventListener("click", wakeHud);

  els.btnPrev.addEventListener("click", function () { showStep(-1); resetSlideTimer(); });
  els.btnNext.addEventListener("click", function () { showStep(1); resetSlideTimer(); });
  els.btnPause.addEventListener("click", togglePause);
  els.btnReshuffle.addEventListener("click", reshuffleNow);
  els.btnFullscreen.addEventListener("click", function () {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    } else {
      document.exitFullscreen().catch(function () {});
    }
  });
  els.btnSettings.addEventListener("click", openSettings);
  els.btnCancelSettings.addEventListener("click", closeSettings);
  els.btnSaveSettings.addEventListener("click", applySettings);

  document.addEventListener("keydown", function (e) {
    var modalOpen = !els.modal.classList.contains("hidden");
    if (modalOpen) {
      if (e.key === "Escape" || e.keyCode === 10009) { // 10009 = Samsung TV Return/Back
        e.preventDefault();
        closeSettings();
      }
      return;
    }

    wakeHud();
    if (e.key === "ArrowRight" || e.keyCode === 39 || e.keyCode === 417) {
      showStep(1);
      resetSlideTimer();
    } else if (e.key === "ArrowLeft" || e.keyCode === 37 || e.keyCode === 412) {
      showStep(-1);
      resetSlideTimer();
    } else if (e.key === " " || e.keyCode === 10252 || e.keyCode === 415 || e.keyCode === 19) {
      e.preventDefault();
      togglePause();
    } else if (e.key === "r" || e.key === "R") {
      reshuffleNow();
    } else if (e.key === "f" || e.key === "F") {
      els.btnFullscreen.click();
    } else if (e.key === "s" || e.key === "S" || e.key === "Enter" && document.activeElement === document.body) {
      openSettings();
    } else if (e.keyCode === 10009 && window.tizen) {
      // Samsung TV Back button exits app cleanly when modal isn't open
      try { tizen.application.getCurrentApplication().exit(); } catch (err) {}
    }
  });

  // Boot
  tvLog("BOOT href=" + window.location.href + " isTizen=" + isTizen);
  initTizenHardware();
  updateClock();
  setInterval(updateClock, 10000);
  wakeHud();
  syncGooglePhotosAlbum();
  setInterval(syncGooglePhotosAlbum, REFRESH_ALBUM_MS);
})();
