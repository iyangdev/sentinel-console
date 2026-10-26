/* ============================================================
   SENTINEL — console orchestration
   National public toll-road CCTV (BPJT) + representative BTS layer
   + in-browser AI vision engine.
   ============================================================ */
(function () {
  "use strict";

  const INDONESIA = [-2.5, 117.0];
  // toll-road cameras (BPJT registry) + city-street cameras (city ATCS/Dishub portals)
  const cams = (window.CCTV_CAMERAS || []).map(c => Object.assign({ kind: "toll" }, c))
    .concat(window.CITY_CCTV_CAMERAS || [])
    .map((c, i) => Object.assign({ _i: i }, c));
  const SOURCE = window.CCTV_SOURCE || {};
  const CITY_SOURCE = window.CITY_CCTV_SOURCE || {};
  const KIND_COLOR = { toll: "#37e39b", city: "#f5a524" };
  const bts = window.BTS_SITES || [];
  const BTS_SOURCE = window.BTS_SOURCE || {};
  const featured = cams.filter(c => c.featured != null).sort((a, b) => a.featured - b.featured);

  let map, imagery, labelsLayer, markerLayer, cityLayer, coverageLayer, heatLayer, btsLayer;
  const markers = {};
  const state = { city: "", q: "" };

  const OP_COLOR = { Telkomsel: "#ff4d5e", Indosat: "#f5a524", "XL Axiata": "#38bdf8", Tri: "#c084fc", Smartfren: "#37e39b" };

  const fmt = n => n.toLocaleString("id-ID");
  // clock and log times in WIB, whatever the viewer's own time zone
  const wib = t => new Date(t).toLocaleTimeString("en-GB", { timeZone: "Asia/Jakarta", hour12: false });
  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

  /* Live camera status. Markers, list rows, popups and counts all read camState(),
     which combines two kinds of check (see STREAM CHECKS):
       - a check of the camera's own stream, run for the cameras you look at;
       - a 2-camera sample per stream server, run for everything every 4 min.
     States: ok (video plays) · nostream (server answers, no playable video) ·
     down (server unreachable) · presumed (server fine, camera not checked itself) ·
     unknown (nothing checked yet: only the registry's own flag to go on). */
  const CHECK_EVERY = 4 * 60 * 1000;
  const camCheck = {};    // cam._i -> { st, why, at, src: "cam" }
  const hostCheck = {};   // host   -> { st, why, at, src: "host" }
  function hostOf(cam) { try { return cam.hls ? new URL(cam.hls).host : null; } catch (e) { return null; } }
  function camState(cam) {
    if (!cam.hls) return { st: "nostream", why: "Kamera ini tidak menyediakan stream publik.", src: "cam" };
    const c = camCheck[cam._i], h = hostCheck[hostOf(cam)];
    if (h && h.st === "down" && (!c || h.at >= c.at)) return h;   // server gone: nothing on it plays
    if (c && !(c.st === "down" && h && h.at > c.at)) return c;   // own result, unless a newer sweep reached its server
    if (h && h.st !== "ok") return h;                             // both sampled cameras failed
    return { st: h ? "presumed" : "unknown" };
  }
  const noVideo = cam => { const s = camState(cam).st; return s === "nostream" || s === "down"; };
  // a camera the registry marks inactive keeps its muted look until its own check passes
  const looksLive = cam => { const s = camState(cam).st; return s === "ok" || (cam.active && (s === "presumed" || s === "unknown")); };

  // "Sembunyikan tanpa video" takes cameras known to have no video off the map and
  // out of the list. The camera whose popup is open stays until the popup closes.
  let hideNoVideo = false, popupCam = null;
  const shown = cam => !hideNoVideo || cam === popupCam || !noVideo(cam);

  /* ---------------- MAP ---------------- */
  function initMap() {
    map = L.map("map", { zoomControl: true, attributionControl: true, minZoom: 5, maxZoom: 18, preferCanvas: true })
      .setView(INDONESIA, 5);

    imagery = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Imagery © Esri · CCTV © BPJT Kementerian PU · BTS: representative", maxZoom: 18 }
    ).addTo(map);

    labelsLayer = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 18, opacity: 0.9 }
    ).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    cityLayer = L.layerGroup().addTo(map);
    coverageLayer = L.layerGroup();
    heatLayer = L.layerGroup();
    btsLayer = L.layerGroup();

    map.on("move zoom", updateCoords);
    renderMarkers();
    fitTo(cams);
    updateCoords();
  }

  function fitTo(list) {
    const pts = list.filter(c => c.lat && c.lng).map(c => [c.lat, c.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  }

  function updateCoords() {
    const c = map.getCenter();
    document.getElementById("map-coords").textContent =
      `LAT ${c.lat.toFixed(4)} · LNG ${c.lng.toFixed(4)} · ZOOM ${map.getZoom()}`;
  }

  function featuredIcon(cam) {
    const cls = ["cam-marker"];
    if (noVideo(cam)) cls.push("down");
    else if (!looksLive(cam)) cls.push("offline");
    if (cam.kind === "city") cls.push("city");
    return L.divIcon({
      className: "",
      html: `<div class="${cls.join(" ")}"><span class="ping"></span><span class="core"></span></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7]
    });
  }

  // marker look for a non-featured camera: live (kind colour), muted (registry
  // says inactive, not checked), or dimmed (no video)
  function circleStyle(cam) {
    if (noVideo(cam)) return { color: "#55606b", fillColor: "#55606b", opacity: 0.4, fillOpacity: 0.12 };
    const live = looksLive(cam), col = live ? KIND_COLOR[cam.kind] : "#6f8a7e";
    return { color: col, fillColor: col, opacity: 0.85, fillOpacity: live ? 0.5 : 0.25 };
  }

  const layerOf = cam => cam.kind === "city" ? cityLayer : markerLayer;

  function renderMarkers() {
    markerLayer.clearLayers();
    cityLayer.clearLayers();
    cams.forEach(cam => {
      let m;
      if (cam.featured != null) {
        m = L.marker([cam.lat, cam.lng], { icon: featuredIcon(cam), zIndexOffset: 1000 });
      } else {
        m = L.circleMarker([cam.lat, cam.lng], Object.assign({ radius: 3.5, weight: 1 }, circleStyle(cam)));
      }
      if (shown(cam)) m.addTo(layerOf(cam));
      m.bindPopup(() => popupHtml(cam));   // built on open, so it shows the current status
      m.on("popupopen", () => {
        popupCam = cam;
        wirePopup(cam);
        ensureEngine().preloadModel();   // head start on the AI model before the feed opens
        queueCheck(cam, true);           // and check this camera's own stream right away
      });
      m.on("popupclose", () => {
        if (popupCam === cam) popupCam = null;
        // a camera found to have no video while its popup was open may leave now,
        // once Leaflet has finished closing the popup
        setTimeout(() => { if (syncShown(cam)) scheduleList(); }, 0);
      });
      markers[cam._i] = m;
    });
  }

  // Puts a camera's marker on or off its layer to match shown(); true if that changed.
  function syncShown(cam) {
    const m = markers[cam._i], layer = layerOf(cam), show = shown(cam);
    if (!m || show === layer.hasLayer(m)) return false;
    if (show) layer.addLayer(m); else layer.removeLayer(m);
    return true;
  }

  function wirePopup(cam) {
    const btn = document.querySelector(".popup-btn[data-i='" + cam._i + "']");
    if (btn) btn.onclick = () => openCamera(cam);
  }

  const STATE_LABEL = {
    ok:       ["VIDEO TERSEDIA", "var(--accent)"],
    presumed: ["SERVER AKTIF", "var(--text-dim)"],
    unknown:  ["BELUM DICEK", "var(--text-faint)"],
    nostream: ["TANPA VIDEO", "var(--amber)"],
    down:     ["SERVER TIDAK MERESPONS", "var(--red)"]
  };
  // Jasa Marga shows its cameras in its own Travoy app ("CCTV Real Time" on the official page)
  const JM_HOST = "jmlive.jasamarga.com", TRAVOY_URL = "https://www.jasamarga.com/inovasi-teknologi/travoy";
  function popupHtml(cam) {
    const kind = cam.kind === "city" ? "CCTV KOTA" : "CCTV TOL";
    const s = camState(cam);
    const [label, col] = STATE_LABEL[s.st];
    const detail = pending.has(cam._i) ? "mengecek kamera ini…"
      : s.st === "ok" ? `dicek ${wib(s.at)} WIB`
      : s.st === "presumed" ? "kamera lain di server ini berjalan; kamera ini belum dicek"
      : s.st === "unknown" ? (cam.active ? "menunggu pengecekan" : "registry: nonaktif")
      : s.why + (s.src === "host" ? " (hasil cek server)" : "");
    return `<div class="popup-title" style="color:${KIND_COLOR[cam.kind]}">${esc(cam.name) || "CCTV"}</div>
      <div class="popup-row">${kind} · ${esc(cam.city)} · ${esc(cam.road)}</div>
      <div class="popup-row">${esc(cam.opName)}</div>
      <div class="popup-row" style="color:${col}">● ${label} <span style="color:var(--text-faint)">· ${esc(detail)}</span></div>
      ${hostOf(cam) === JM_HOST ? `<div class="popup-note">Tayangan resmi CCTV Jasa Marga ada di aplikasi <a href="${TRAVOY_URL}" target="_blank" rel="noopener">Travoy</a>.</div>` : ""}
      <div class="popup-btn" data-i="${cam._i}">▶ OPEN AI FEED</div>`;
  }

  /* lazily built heavy overlays */
  function buildCoverage() {
    if (coverageLayer.getLayers().length) return;
    cams.forEach(cam => { if (cam.active) L.circle([cam.lat, cam.lng], { radius: 350, color: "#37e39b", weight: 1, opacity: 0.25, fillColor: "#37e39b", fillOpacity: 0.03 }).addTo(coverageLayer); });
  }
  function buildHeat() {
    if (heatLayer.getLayers().length) return;
    cams.forEach(cam => { if (cam.active) L.circle([cam.lat, cam.lng], { radius: 900, stroke: false, fillColor: "#f5a524", fillOpacity: 0.06 }).addTo(heatLayer); });
  }
  function buildBts() {
    if (btsLayer.getLayers().length) return;
    const BTS = "#c084fc";   // single colour so BTS reads distinctly from CCTV green
    bts.forEach(s => {
      const col = OP_COLOR[s.operator] || BTS;
      const m = L.circleMarker([s.lat, s.lng], {
        radius: s.g === "5G" ? 4 : 3, color: BTS, weight: 1, opacity: 0.9,
        fillColor: BTS, fillOpacity: s.g === "5G" ? 0.5 : 0.3
      });
      m.bindPopup(
        `<div class="popup-title" style="color:${col}">▲ ${esc(s.operator)}</div>
         <div class="popup-row">${esc(s.id)} · ${esc(s.city)}</div>
         <div class="popup-row">${esc(s.band)} MHz · ${esc(s.g)} · cell ~${s.radius} m</div>
         <div class="popup-row" style="color:var(--text-faint);margin-top:4px">Representative site · infrastructure layer only</div>`
      );
      m.addTo(btsLayer);
    });
  }

  /* ---------------- STREAM CHECKS ---------------- */
  // What a camera's stream really delivers, tested the way hls.js loads it:
  // playlist → variant → newest segment, each readable from this page. A server
  // that answers with an empty body or a 404 is "nostream"; only one that doesn't
  // answer at all (DNS, refused, TLS, timeout) is "down". An http stream can't
  // load on this https page, so that counts as "down" too.
  const isPlaylist = t => /^﻿?\s*#EXTM3U/.test(t || "");
  const uriLines = t => t.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));

  async function fetchHop(url, wantText) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      return { status: r.status, url: r.url || url, text: wantText ? await r.text() : "" };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
      ctrl.abort();   // a segment only needs its headers, not its body
    }
  }

  // Did the server answer at all? An opaque no-cors reply still counts.
  async function answers(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try { await fetch(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal }); return true; }
    catch (e) { return false; }
    finally { clearTimeout(timer); ctrl.abort(); }
  }

  async function checkStream(url) {
    if (location.protocol === "https:" && /^http:\/\//i.test(url))
      return { st: "down", why: "Stream http tidak bisa dibuka dari halaman https." };
    const hop = async (u, wantText) => {
      const r = await fetchHop(u, wantText);
      if (r) return { r };
      return { fail: (await answers(u))
        ? { st: "nostream", why: "Server menjawab, tapi browser tidak diizinkan membaca streamnya." }
        : { st: "down", why: "Server tidak merespons." } };
    };
    let x = await hop(url, true);
    if (x.fail) return x.fail;
    if (x.r.status !== 200) return { st: "nostream", why: `Server menjawab ${x.r.status}: stream tidak ditemukan.` };
    if (!isPlaylist(x.r.text)) return { st: "nostream", why: x.r.text.trim() ? "Server menjawab, tapi isinya bukan video." : "Server menjawab, tapi isinya kosong." };
    let base = x.r.url, list = x.r.text;
    if (list.includes("#EXT-X-STREAM-INF")) {          // master playlist: follow the first variant
      const v = uriLines(list)[0];
      if (!v) return { st: "nostream", why: "Playlist tanpa varian video." };
      x = await hop(new URL(v, base).href, true);
      if (x.fail) return x.fail;
      if (x.r.status !== 200 || !isPlaylist(x.r.text)) return { st: "nostream", why: "Varian video tidak tersedia." };
      base = x.r.url; list = x.r.text;
    }
    const segs = uriLines(list);
    if (!segs.length) return { st: "nostream", why: "Playlist belum berisi potongan video." };
    x = await hop(new URL(list.includes("#EXT-X-ENDLIST") ? segs[0] : segs[segs.length - 1], base).href, false);
    if (x.fail) return x.fail;
    if (x.r.status !== 200 && x.r.status !== 206) return { st: "nostream", why: `Potongan video gagal dimuat (${x.r.status}).` };
    return { st: "ok", why: "" };
  }
  const safeCheck = url => checkStream(url).catch(() => ({ st: "nostream", why: "Playlist tidak bisa dibaca." }));

  // Per-camera checks run four at a time, so no camera server gets a burst.
  const queue = [], pending = new Set();
  let workers = 0;
  function queueCheck(cam, urgent) {
    if (!cam.hls) return;
    const c = camCheck[cam._i], h = hostCheck[hostOf(cam)], now = Date.now();
    if (c && now - c.at < CHECK_EVERY) return;                      // fresh enough
    if (h && h.st === "down" && now - h.at < CHECK_EVERY) return;   // server is gone; the next sweep retries it
    if (pending.has(cam._i)) {                                      // already waiting: maybe jump the line
      const k = queue.indexOf(cam);
      if (urgent && k > 0) { queue.splice(k, 1); queue.unshift(cam); }
      return;
    }
    pending.add(cam._i);
    if (urgent) queue.unshift(cam); else queue.push(cam);
    refreshPopup(cam);
    while (workers < 4 && queue.length) runChecks();
  }
  async function runChecks() {
    workers++;
    while (queue.length) {
      const cam = queue.shift();
      const res = await safeCheck(cam.hls);
      pending.delete(cam._i);
      recordCheck(cam, res);
    }
    workers--;
  }

  function recordCheck(cam, res) {
    camCheck[cam._i] = { st: res.st, why: res.why, at: Date.now(), src: "cam" };
    // a camera that plays proves its server answers, whatever the last sweep said
    const host = hostOf(cam), h = hostCheck[host];
    if (res.st === "ok" && h && h.st === "down") {
      Object.assign(h, { st: "ok", why: "", at: Date.now() });
      cams.forEach(c => { if (hostOf(c) === host) restyle(c); });
    } else restyle(cam);
    scheduleCounts();
  }

  // A feed that plays or fails is the most direct check there is: record it.
  function noteFeed(cam, ok, why) {
    if (!cam || !cam.hls) return;
    recordCheck(cam, ok ? { st: "ok", why: "" } : { st: "nostream", why: why || "Feed gagal diputar." });
  }

  // Re-style one camera everywhere it shows, in place: marker, list row, open popup.
  const rowOf = cam => document.querySelector(`#camera-list .cam-item[data-i='${cam._i}']`);
  function restyle(cam, row = rowOf(cam)) {
    const m = markers[cam._i];
    if (m) { if (cam.featured != null) m.setIcon(featuredIcon(cam)); else m.setStyle(circleStyle(cam)); }
    if (row) { row.querySelector(".stat-led").className = ledClass(cam); row.lastElementChild.outerHTML = rowTag(cam); }
    if (syncShown(cam)) scheduleList();
    refreshPopup(cam);
  }
  function restyleAll() {
    const rows = {};
    document.querySelectorAll("#camera-list .cam-item").forEach(r => { rows[r.dataset.i] = r; });
    cams.forEach(cam => restyle(cam, rows[cam._i] || null));
  }
  function refreshPopup(cam) {
    const m = markers[cam._i];
    if (m && m.isPopupOpen()) { m.getPopup().update(); wirePopup(cam); }
  }

  let countsTimer = null, listTimer = null;
  function scheduleCounts() { if (!countsTimer) countsTimer = setTimeout(() => { countsTimer = null; updateCounts(); }, 400); }
  function scheduleList() { if (!listTimer) listTimer = setTimeout(() => { listTimer = null; renderList(); }, 400); }
  function tally() {
    let live = 0, none = 0;
    cams.forEach(c => { if (noVideo(c)) none++; else if (looksLive(c)) live++; });
    return { live, none, muted: cams.length - live - none };
  }
  function updateCounts() {
    if (!Object.keys(hostCheck).length) return;     // first sweep still running
    const t = tally();
    setText("svr-status", `Video tersedia: ${fmt(t.live)} kamera · tanpa video: ${fmt(t.none)}${hideNoVideo ? " (disembunyikan)" : ""}`
      + (t.muted ? ` · nonaktif (registry): ${fmt(t.muted)}` : ""));
    setText("hdr-live", `${fmt(t.live)} / ${fmt(cams.length)}`);
  }

  function hostCameras() {
    const groups = {};
    cams.forEach(c => { const h = hostOf(c); if (h) (groups[h] = groups[h] || []).push(c); });
    return groups;
  }

  // resolves once every queued per-camera check has finished
  const queueDrained = () => new Promise(res => {
    const t = setInterval(() => { if (!queue.length && !workers) { clearInterval(t); res(); } }, 300);
  });

  // Every 4 min: sample up to three cameras per server, spread over its list (the
  // first is a curated or registry-active one). If none plays, the server's verdict
  // covers its cameras until they're checked one by one. If some play and some
  // don't, a small server gets every camera checked: one working patch must not
  // vouch for dead cameras next to it.
  async function sweepServers() {
    const groups = hostCameras(), first = !Object.keys(hostCheck).length, mixed = [];
    await Promise.all(Object.entries(groups).map(async ([host, list]) => {
      const order = list.slice()
        .sort((a, b) => (a.featured ?? 999) - (b.featured ?? 999) || (b.active ? 1 : 0) - (a.active ? 1 : 0));
      const sample = [...new Set([order[0], order[Math.floor((order.length - 1) / 2)], order[order.length - 1]])];
      const res = await Promise.all(sample.map(c => safeCheck(c.hls)));
      const oks = res.filter(r => r.st === "ok").length;
      if (oks && oks < res.length && list.length <= 60) mixed.push(...list);
      const now = Date.now();
      sample.forEach((c, k) => { camCheck[c._i] = { st: res[k].st, why: res[k].why, at: now, src: "cam" }; });
      const best = res.find(r => r.st === "ok") || res.find(r => r.st === "nostream") || res[0];
      const prev = hostCheck[host];
      hostCheck[host] = { st: best.st, why: best.why, at: now, src: "host" };
      if (prev && prev.st !== best.st) addEvent(best.st === "ok" ? "info" : "warn", {
        ok: `Server ${host} kembali mengirim video`,
        nostream: `Server ${host} menjawab tanpa video`,
        down: `Server ${host} tidak merespons`
      }[best.st] + ` · ${fmt(list.length)} kamera`);
    }));
    mixed.forEach(c => queueCheck(c));
    if (first && mixed.length) await queueDrained();   // so the first summary counts them
    restyleAll();
    updateCounts();
    renderPresets();
    if (first) {
      const t = tally();
      addEvent(t.none ? "warn" : "info", `Cek video selesai · ${fmt(t.live)} kamera bervideo, ${fmt(t.none)} tanpa video (${Object.keys(groups).length} server)`);
    }
    checkVisible();
  }

  // The cameras you're actually looking at get checked one by one, nearest the
  // centre first. Zoomed out there are too many dots; the server sample covers them.
  function checkVisible() {
    if (map.getZoom() < 11) return;
    const view = map.getBounds(), mid = map.getCenter();
    cams.filter(c => c.hls && c.lat && c.lng && view.contains([c.lat, c.lng]) && map.hasLayer(layerOf(c)))
      .sort((a, b) => mid.distanceTo([a.lat, a.lng]) - mid.distanceTo([b.lat, b.lng]))
      .slice(0, 40)
      .forEach(c => queueCheck(c));
  }

  function startChecks() {
    setTimeout(sweepServers, 1500);                 // let the map paint first
    setInterval(sweepServers, CHECK_EVERY);
    let t;
    map.on("moveend", () => { clearTimeout(t); t = setTimeout(checkVisible, 600); });
  }

  /* ---------------- CITY SELECTOR + LIST ---------------- */
  function initCitySelect() {
    const counts = {};
    cams.forEach(c => { counts[c.city] = (counts[c.city] || 0) + 1; });
    const places = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const sel = document.getElementById("city-select");
    sel.innerHTML = `<option value="">Semua wilayah — ${cams.length} CCTV</option>`
      + places.map(p => `<option value="${esc(p)}">${esc(p)} · ${counts[p]}</option>`).join("");
    sel.onchange = () => {
      state.city = sel.value;
      setText("hdr-region", state.city ? state.city.toUpperCase() : "INDONESIA");
      renderList();
      const inCity = cams.filter(c => !state.city || c.city === state.city), vis = inCity.filter(shown);
      fitTo(vis.length ? vis : inCity.length ? inCity : cams);
    };
  }

  function camMatches(cam) {
    if (state.city && cam.city !== state.city) return false;
    if (!state.q) return true;
    return (cam.name + " " + cam.road + " " + cam.opName + " " + cam.city + " " + cam.id).toLowerCase().includes(state.q);
  }

  const ledClass = cam => `stat-led led-${noVideo(cam) ? "down" : looksLive(cam) ? "online" : "offline"}${cam.kind === "city" ? " kind-city" : ""}`;
  // "LIVE" marks the curated cameras, but only while they actually have video
  const rowTag = cam => (cam.featured != null && !noVideo(cam)) ? `<span class="badge-live">LIVE</span>` : `<span class="cid">${esc(cam.city)}</span>`;

  function renderList() {
    const el = document.getElementById("camera-list");
    const matched = cams.filter(camMatches);
    const list = matched.filter(shown)
      .sort((a, b) => (a.featured ?? 999) - (b.featured ?? 999) || a.city.localeCompare(b.city) || a.road.localeCompare(b.road));
    const hidden = matched.length - list.length;
    el.innerHTML = list.slice(0, 400).map(cam => `<div class="cam-item" data-i="${cam._i}">
        <span class="${ledClass(cam)}"></span>
        <div class="meta"><div class="nm">${esc(cam.name) || "CCTV"}</div><div class="sb">${esc(cam.road)} · ${esc(cam.opName)}</div></div>
        ${rowTag(cam)}</div>`).join("")
      + (hidden ? `<div class="cam-hidden">${fmt(hidden)} kamera tanpa video disembunyikan</div>` : "");
    el.querySelectorAll(".cam-item").forEach(row => {
      const cam = cams[+row.dataset.i];
      row.onclick = () => { map.flyTo([cam.lat, cam.lng], 16, { duration: 0.8 }); const mk = markers[cam._i]; if (mk) mk.openPopup(); };
    });
    document.getElementById("cam-count").textContent = list.length;
  }

  function initFilter() {
    const inp = document.getElementById("cam-filter");
    let t;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(() => { state.q = inp.value.trim().toLowerCase(); renderList(); }, 120); };
  }

  function initSourceNote() {
    const el = document.getElementById("src-note");
    if (!el) return;
    const citySrc = (CITY_SOURCE.sources || []).filter(s => s.count)
      .map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a> (${s.count})`).join(", ");
    const portals = (CITY_SOURCE.portals || [])
      .map(p => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.city)} — ${esc(p.name)}</a> <span style="opacity:.7">(${esc(p.reason)})</span>`).join("<br>");
    el.innerHTML = `CCTV tol: <a href="${esc(SOURCE.url || "#")}" target="_blank" rel="noopener">BPJT · Kementerian PU</a> — `
      + `${SOURCE.count || 0} cameras (snapshot ${esc(SOURCE.snapshot || "—")}`
      + (SOURCE.fixed ? `; ${SOURCE.fixed} stream URLs corrected from operator sites` : "") + `).<br>`
      + (citySrc ? `CCTV kota: ${citySrc}.<br>` : "")
      + `BTS: ${bts.length} <em>representative</em> cell-sites — illustrative infrastructure, not real coordinates and not linked to any device.<br>`
      + `Generic traffic analytics only — no face recognition, no plate reading, no identity tracking.`
      + (portals ? `<div style="margin-top:8px">Portal resmi (lihat langsung di situsnya):<br>${portals}</div>` : "");
  }

  /* ---------------- LAYER TOGGLES ---------------- */
  function initToggles() {
    document.querySelectorAll(".toggle-row").forEach(row => {
      row.onclick = () => {
        row.classList.toggle("on");
        const on = row.classList.contains("on");
        const layer = row.dataset.layer;
        if (layer === "cctv") on ? markerLayer.addTo(map) : map.removeLayer(markerLayer);
        if (layer === "citycctv") on ? cityLayer.addTo(map) : map.removeLayer(cityLayer);
        if (layer === "novideo") setHideNoVideo(on);
        if (layer === "labels") on ? labelsLayer.addTo(map) : map.removeLayer(labelsLayer);
        if (layer === "heat") { if (on) { buildHeat(); heatLayer.addTo(map); } else map.removeLayer(heatLayer); }
        if (layer === "coverage") { if (on) { buildCoverage(); coverageLayer.addTo(map); } else map.removeLayer(coverageLayer); }
        if (layer === "bts") { if (on) { buildBts(); btsLayer.addTo(map); } else map.removeLayer(btsLayer); }
      };
    });
  }

  function setHideNoVideo(on) {
    hideNoVideo = on;
    cams.forEach(c => syncShown(c));
    renderList();
    updateCounts();
  }

  function initTabs() {
    document.querySelectorAll(".tab").forEach(t => {
      t.onclick = () => { document.querySelectorAll(".tab").forEach(x => x.classList.remove("active")); t.classList.add("active"); };
    });
  }

  /* ---------------- AI ANALYSIS (real detections only) ---------------- */
  // The right panel and the timeline show what the AI engine actually saw in the
  // feeds you opened, never made-up numbers. A "run" is one source played from
  // start to stop; once the feed closes the panel keeps showing that run. The SIM
  // scene is left out: it is labelled as a simulation inside the feed itself.
  const CLASS_LABELS = [
    ["person", "Orang", "c-person"], ["car", "Mobil", ""], ["motorcycle", "Motor", ""],
    ["bus", "Bus", ""], ["truck", "Truk", ""], ["bicycle", "Sepeda", ""]
  ];
  const SERIES_SECS = 120;
  // one decimal; a small non-zero average reads "<0,1" so it doesn't look like nothing was seen
  const dec = x => (x > 0 && x < 0.05 ? "<0,1" : (Math.round(x * 10) / 10).toLocaleString("id-ID"));
  const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} dtk` : `${Math.floor(s / 60)} mnt ${s % 60} dtk`; };
  let run = null, panelAt = 0;

  function startRun(label) {
    endRun();
    run = { label, start: Date.now(), end: 0, frames: 0, sumP: 0, sumV: 0, peakP: 0, peakV: 0,
            by: {}, recent: [], series: [], sec: 0, secSum: 0, secN: 0 };
    renderPanel();
    drawSpark();
  }

  function endRun() {
    if (!run || run.end) return;
    run.end = Date.now();
    if (run.frames) addEvent("info", `Analisis selesai · ${run.label} · ${dur(run.end - run.start)}, `
      + `rata-rata ${dec(run.sumV / run.frames)} kendaraan/frame (puncak ${run.peakV})`);
    renderPanel();
    drawSpark();
  }

  function recordStats(s) {
    if (!run || run.end) return;
    const now = Date.now();
    run.frames++;
    run.sumP += s.people; run.sumV += s.vehicles;
    run.peakP = Math.max(run.peakP, s.people); run.peakV = Math.max(run.peakV, s.vehicles);
    for (const k in s.byClass) run.by[k] = (run.by[k] || 0) + s.byClass[k];
    run.recent.push({ t: now, p: s.people, v: s.vehicles });
    while (now - run.recent[0].t > 10000) run.recent.shift();
    // one timeline bar per second: the average vehicles in frame during that second
    const sec = Math.floor(now / 1000);
    if (sec !== run.sec) {
      if (run.secN) { run.series.push(run.secSum / run.secN); if (run.series.length > SERIES_SECS) run.series.shift(); }
      run.sec = sec; run.secSum = 0; run.secN = 0;
    }
    run.secSum += s.vehicles; run.secN++;
    if (now - panelAt > 500) { panelAt = now; renderPanel(); drawSpark(); }
  }

  function renderPanel() {
    const live = !!run && !run.end;
    let p = "—", v = "—", sub;
    if (!run) sub = "Belum ada analisis. Klik titik kamera di peta, lalu ▶ OPEN AI FEED: hasil deteksi nyata muncul di sini.";
    else if (!run.frames) sub = live ? "Menunggu frame pertama dianalisis…" : "Feed berhenti sebelum ada frame yang dianalisis.";
    else {
      const win = live ? run.recent : null;   // live: the last 10 s · finished: the whole run
      const n = win ? win.length : run.frames;
      p = dec((win ? win.reduce((a, r) => a + r.p, 0) : run.sumP) / n);
      v = dec((win ? win.reduce((a, r) => a + r.v, 0) : run.sumV) / n);
      sub = `${win ? "Rata-rata 10 detik terakhir" : "Rata-rata seluruh analisis"} · puncak ${run.peakV} kendaraan, `
        + `${run.peakP} orang · ${dur((run.end || Date.now()) - run.start)}`;
    }
    setText("ai-src", run ? `${live ? "● LIVE" : "■ SELESAI"} · ${run.label}` : "Belum ada analisis");
    setText("agg-people", p);
    setText("agg-vehicles", v);
    setText("ai-sub", sub);
    renderClassBars();
  }

  function renderClassBars() {
    const n = run ? run.frames : 0;
    const vals = CLASS_LABELS.map(([k]) => (n ? (run.by[k] || 0) / n : 0));
    const max = Math.max(...vals, 0.001);
    document.getElementById("class-bars").innerHTML = CLASS_LABELS.map(([, label, cls], i) =>
      `<div class="cbar ${cls}"><div class="top"><span class="lbl">${label}</span><span class="n">${n ? dec(vals[i]) : "—"}</span></div>
        <div class="track"><div class="fill" style="width:${Math.round((vals[i] / max) * 100)}%"></div></div></div>`).join("");
  }

  /* ---------------- EVENT LOG ---------------- */
  // Only things that actually happened: feeds opened, live or failed, servers
  // changing state, analysis summaries, and the engine's own density alerts.
  function addEvent(sev, msg) {
    const feed = document.getElementById("ai-events");
    const row = document.createElement("div");
    row.className = `event sev-${sev} new`;
    row.innerHTML = `<span class="t">${wib(Date.now())}</span><span class="msg">${esc(msg)}</span>`;
    feed.prepend(row);
    while (feed.children.length > 40) feed.removeChild(feed.lastChild);
    if (sev === "alert") flashPill("▲ PERINGATAN AI");
  }

  // Header pill: what the AI engine is doing right now; alerts flash over it briefly.
  let pillBase = "● AI SIAGA", pillTimer = null;
  function setPill(text) { pillBase = text; if (!pillTimer) setText("alert-pill", text); }
  function flashPill(text) {
    const pill = document.getElementById("alert-pill");
    pill.textContent = text; pill.classList.add("warn");
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => { pillTimer = null; pill.textContent = pillBase; pill.classList.remove("warn"); }, 4000);
  }

  /* ---------------- TIMELINE ---------------- */
  // Vehicles in frame, one bar per second, for the latest analysis run.
  function drawSpark() {
    const cv = document.getElementById("spark");
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight || 30;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const data = run ? run.series : [];
    setText("spark-rng", data.length ? `kendaraan di frame per detik · ${run.label}` : "belum ada analisis — buka feed AI sebuah kamera");
    if (!data.length) return;
    const max = Math.max(...data, 1), bw = w / SERIES_SECS;
    data.forEach((v, i) => {
      const bh = Math.max(1, (v / max) * (h - 4));
      const x = (SERIES_SECS - data.length + i) * bw;   // newest at the right edge
      ctx.fillStyle = i === data.length - 1 && !run.end ? "#37e39b" : "rgba(55,227,155,0.35)";
      ctx.fillRect(x + 1, h - bh, Math.max(1, bw - 2), bh);
    });
  }
  function tickClock() { setText("clock", wib(Date.now())); }

  /* ---------------- CAMERA MODAL + AI ENGINE ---------------- */
  // openedCam: the camera the user clicked. currentCam: whatever is playing now
  // (another camera picked from "Sumber lain", or null for a custom URL).
  let engine = null, openedCam = null, currentCam = null, lastSource = null;
  function ensureEngine() {
    if (engine) return engine;
    engine = new VisionEngine(document.getElementById("cam-canvas"), document.getElementById("cam-video"), {
      onStats: onEngineStats, onStatus: onEngineStatus,
      // the engine's alerts come from real detections: say which feed they came from
      onEvent: (sev, msg) => addEvent(sev, run && !run.end ? `${msg} · ${run.label}` : msg)
    });
    return engine;
  }
  function initPresets() {
    const sel = document.getElementById("hls-preset");
    renderPresets();
    sel.onchange = () => { if (!sel.value) return; document.getElementById("hls-url").value = sel.value; play("hls", sel.value); };
  }
  // curated cameras for "Sumber lain"; ones without video are marked, not hidden
  function renderPresets() {
    const sel = document.getElementById("hls-preset"), keep = sel.value;
    sel.innerHTML = `<option value="">— kamera live lain —</option>`
      + featured.map(c => `<option value="${esc(c.hls)}">${esc(c.city)} · ${esc(c.name)}${noVideo(c) ? " (tanpa video)" : ""}</option>`).join("");
    sel.value = keep;
  }

  const camNote = cam => (cam.kind === "city"
    ? `Kamera lalu lintas kota (${cam.opName.split(" · ")[0]})`
    : "Kamera lalu lintas jalan tol (BPJT)") + " · deteksi objek umum, tanpa identifikasi biometrik";

  function setHeader(cam) {
    document.getElementById("cam-title").textContent = cam ? (cam.name || "CCTV") : "Stream HLS pilihan";
    document.getElementById("cam-id").textContent = cam ? `${cam.city} · ${cam.road} · ${cam.opName}` : "";
  }

  // Clicking a camera plays it straight away; "Sumber lain" only changes the source.
  function openCamera(cam) {
    openedCam = cam;
    document.getElementById("hls-url").value = cam.hls || "";
    document.getElementById("hls-preset").value = featured.some(f => f.hls === cam.hls) ? cam.hls : "";
    document.getElementById("adv").open = false;
    document.getElementById("cam-modal").classList.add("open");
    if (cam.hls) play("hls", cam.hls);
    else { currentCam = cam; setHeader(cam); ensureEngine().stop(); onEngineStatus("offline", "Kamera ini tidak menyediakan stream publik."); }
    addEvent("info", `Feed AI dibuka · ${cam.name} (${cam.city})`);
  }

  function play(mode, arg) {
    endRun();   // a new source ends the previous analysis run
    lastSource = { mode, arg };
    // "Kamera ini" lights up only while the clicked camera itself is playing
    setSrcActive(mode === "hls"
      ? (openedCam && arg === openedCam.hls ? "btn-hls" : null)
      : { sim: "btn-sim", webcam: "btn-webcam", file: "btn-file" }[mode]);
    const note = document.getElementById("cam-note");
    if (mode === "hls") {
      currentCam = cams.find(c => c.hls === arg) || null;
      setHeader(currentCam);
      note.textContent = currentCam ? camNote(currentCam) : "Stream HLS pilihan · deteksi objek umum, tanpa identifikasi biometrik";
    } else {
      currentCam = openedCam;
      setHeader(openedCam);
      note.textContent = {
        sim: "SIMULASI — adegan buatan, bukan rekaman kamera ini",
        webcam: "Webcam kamu · deteksi objek umum, tanpa identifikasi biometrik",
        file: "File video lokal · deteksi objek umum, tanpa identifikasi biometrik"
      }[mode];
    }
    document.querySelector("#cam-modal .feed-top .rec").lastChild.textContent = mode === "sim" ? " SIM" : " REC";
    if (mode !== "sim") onEngineStatus("connecting", mode === "webcam" ? "Meminta akses webcam…" : "Menghubungkan…");
    ensureEngine().start(mode, arg);
  }

  function closeCamera() {
    if (engine) engine.stop();
    endRun();
    setPill("● AI SIAGA");
    document.getElementById("cam-modal").classList.remove("open");
  }
  function setSrcActive(id) { ["btn-hls", "btn-sim", "btn-webcam", "btn-file"].forEach(b => document.getElementById(b).classList.toggle("active", b === id)); }

  // What the video area shows for each engine state; "ready" means live, so no overlay.
  const OVERLAY = {
    loading:    { spin: true, title: "Memuat model AI…", sub: "Hanya di awal, sekitar 10–20 detik." },
    connecting: { spin: true, title: "Menghubungkan ke kamera…" },
    offline:    { icon: "⚠", title: "Kamera sedang offline", retry: "Coba lagi", other: true,
                  sub: "Kamera ini tidak mengirim video saat ini. Banyak kamera berbagi server yang sama, jadi satu kota bisa mati bersamaan. Titik abu-abu di peta berarti tanpa video; coba titik yang berwarna." },
    paused:     { icon: "❚❚", title: "Feed dijeda", retry: "Lanjutkan" },
    idle:       { icon: "■", title: "Feed dihentikan", retry: "Putar lagi" }
  };
  const PILL = { loading: "● AI MEMUAT", connecting: "● MENYAMBUNG" };

  function onEngineStatus(stt, text) {
    const st = document.getElementById("model-status");
    st.className = "model-status " + ({ ready: "ready", loading: "loading", connecting: "loading", offline: "err" }[stt] || "");
    document.getElementById("model-text").textContent = text;
    document.querySelector("#cam-modal .feed-top .rec").hidden = stt !== "ready";

    // the clicked camera's own stream, not SIM / webcam / a file played over it
    const camFeed = lastSource && lastSource.mode === "hls" && currentCam && lastSource.arg === currentCam.hls ? currentCam : null;
    const sim = !!lastSource && lastSource.mode === "sim";
    if (stt === "ready") {
      setPill(sim ? "● SIMULASI" : "● AI AKTIF");
      if (!sim && (!run || run.end)) {
        startRun(camFeed ? `${camFeed.name} (${camFeed.city})`
          : ({ webcam: "Webcam kamu", file: "File video" }[lastSource.mode] || "Stream HLS pilihan"));
        if (camFeed) { noteFeed(camFeed, true); addEvent("info", `Feed live · ${camFeed.name} (${camFeed.city})`); }
      }
    } else {
      setPill(PILL[stt] || "● AI SIAGA");
      if (stt !== "loading" && stt !== "connecting") endRun();
    }
    if (stt === "offline") {
      if (camFeed) noteFeed(camFeed, false, text);
      if (currentCam) addEvent("warn", `Feed offline · ${currentCam.name} (${currentCam.city})`);
    }

    const o = OVERLAY[stt];
    document.getElementById("feed-overlay").hidden = !o;
    if (!o) return;
    document.getElementById("fo-spin").hidden = !o.spin;
    document.getElementById("fo-icon").textContent = o.icon || "";
    document.getElementById("fo-title").textContent = o.title;
    document.getElementById("fo-sub").textContent = o.sub || (o.spin ? "" : text);
    const retry = document.getElementById("fo-retry");
    retry.hidden = !o.retry;
    retry.textContent = o.retry || "";
    document.getElementById("fo-other").hidden = !(o.other && featured.length);
    resetMetrics();
  }

  function resetMetrics() {
    ["m-people", "m-vehicles", "m-fps"].forEach(id => { document.getElementById(id).textContent = "—"; });
    document.getElementById("det-list").innerHTML = "";
  }
  function onEngineStats(s) {
    document.getElementById("m-people").textContent = s.people;
    document.getElementById("m-vehicles").textContent = s.vehicles;
    document.getElementById("m-fps").textContent = s.fps;
    const rows = Object.entries(s.byClass).sort((a, b) => b[1] - a[1]);
    document.getElementById("det-list").innerHTML = rows.length
      ? rows.map(([c, n]) => `<div class="det-row"><span class="cls">${esc(c.toUpperCase())}</span><span class="conf">× ${n}</span></div>`).join("")
      : `<div class="det-row"><span class="cls" style="color:var(--text-faint)">— no objects in frame —</span></div>`;
    if (engine.mode !== "sim") recordStats(s);
  }
  function initModal() {
    document.getElementById("cam-close").onclick = closeCamera;
    document.getElementById("cam-modal").addEventListener("click", e => { if (e.target.id === "cam-modal") closeCamera(); });
    document.getElementById("btn-hls").onclick = () => { if (openedCam && openedCam.hls) play("hls", openedCam.hls); };
    document.getElementById("hls-go").onclick = () => { const url = (document.getElementById("hls-url").value || "").trim(); if (url) play("hls", url); };
    document.getElementById("hls-url").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("hls-go").click(); });
    document.getElementById("btn-sim").onclick = () => play("sim");
    document.getElementById("btn-webcam").onclick = () => play("webcam");
    document.getElementById("btn-file").onclick = () => document.getElementById("file-input").click();
    document.getElementById("file-input").onchange = e => { const f = e.target.files[0]; if (f) play("file", f); };
    document.getElementById("btn-stop").onclick = () => { if (engine) engine.stop(); onEngineStatus("idle", "Feed dihentikan."); };
    document.getElementById("fo-retry").onclick = () => { if (lastSource) play(lastSource.mode, lastSource.arg); };
    document.getElementById("fo-other").onclick = () => { document.getElementById("adv").open = true; document.getElementById("hls-preset").focus(); };
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeCamera(); });
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  /* ---------------- BOOT ---------------- */
  function boot() {
    initMap();
    initCitySelect();
    renderList();
    initFilter();
    initSourceNote();
    initToggles();
    initTabs();
    initPresets();
    initModal();
    renderPanel();
    drawSpark();
    tickClock();

    const nCity = cams.filter(c => c.kind === "city").length;
    addEvent("info", `SENTINEL online · ${fmt(cams.length)} kamera (${fmt(cams.length - nCity)} tol, ${fmt(nCity)} kota) · ${fmt(bts.length)} BTS representatif`);

    setInterval(tickClock, 1000);
    window.addEventListener("resize", drawSpark);
    startChecks();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
