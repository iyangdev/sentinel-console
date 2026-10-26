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
    map = L.map("map", { zoomControl: false, attributionControl: true, minZoom: 5, maxZoom: 18, preferCanvas: true })
      .setView(INDONESIA, 5);
    L.control.zoom({ zoomInTitle: "Perbesar", zoomOutTitle: "Perkecil" }).addTo(map);

    imagery = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Citra © Esri · CCTV © BPJT Kementerian PU · BTS: representatif", maxZoom: 18 }
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
      `LINTANG ${c.lat.toFixed(4)} · BUJUR ${c.lng.toFixed(4)} · ZOOM ${map.getZoom()}`;
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
  // a camera's status in words: label, its colour, and the reason or the check time
  function statusInfo(cam) {
    const s = camState(cam), [label, col] = STATE_LABEL[s.st];
    const detail = pending.has(cam._i) ? "mengecek kamera ini…"
      : s.st === "ok" ? `dicek ${wib(s.at)} WIB`
      : s.st === "presumed" ? "kamera lain di server ini berjalan; kamera ini belum dicek"
      : s.st === "unknown" ? (cam.active ? "menunggu pengecekan" : "data sumber: nonaktif")
      : s.why + (s.src === "host" ? " (hasil cek server)" : "");
    return { label, col, detail };
  }
  function popupHtml(cam) {
    const kind = cam.kind === "city" ? "CCTV KOTA" : "CCTV TOL";
    const { label, col, detail } = statusInfo(cam);
    const st = camStats[cam._i], an = st && st.mins.length ? camSummary(st) : null;
    return `<div class="popup-title" style="color:${KIND_COLOR[cam.kind]}">${esc(cam.name) || "CCTV"}</div>
      <div class="popup-row">${kind} · ${esc(cam.city)} · ${esc(cam.road)}</div>
      <div class="popup-row">${esc(cam.opName)}</div>
      <div class="popup-row" style="color:${col}">● ${label} <span style="color:var(--text-faint)">· ${esc(detail)}</span></div>
      ${an ? `<div class="popup-row popup-an">${lvlBadge(an.avgV)} rata-rata ${dec(an.avgV)} kendaraan di frame · ${dur(an.ms)} dianalisis</div>` : ""}
      ${hostOf(cam) === JM_HOST ? `<div class="popup-note">Tayangan resmi CCTV Jasa Marga ada di aplikasi <a href="${TRAVOY_URL}" target="_blank" rel="noopener">Travoy</a>.</div>` : ""}
      <div class="popup-btn" data-i="${cam._i}">▶ BUKA ANALISIS AI</div>`;
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
         <div class="popup-row">${esc(s.band)} MHz · ${esc(s.g)} · sel ~${s.radius} m</div>
         <div class="popup-row" style="color:var(--text-faint);margin-top:4px">Lokasi representatif · hanya lapisan infrastruktur</div>`
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
    recordCheck(cam, ok ? { st: "ok", why: "" } : { st: "nostream", why: why || "Tayangan gagal diputar." });
  }

  // Re-style one camera everywhere it shows, in place: marker, list row, open popup.
  const rowOf = cam => document.querySelector(`#camera-list .cam-item[data-i='${cam._i}']`);
  function restyle(cam, row = rowOf(cam)) {
    const m = markers[cam._i];
    if (m) { if (cam.featured != null) m.setIcon(featuredIcon(cam)); else m.setStyle(circleStyle(cam)); }
    if (row) { row.querySelector(".stat-led").className = ledClass(cam); row.lastElementChild.outerHTML = rowTag(cam); }
    if (syncShown(cam)) scheduleList();
    if (tab === "kamera") { const tr = document.querySelector(`#dir-body tr[data-i='${cam._i}']`); if (tr) tr.outerHTML = dirRow(cam); }
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
      + (t.muted ? ` · nonaktif menurut data sumber: ${fmt(t.muted)}` : ""));
    setText("hdr-live", `${fmt(t.live)} / ${fmt(cams.length)}`);
    if (tab === "analitik") renderNetwork();
    else if (tab === "kamera" && dirStatus) renderDir();   // a row may have left the status shown
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
  // City and search are shared by the map's list and the Kamera tab, each with its own controls.
  function initCitySelect() {
    const counts = {};
    cams.forEach(c => { counts[c.city] = (counts[c.city] || 0) + 1; });
    const places = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const opts = `<option value="">Semua wilayah — ${fmt(cams.length)} CCTV</option>`
      + places.map(p => `<option value="${esc(p)}">${esc(p)} · ${counts[p]}</option>`).join("");
    ["city-select", "dir-city"].forEach(id => {
      const sel = document.getElementById(id);
      sel.innerHTML = opts;
      sel.onchange = () => setCity(sel.value);
    });
  }

  function setCity(city) {
    state.city = city;
    ["city-select", "dir-city"].forEach(id => { document.getElementById(id).value = city; });
    setText("hdr-region", city ? city.toUpperCase() : "INDONESIA");
    renderList();
    if (tab === "kamera") renderDir();
    if (tab === "langsung") fitCity(); else pendingFit = true;   // a hidden map can't fit anything
  }
  function fitCity() {
    pendingFit = false;
    const inCity = cams.filter(c => !state.city || c.city === state.city), vis = inCity.filter(shown);
    fitTo(vis.length ? vis : inCity.length ? inCity : cams);
  }
  // from: the box being typed in, which keeps its own text
  function setQuery(q, from) {
    state.q = q.trim().toLowerCase();
    ["cam-filter", "dir-q"].forEach(id => { const el = document.getElementById(id); if (el !== from) el.value = q; });
    renderList();
    if (tab === "kamera") renderDir();
  }

  function camMatches(cam) {
    if (state.city && cam.city !== state.city) return false;
    if (!state.q) return true;
    return (cam.name + " " + cam.road + " " + cam.opName + " " + cam.city + " " + cam.id).toLowerCase().includes(state.q);
  }

  const ledClass = cam => `stat-led led-${noVideo(cam) ? "down" : looksLive(cam) ? "online" : "offline"}${cam.kind === "city" ? " kind-city" : ""}`;
  // "LANGSUNG" marks the curated cameras, but only while they actually have video
  const rowTag = cam => (cam.featured != null && !noVideo(cam)) ? `<span class="badge-live">LANGSUNG</span>` : `<span class="cid">${esc(cam.city)}</span>`;
  const camOrder = (a, b) => (a.featured ?? 999) - (b.featured ?? 999) || a.city.localeCompare(b.city) || a.road.localeCompare(b.road);

  function renderList() {
    const el = document.getElementById("camera-list");
    const matched = cams.filter(camMatches);
    const list = matched.filter(shown).sort(camOrder);
    const hidden = matched.length - list.length;
    el.innerHTML = list.slice(0, 400).map(cam => `<div class="cam-item" data-i="${cam._i}">
        <span class="${ledClass(cam)}"></span>
        <div class="meta"><div class="nm">${esc(cam.name) || "CCTV"}</div><div class="sb">${esc(cam.road)} · ${esc(cam.opName)}</div></div>
        ${rowTag(cam)}</div>`).join("")
      + (hidden ? `<div class="cam-hidden">${fmt(hidden)} kamera tanpa video disembunyikan</div>` : "");
    el.querySelectorAll(".cam-item").forEach(row => { row.onclick = () => focusCamera(cams[+row.dataset.i]); });
    document.getElementById("cam-count").textContent = list.length;
  }

  function focusCamera(cam) {
    map.flyTo([cam.lat, cam.lng], 16, { duration: 0.8 });
    const mk = markers[cam._i];
    if (mk) mk.openPopup();
  }

  function initFilter() {
    ["cam-filter", "dir-q"].forEach(id => {
      const inp = document.getElementById(id);
      let t;
      inp.oninput = () => { clearTimeout(t); t = setTimeout(() => setQuery(inp.value, inp), 120); };
    });
  }

  function initSourceNote() {
    const el = document.getElementById("src-note");
    if (!el) return;
    const citySrc = (CITY_SOURCE.sources || []).filter(s => s.count)
      .map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a> (${s.count})`).join(", ");
    const portals = (CITY_SOURCE.portals || [])
      .map(p => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.city)} — ${esc(p.name)}</a> <span style="opacity:.7">(${esc(p.reason)})</span>`).join("<br>");
    const snap = SOURCE.snapshot
      ? new Date(SOURCE.snapshot).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "—";
    el.innerHTML = `CCTV tol: <a href="${esc(SOURCE.url || "#")}" target="_blank" rel="noopener">BPJT · Kementerian PU</a> — `
      + `${fmt(SOURCE.count || 0)} kamera (data per ${esc(snap)}`
      + (SOURCE.fixed ? `; ${SOURCE.fixed} URL stream diperbaiki dari situs operator` : "") + `).<br>`
      + (citySrc ? `CCTV kota: ${citySrc}.<br>` : "")
      + `BTS: ${fmt(bts.length)} lokasi <em>representatif</em>, hanya ilustrasi infrastruktur: bukan koordinat asli dan tidak terhubung ke perangkat apa pun.<br>`
      + `Hanya analitik lalu lintas umum: tanpa pengenalan wajah, tanpa pembacaan pelat nomor, tanpa pelacakan identitas.`
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

  /* ---------------- TABS ---------------- */
  // Langsung: the map console · Analitik: video across the network and the traffic
  // the AI measured · Kamera: every camera in one table. The right panel stays in all
  // three. The tab is kept in the address (#analitik, #kamera) so a link opens on it.
  const TABS = ["langsung", "analitik", "kamera"];
  let tab = "langsung", pendingFit = false;
  function setTab(name) {
    if (!TABS.includes(name)) name = "langsung";
    tab = name;
    document.getElementById("app").dataset.tab = name;
    document.querySelectorAll(".tab").forEach(t => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", String(on));
    });
    history.replaceState(null, "", name === "langsung" ? location.pathname + location.search : "#" + name);
    if (name === "langsung") { map.invalidateSize(); if (pendingFit) fitCity(); }
    else if (name === "kamera") renderDir();
    else { renderNetwork(); renderTraffic(); }
  }
  function initTabs() {
    document.querySelectorAll(".tab").forEach(t => { t.onclick = () => setTab(t.dataset.tab); });
    window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));
  }

  // what the buttons in both tabs do with a camera
  function act(what, cam) {
    if (what === "map") { setTab("langsung"); focusCamera(cam); }
    else if (what === "ai") openCamera(cam);
    else if (what === "csv" && camStats[cam._i]) downloadCsv([camStats[cam._i]], csvName(cam));
  }

  /* ---------------- KAMERA TAB ---------------- */
  let dirStatus = "";   // "" all · live · none · muted, the same split as the counts
  const statusKey = cam => noVideo(cam) ? "none" : looksLive(cam) ? "live" : "muted";
  function dirRow(cam) {
    const s = statusInfo(cam);
    return `<tr data-i="${cam._i}">
      <td><span class="${ledClass(cam)}"></span></td>
      <td><div class="nm">${esc(cam.name) || "CCTV"}</div><div class="sb">${cam.kind === "city" ? "CCTV kota" : "CCTV tol"}</div></td>
      <td>${esc(cam.city)}</td><td>${esc(cam.road)}</td><td>${esc(cam.opName)}</td>
      <td><div style="color:${s.col}">${s.label}</div><div class="sb">${esc(s.detail)}</div></td>
      <td class="act"><button type="button" data-act="map">Peta</button><button type="button" data-act="ai">Analisis AI</button></td>
    </tr>`;
  }
  function renderDir() {
    const list = cams.filter(c => camMatches(c) && (!dirStatus || statusKey(c) === dirStatus)).sort(camOrder);
    document.getElementById("dir-body").innerHTML = list.map(c => dirRow(c)).join("")
      || `<tr><td colspan="7" class="dir-empty">Tidak ada kamera yang cocok.</td></tr>`;
    setText("dir-count", `${fmt(list.length)} kamera`);
  }

  /* ---------------- ANALITIK TAB ---------------- */
  // Video per operator and per region comes from the same checks as the map; the
  // traffic cards from the analyses run since the page opened.
  const opOf = cam => cam.opName.split(" · ")[0];
  function groupCounts(keyOf) {
    const g = {};
    cams.forEach(c => {
      const k = keyOf(c), r = g[k] || (g[k] = { k, n: 0, live: 0, none: 0, muted: 0 });
      r.n++; r[statusKey(c)]++;
    });
    return Object.values(g).sort((a, b) => b.n - a.n || a.k.localeCompare(b.k));
  }
  // rows open the Kamera tab on that operator (as a search) or that region
  function availTable(rows, attr, head) {
    return `<thead><tr><th>${head}</th><th>Kamera</th><th>Bervideo</th><th>Tanpa video</th><th>Nonaktif</th><th></th></tr></thead><tbody>`
      + rows.map(r => `<tr data-${attr}="${esc(r.k)}" title="Lihat kamera ${esc(r.k)}">
          <td>${esc(r.k)}</td><td>${fmt(r.n)}</td><td>${fmt(r.live)}</td><td>${fmt(r.none)}</td><td>${fmt(r.muted)}</td>
          <td><div class="avail"><i style="width:${(r.live / r.n) * 100}%"></i><b style="width:${(r.none / r.n) * 100}%"></b></div></td></tr>`).join("")
      + `</tbody>`;
  }
  function renderNetwork() {
    const hosts = Object.values(hostCheck);
    if (!hosts.length) {
      setText("an-checked", "memeriksa video kamera…");
      document.getElementById("an-tiles").innerHTML = "";
      ["an-ops", "an-cities"].forEach(id => { document.getElementById(id).innerHTML = ""; });
      return;
    }
    const t = tally(), sending = hosts.filter(h => h.st === "ok").length;
    const checked = cams.filter(c => camState(c).st === "ok").length;
    const ops = groupCounts(opOf), worst = ops.reduce((a, r) => (r.none > a.none ? r : a), ops[0]);
    setText("an-checked", `dicek terakhir ${wib(Math.max(...hosts.map(h => h.at)))} WIB · ${fmt(cams.length)} kamera`);
    document.getElementById("an-tiles").innerHTML = [
      ["live", fmt(t.live), "Bervideo", `${Math.round((t.live / cams.length) * 100)}% · ${fmt(checked)} sudah dicek satu per satu`],
      ["none", fmt(t.none), "Tanpa video", worst.none ? `terbanyak: ${worst.k} (${fmt(worst.none)})` : ""],
      ["muted", fmt(t.muted), "Nonaktif", "menurut data sumber, belum terbukti bervideo"],
      ["", `${sending} / ${hosts.length}`, "Server mengirim video", `${hosts.length - sending} tanpa video atau tidak merespons`]
    ].map(([cls, v, k, s]) => `<div class="tile ${cls}"><div class="v">${v}</div><div class="k">${k}</div><div class="s">${esc(s)}</div></div>`).join("");
    document.getElementById("an-ops").innerHTML = availTable(ops, "op", "Operator");
    document.getElementById("an-cities").innerHTML = availTable(groupCounts(c => c.city), "city", "Wilayah");
  }

  function renderTraffic() {
    const el = document.getElementById("an-cams"), list = analysed();
    document.getElementById("an-csv").hidden = !list.length;
    if (!list.length) {
      const picks = featured.filter(c => !noVideo(c)).slice(0, 6);
      el.innerHTML = `<div class="an-empty">Belum ada kamera yang dianalisis di sesi ini. Kepadatan lalu lintas dicatat per menit selama analisis AI berjalan.`
        + (picks.length ? `<div class="an-try">Coba kamera pilihan:${picks.map(c =>
            `<button type="button" data-act="ai" data-i="${c._i}">${esc(c.name)} (${esc(c.city)})</button>`).join("")}</div>` : "")
        + `</div>`;
      return;
    }
    el.innerHTML = list.map(st => {
      const s = camSummary(st), c = st.cam;
      return `<div class="an-card" data-i="${c._i}">
        <div class="an-card-head"><div class="meta"><div class="nm">${esc(c.name) || "CCTV"}</div><div class="sb">${esc(c.city)} · ${esc(c.road)}</div></div>${lvlBadge(s.avgV)}</div>
        <div class="sb">${dur(s.ms)} dianalisis · rata-rata ${dec(s.avgV)} kendaraan di frame · puncak ${s.peakV}</div>
        <canvas class="an-chart"></canvas>
        <div class="an-card-act"><button type="button" data-act="map">Peta</button><button type="button" data-act="ai">Analisis AI</button><button type="button" data-act="csv">⤓ CSV</button></div>
      </div>`;
    }).join("");
    el.querySelectorAll(".an-card").forEach(card => drawMinutes(card.querySelector("canvas"), camStats[card.dataset.i], false));
  }

  function initViews() {
    // buttons sit in a row or card that carries the camera's data-i
    const onAct = e => {
      const btn = e.target.closest("button[data-act]"), holder = btn && btn.closest("[data-i]");
      if (holder) { act(btn.dataset.act, cams[+holder.dataset.i]); return true; }
      return false;
    };
    document.getElementById("view-kamera").addEventListener("click", onAct);
    document.getElementById("dir-status").addEventListener("click", e => {
      const b = e.target.closest("button[data-st]");
      if (!b) return;
      dirStatus = b.dataset.st;
      document.querySelectorAll("#dir-status button").forEach(x => x.classList.toggle("on", x === b));
      renderDir();
    });
    document.getElementById("view-analitik").addEventListener("click", e => {
      if (onAct(e)) return;
      const tr = e.target.closest("tr[data-op], tr[data-city]");
      if (!tr) return;
      if (tr.dataset.city != null) { setQuery(""); setCity(tr.dataset.city); }
      else { setCity(""); setQuery(tr.dataset.op); }
      setTab("kamera");
    });
    document.getElementById("an-csv").onclick = () => {
      const list = analysed();
      if (list.length) downloadCsv(list, `sentinel-analitik-${fileStamp()}.csv`);
    };
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
  const CLASS_NAME = Object.fromEntries(CLASS_LABELS.map(([k, label]) => [k, label]));
  const SERIES_SECS = 120;
  // one decimal; a small non-zero average reads "<0,1" so it doesn't look like nothing was seen
  const dec = x => (x > 0 && x < 0.05 ? "<0,1" : (Math.round(x * 10) / 10).toLocaleString("id-ID"));
  const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} dtk` : `${Math.floor(s / 60)} mnt ${s % 60} dtk`; };
  let run = null, panelAt = 0;

  // cam: the map camera whose own stream this run plays, or null (webcam, file, custom URL)
  function startRun(label, cam) {
    endRun();
    run = { label, cam, start: Date.now(), end: 0, frames: 0, sumP: 0, sumV: 0, peakP: 0, peakV: 0,
            by: {}, recent: [], series: [], sec: 0, secSum: 0, secN: 0 };
    renderAnalytics();
  }

  function endRun() {
    if (!run || run.end) return;
    run.end = Date.now();
    const st = run.cam && camStats[run.cam._i];
    if (st && run.frames) st.ms += run.end - run.start;
    if (run.frames) addEvent("info", `Analisis selesai · ${run.label} · ${dur(run.end - run.start)}, `
      + `rata-rata ${dec(run.sumV / run.frames)} kendaraan di frame (puncak ${run.peakV})`
      + (run.cam ? ` · ${levelOf(run.sumV / run.frames).label.toLowerCase()}` : ""));
    renderAnalytics();
    if (run.cam) refreshPopup(run.cam);
  }

  // everything that shows analysis results: right panel, timeline, feed window, Analitik tab
  function renderAnalytics() {
    renderPanel(); drawSpark(); renderDensity(); renderCamStats();
    if (tab === "analitik") renderTraffic();
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
    if (run.cam) recordMinute(run.cam, s, now);
    if (now - panelAt > 500) { panelAt = now; renderPanel(); drawSpark(); renderDensity(); }
  }

  function renderPanel() {
    const live = !!run && !run.end;
    let p = "—", v = "—", sub;
    if (!run) sub = "Belum ada analisis. Klik titik kamera di peta, lalu ▶ BUKA ANALISIS AI: hasil deteksi nyata muncul di sini.";
    else if (!run.frames) sub = live ? "Menunggu frame pertama dianalisis…" : "Tayangan berhenti sebelum ada frame yang dianalisis.";
    else {
      const win = live ? run.recent : null;   // live: the last 10 s · finished: the whole run
      const n = win ? win.length : run.frames;
      p = dec((win ? win.reduce((a, r) => a + r.p, 0) : run.sumP) / n);
      v = dec((win ? win.reduce((a, r) => a + r.v, 0) : run.sumV) / n);
      sub = `${win ? "Rata-rata 10 detik terakhir" : "Rata-rata seluruh analisis"} · puncak ${run.peakV} kendaraan, `
        + `${run.peakP} orang · ${dur((run.end || Date.now()) - run.start)}`;
    }
    setText("ai-src", run ? `${live ? "● LANGSUNG" : "■ SELESAI"} · ${run.label}` : "Belum ada analisis");
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

  /* ---------------- PER-CAMERA ANALYTICS ---------------- */
  // Every analysed frame of a map camera's own stream also goes into that camera's
  // one-minute buckets, kept while this page is open (a CSV download keeps them).
  // "In frame" is what the AI sees at once. It doesn't follow vehicles from frame
  // to frame, so this is not a count of vehicles passing.
  const camStats = {};   // cam._i -> { cam, ms, last, mins: [{ t, frames, sumV, peakV, sumP, peakP, by }] }
  const CHART_MINUTES = 60;
  // Density from the average vehicles in frame: ramai from 4, padat from 8 (the 8 the
  // engine already warns at on a single frame). A rough guide: how many vehicles fit
  // in frame depends on each camera's angle and zoom, and the AI sees fewer in the dark.
  const LEVELS = [
    { max: 4, label: "LANCAR", color: "#37e39b" },
    { max: 8, label: "RAMAI", color: "#f5a524" },
    { max: Infinity, label: "PADAT", color: "#ff4d5e" }
  ];
  const levelOf = avg => LEVELS.find(l => avg < l.max);
  const lvlBadge = avg => { const l = levelOf(avg); return `<span class="lvl" style="--lvl:${l.color}">${l.label}</span>`; };

  function recordMinute(cam, s, now) {
    const st = camStats[cam._i] || (camStats[cam._i] = { cam, ms: 0, last: 0, mins: [] });
    const t = now - now % 60000;   // WIB is a whole number of hours from UTC, so minutes line up
    let b = st.mins[st.mins.length - 1];
    if (!b || b.t !== t) st.mins.push(b = { t, frames: 0, sumV: 0, peakV: 0, sumP: 0, peakP: 0, by: {} });
    b.frames++;
    b.sumV += s.vehicles; b.peakV = Math.max(b.peakV, s.vehicles);
    b.sumP += s.people; b.peakP = Math.max(b.peakP, s.people);
    for (const k in s.byClass) b.by[k] = (b.by[k] || 0) + s.byClass[k];
    st.last = now;
  }

  // all minutes of one camera: time analysed (including a run still going), average and peak
  function camSummary(st) {
    let frames = 0, sumV = 0, peakV = 0;
    st.mins.forEach(b => { frames += b.frames; sumV += b.sumV; peakV = Math.max(peakV, b.peakV); });
    const live = !!run && !run.end && run.cam === st.cam;
    return { avgV: frames ? sumV / frames : 0, peakV, ms: st.ms + (live ? Date.now() - run.start : 0) };
  }
  const analysed = () => Object.values(camStats).filter(st => st.mins.length).sort((a, b) => b.last - a.last);

  // Feed window: the camera on screen. Live, its density over the last 10 s; otherwise
  // its average so far. Below, one bar per minute analysed.
  function renderDensity() {
    const cam = lastSource && lastSource.mode === "hls" ? currentCam : null;
    const box = document.getElementById("dens");
    box.hidden = !cam;   // SIM, webcam, files and custom URLs aren't map cameras
    if (!cam) return;
    const st = camStats[cam._i], live = !!run && !run.end && run.cam === cam && run.recent.length > 0;
    let lvl = "", sub;
    if (live) {
      const v = run.recent.reduce((a, r) => a + r.v, 0) / run.recent.length;
      lvl = lvlBadge(v); sub = `${dec(v)} kendaraan di frame · 10 dtk terakhir`;
    } else if (st && st.mins.length) {
      const s = camSummary(st);
      lvl = lvlBadge(s.avgV); sub = `rata-rata ${dec(s.avgV)} kendaraan di frame · ${dur(s.ms)} dianalisis`;
    } else sub = "Belum ada data. Kepadatan muncul begitu video kamera ini dianalisis.";
    const chart = document.getElementById("dens-chart"), has = !!(st && st.mins.length);
    document.getElementById("dens-lvl").innerHTML = lvl;
    setText("dens-sub", sub);
    document.getElementById("dens-csv").hidden = chart.hidden = !has;
    drawMinutes(chart, st, live);
  }

  // One bar per minute analysed, newest at the right, coloured by density. Dashed
  // guides at 4 and 8; a dotted line where the camera wasn't analysed in between.
  function drawMinutes(cv, st, live) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight || 70;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const mins = st ? st.mins.slice(-CHART_MINUTES) : [];
    if (!mins.length || !w) return;
    const pw = w - 14, ph = h - 13;   // plot area; guide labels on the right, times below
    const avgs = mins.map(b => b.sumV / b.frames);
    const top = Math.max(10, ...avgs) * 1.1;
    const y = v => ph - (v / top) * ph;
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#46564f"; ctx.strokeStyle = "rgba(207,234,221,0.14)";
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.setLineDash([3, 3]);
    [4, 8].forEach(v => {
      const gy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(pw, gy); ctx.stroke();
      ctx.fillText(String(v), w, gy);
    });
    const slot = pw / Math.max(mins.length, 15);   // a few minutes stay bars, not slabs
    const x0 = pw - slot * mins.length;
    ctx.strokeStyle = "rgba(207,234,221,0.3)"; ctx.setLineDash([1, 2]);
    mins.forEach((b, i) => {
      const x = x0 + i * slot;
      if (i && b.t - mins[i - 1].t > 60000) {
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, ph); ctx.stroke();
      }
      const bh = Math.max(1, ph - y(avgs[i]));
      ctx.globalAlpha = live && i === mins.length - 1 ? 1 : 0.7;
      ctx.fillStyle = levelOf(avgs[i]).color;
      ctx.fillRect(x + 1, ph - bh, Math.max(1, slot - 2), bh);
    });
    ctx.globalAlpha = 1; ctx.setLineDash([]);
    // first and last minute shown, in WIB; the first one only if it has room
    const hm = t => wib(t).slice(0, 5);
    const last = hm(mins[mins.length - 1].t) + " WIB", first = hm(mins[0].t);
    ctx.fillStyle = "#6f8a7e"; ctx.textBaseline = "bottom";
    ctx.fillText(last, pw, h);
    if (mins.length > 1 && x0 + ctx.measureText(first).width + 8 < pw - ctx.measureText(last).width) {
      ctx.textAlign = "left"; ctx.fillText(first, x0, h);
    }
  }

  // Right panel: every camera analysed since the page opened, latest first.
  function renderCamStats() {
    const el = document.getElementById("cam-stats"), list = analysed();
    document.getElementById("csv-all").hidden = !list.length;
    el.innerHTML = list.length
      ? list.map(st => {
          const s = camSummary(st);
          return `<div class="cs-row" data-i="${st.cam._i}">${lvlBadge(s.avgV)}
            <div class="meta"><div class="nm">${esc(st.cam.name) || "CCTV"}</div>
            <div class="sb">${dur(s.ms)} · rata-rata ${dec(s.avgV)} kendaraan di frame · puncak ${s.peakV}</div></div></div>`;
        }).join("")
        + `<div class="cs-note">Kepadatan dari rata-rata kendaraan yang terlihat AI di frame: ramai ≥4, padat ≥8. `
        + `Data per menit hanya ada selama halaman ini terbuka; unduh CSV untuk menyimpannya.</div>`
      : `<div class="cs-note">Belum ada kamera yang dianalisis. Buka analisis AI sebuah kamera: kepadatannya dicatat per menit di sini.</div>`;
    el.querySelectorAll(".cs-row").forEach(row => { row.onclick = () => focusCamera(cams[+row.dataset.i]); });
  }

  // CSV: one row per camera per minute, WIB times, generic counts only.
  const wibMinute = t => new Date(t + 7 * 3600e3).toISOString().slice(0, 16).replace("T", " ");   // WIB = UTC+7, no DST
  const CSV_HEAD = ["kamera_id", "kamera", "kota", "ruas", "operator", "menit_wib", "frame_dianalisis",
    "rata_kendaraan_di_frame", "puncak_kendaraan_di_frame", "rata_orang_di_frame", "puncak_orang_di_frame",
    "rata_mobil", "rata_motor", "rata_bus", "rata_truk", "rata_sepeda", "kepadatan"];
  function downloadCsv(list, name) {
    const cell = v => typeof v === "number" ? String(v) : `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const rows = [CSV_HEAD.join(",")];
    list.forEach(st => st.mins.forEach(b => {
      const avg = x => Math.round((x / b.frames) * 100) / 100;
      rows.push([st.cam.id, st.cam.name, st.cam.city, st.cam.road, st.cam.opName, wibMinute(b.t), b.frames,
        avg(b.sumV), b.peakV, avg(b.sumP), b.peakP,
        ...["car", "motorcycle", "bus", "truck", "bicycle"].map(c => avg(b.by[c] || 0)),
        levelOf(b.sumV / b.frames).label.toLowerCase()].map(cell).join(","));
    }));
    // the BOM makes spreadsheet apps read it as UTF-8
    const url = URL.createObjectURL(new Blob(["﻿" + rows.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "kamera";
  const fileStamp = () => wibMinute(Date.now()).replace(/[-: ]/g, "").replace(/^(\d{8})/, "$1-");   // 20261027-0815
  const csvName = cam => `sentinel-${slug(cam.name)}-${fileStamp()}.csv`;

  function initAnalytics() {
    document.getElementById("dens-csv").onclick = () => {
      const st = currentCam && camStats[currentCam._i];
      if (st) downloadCsv([st], csvName(st.cam));
    };
    document.getElementById("csv-all").onclick = () => {
      const list = analysed();
      if (list.length) downloadCsv(list, `sentinel-analitik-${fileStamp()}.csv`);
    };
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
    setText("spark-rng", data.length ? `kendaraan di frame per detik · ${run.label}` : "belum ada analisis");
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
    sel.innerHTML = `<option value="">— kamera pilihan lain —</option>`
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
    addEvent("info", `Analisis AI dibuka · ${cam.name} (${cam.city})`);
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
    // nothing is recorded: the badge says what is playing
    document.querySelector("#cam-modal .feed-top .rec").lastChild.textContent = { sim: " SIMULASI", file: " REKAMAN" }[mode] || " LANGSUNG";
    renderDensity();   // the camera on screen may have changed
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
    offline:    { icon: "⚠", title: "Kamera tidak mengirim video", retry: "Coba lagi", other: true,
                  sub: "Kamera ini tidak mengirim video saat ini. Banyak kamera berbagi server yang sama, jadi satu kota bisa mati bersamaan. Titik abu-abu di peta berarti tanpa video; coba titik yang berwarna." },
    paused:     { icon: "❚❚", title: "Tayangan dijeda", retry: "Lanjutkan" },
    idle:       { icon: "■", title: "Tayangan dihentikan", retry: "Putar lagi" }
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
          : ({ webcam: "Webcam kamu", file: "File video" }[lastSource.mode] || "Stream HLS pilihan"), camFeed);
        if (camFeed) { noteFeed(camFeed, true); addEvent("info", `Tayangan berjalan · ${camFeed.name} (${camFeed.city})`); }
      }
    } else {
      setPill(PILL[stt] || "● AI SIAGA");
      if (stt !== "loading" && stt !== "connecting") endRun();
    }
    if (stt === "offline") {
      if (camFeed) noteFeed(camFeed, false, text);
      if (currentCam) addEvent("warn", `Tayangan terputus · ${currentCam.name} (${currentCam.city})`);
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
      ? rows.map(([c, n]) => `<div class="det-row"><span class="cls">${esc((CLASS_NAME[c] || c).toUpperCase())}</span><span class="conf">× ${n}</span></div>`).join("")
      : `<div class="det-row"><span class="cls" style="color:var(--text-faint)">— tidak ada objek di frame —</span></div>`;
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
    document.getElementById("btn-stop").onclick = () => { if (engine) engine.stop(); onEngineStatus("idle", "Tayangan dihentikan."); };
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
    initAnalytics();
    initViews();
    renderAnalytics();
    setTab(location.hash.slice(1));   // a link can open on #analitik or #kamera
    tickClock();

    const nCity = cams.filter(c => c.kind === "city").length;
    addEvent("info", `SENTINEL aktif · ${fmt(cams.length)} kamera (${fmt(cams.length - nCity)} tol, ${fmt(nCity)} kota) · ${fmt(bts.length)} BTS representatif`);

    setInterval(tickClock, 1000);
    window.addEventListener("resize", () => { drawSpark(); renderDensity(); if (tab === "analitik") renderTraffic(); });
    startChecks();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
