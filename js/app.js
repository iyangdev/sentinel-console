/* ============================================================
   SENTINEL — console orchestration
   National public toll-road CCTV (BPJT) + representative BTS layer
   + in-browser AI vision engine.
   ============================================================ */
(function () {
  "use strict";

  const INDONESIA = [-2.5, 117.0];
  const cams = (window.CCTV_CAMERAS || []).map((c, i) => Object.assign({ _i: i }, c));
  const SOURCE = window.CCTV_SOURCE || {};
  const bts = window.BTS_SITES || [];
  const BTS_SOURCE = window.BTS_SOURCE || {};
  const featured = cams.filter(c => c.featured != null).sort((a, b) => a.featured - b.featured);

  let map, imagery, labelsLayer, markerLayer, coverageLayer, heatLayer, btsLayer;
  const markers = {};
  const state = { city: "", q: "" };

  const camStatus = c => (c.active ? "online" : "offline");
  const OP_COLOR = { Telkomsel: "#ff4d5e", Indosat: "#f5a524", "XL Axiata": "#38bdf8", Tri: "#c084fc", Smartfren: "#37e39b" };

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
    const s = camStatus(cam);
    return L.divIcon({
      className: "",
      html: `<div class="cam-marker ${s === "online" ? "" : "offline"}"><span class="ping"></span><span class="core"></span></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7]
    });
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    cams.forEach(cam => {
      let m;
      if (cam.featured != null) {
        m = L.marker([cam.lat, cam.lng], { icon: featuredIcon(cam), zIndexOffset: 1000 });
      } else {
        const col = cam.active ? "#37e39b" : "#6f8a7e";
        m = L.circleMarker([cam.lat, cam.lng], {
          radius: 3.5, color: col, weight: 1, opacity: 0.85,
          fillColor: col, fillOpacity: cam.active ? 0.5 : 0.25
        });
      }
      m.addTo(markerLayer);
      m.bindPopup(popupHtml(cam));
      m.on("popupopen", () => {
        const btn = document.querySelector(".popup-btn[data-i='" + cam._i + "']");
        if (btn) btn.onclick = () => openCamera(cam);
      });
      markers[cam._i] = m;
    });
  }

  function popupHtml(cam) {
    return `<div class="popup-title">${esc(cam.name) || "CCTV"}</div>
      <div class="popup-row">${esc(cam.city)} · ${esc(cam.road)}</div>
      <div class="popup-row">${esc(cam.opName)} · ${camStatus(cam).toUpperCase()}</div>
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
      renderList();
      const inCity = cams.filter(c => !state.city || c.city === state.city);
      fitTo(inCity.length ? inCity : cams);
    };
  }

  function camMatches(cam) {
    if (state.city && cam.city !== state.city) return false;
    if (!state.q) return true;
    return (cam.name + " " + cam.road + " " + cam.opName + " " + cam.city + " " + cam.id).toLowerCase().includes(state.q);
  }

  function renderList() {
    const el = document.getElementById("camera-list");
    const list = cams.filter(camMatches)
      .sort((a, b) => (a.featured ?? 999) - (b.featured ?? 999) || a.city.localeCompare(b.city) || a.road.localeCompare(b.road));
    el.innerHTML = list.slice(0, 400).map(cam => {
      const tag = cam.featured != null ? `<span class="badge-live">LIVE</span>` : `<span class="cid">${esc(cam.city)}</span>`;
      return `<div class="cam-item" data-i="${cam._i}">
        <span class="stat-led led-${camStatus(cam)}"></span>
        <div class="meta"><div class="nm">${esc(cam.name) || "CCTV"}</div><div class="sb">${esc(cam.road)} · ${esc(cam.opName)}</div></div>
        ${tag}</div>`;
    }).join("");
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
    el.innerHTML = `CCTV: <a href="${esc(SOURCE.url || "#")}" target="_blank" rel="noopener">BPJT · Kementerian PU</a> — `
      + `${SOURCE.count || cams.length} toll-road cameras (snapshot ${esc(SOURCE.snapshot || "—")}).<br>`
      + `BTS: ${bts.length} <em>representative</em> cell-sites — illustrative infrastructure, not real coordinates and not linked to any device.<br>`
      + `Generic traffic analytics only — no face recognition, no identity tracking.`;
  }

  /* ---------------- LAYER TOGGLES ---------------- */
  function initToggles() {
    document.querySelectorAll(".toggle-row").forEach(row => {
      row.onclick = () => {
        row.classList.toggle("on");
        const on = row.classList.contains("on");
        const layer = row.dataset.layer;
        if (layer === "cctv") on ? markerLayer.addTo(map) : map.removeLayer(markerLayer);
        if (layer === "labels") on ? labelsLayer.addTo(map) : map.removeLayer(labelsLayer);
        if (layer === "heat") { if (on) { buildHeat(); heatLayer.addTo(map); } else map.removeLayer(heatLayer); }
        if (layer === "coverage") { if (on) { buildCoverage(); coverageLayer.addTo(map); } else map.removeLayer(coverageLayer); }
        if (layer === "bts") { if (on) { buildBts(); btsLayer.addTo(map); } else map.removeLayer(btsLayer); }
      };
    });
  }

  function initTabs() {
    document.querySelectorAll(".tab").forEach(t => {
      t.onclick = () => { document.querySelectorAll(".tab").forEach(x => x.classList.remove("active")); t.classList.add("active"); };
    });
  }

  /* ---------------- NETWORK-WIDE ANALYTICS (SIM) ---------------- */
  const CLASS_LABELS = [
    ["person", "Person", "c-person"], ["car", "Car", ""], ["motorcycle", "Motorcycle", ""],
    ["bus", "Bus", ""], ["truck", "Truck", ""], ["bicycle", "Bicycle", ""]
  ];
  const agg = { person: 0, car: 0, motorcycle: 0, bus: 0, truck: 0, bicycle: 0 };
  const sparkData = new Array(60).fill(0).map(() => 20 + Math.random() * 40);
  const startedAt = Date.now();

  function tickAnalytics() {
    const load = Math.max(1, cams.filter(c => c.active).length / 60);
    agg.person += (Math.random() * load * 0.6) | 0;
    agg.car += (Math.random() * load * 1.6) | 0;
    agg.motorcycle += (Math.random() * load * 2.1) | 0;
    agg.bus += (Math.random() * load * 0.3) | 0;
    agg.truck += (Math.random() * load * 0.8) | 0;
    agg.bicycle += (Math.random() * load * 0.2) | 0;
    const vehicles = agg.car + agg.motorcycle + agg.bus + agg.truck + agg.bicycle;
    document.getElementById("agg-people").textContent = perMin(agg.person);
    document.getElementById("agg-vehicles").textContent = perMin(vehicles);
    renderClassBars();
    pushSpark(((Math.random() * 40) | 0) + 20);
  }
  function perMin(total) { return Math.round(total / Math.max(1, (Date.now() - startedAt) / 60000)); }

  function renderClassBars() {
    const max = Math.max(...CLASS_LABELS.map(([k]) => agg[k]), 1);
    document.getElementById("class-bars").innerHTML = CLASS_LABELS.map(([k, label, cls]) => {
      const pct = Math.round((agg[k] / max) * 100);
      return `<div class="cbar ${cls}"><div class="top"><span class="lbl">${label}</span><span class="n">${agg[k].toLocaleString()}</span></div>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div></div>`;
    }).join("");
  }

  /* ---------------- EVENT FEED ---------------- */
  const EVENTS = [
    ["info", c => `${c.name} (${c.city}): traffic flow nominal`],
    ["info", c => `Vehicle throughput steady — ${c.road}`],
    ["warn", c => `Congestion building at ${c.name} · ${c.city}`],
    ["warn", c => `Slow traffic detected — ${c.road}`],
    ["info", c => `AI vision re-sync · ${c.name}`],
    ["alert", c => `Stopped vehicle flagged — ${c.name} (${c.city})`],
    ["warn", c => `Feed degraded on ${c.name} · retrying`]
  ];
  function addEvent(sev, msg) {
    const feed = document.getElementById("ai-events");
    const row = document.createElement("div");
    row.className = `event sev-${sev} new`;
    row.innerHTML = `<span class="t">${new Date().toTimeString().slice(0, 8)}</span><span class="msg">${esc(msg)}</span>`;
    feed.prepend(row);
    while (feed.children.length > 40) feed.removeChild(feed.lastChild);
    if (sev === "alert") flashAlert();
  }
  function tickEvents() {
    const online = cams.filter(c => c.active);
    if (!online.length) return;
    const cam = online[(Math.random() * online.length) | 0];
    const [sev, fn] = EVENTS[(Math.random() * EVENTS.length) | 0];
    addEvent(sev, fn(cam));
  }
  let alertTimer;
  function flashAlert() {
    const pill = document.getElementById("alert-pill");
    pill.textContent = "▲ EVENT FLAGGED"; pill.classList.add("warn");
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => { pill.textContent = "● OPERATIONAL"; pill.classList.remove("warn"); }, 4000);
  }

  /* ---------------- SPARKLINE ---------------- */
  function pushSpark(v) { sparkData.push(v); sparkData.shift(); drawSpark(); }
  function drawSpark() {
    const cv = document.getElementById("spark");
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight || 30;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(...sparkData, 1), bw = w / sparkData.length;
    sparkData.forEach((v, i) => {
      const bh = (v / max) * (h - 4);
      ctx.fillStyle = i === sparkData.length - 1 ? "#37e39b" : "rgba(55,227,155,0.35)";
      ctx.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh);
    });
  }
  function tickClock() { document.getElementById("clock").textContent = new Date().toTimeString().slice(0, 8); }

  /* ---------------- CAMERA MODAL + AI ENGINE ---------------- */
  let engine = null, currentCam = null;
  function ensureEngine() {
    if (engine) return engine;
    engine = new VisionEngine(document.getElementById("cam-canvas"), document.getElementById("cam-video"),
      { onStats: onEngineStats, onStatus: onEngineStatus, onEvent: (sev, msg) => addEvent(sev, msg) });
    return engine;
  }
  function initPresets() {
    const sel = document.getElementById("hls-preset");
    sel.innerHTML = `<option value="">— featured live cameras —</option>`
      + featured.map(c => `<option value="${esc(c.hls)}">${esc(c.city)} · ${esc(c.name)}</option>`).join("");
    sel.onchange = () => { if (!sel.value) return; document.getElementById("hls-url").value = sel.value; setSrcActive("btn-hls"); ensureEngine().start("hls", sel.value); };
  }
  function openCamera(cam) {
    currentCam = cam;
    document.getElementById("cam-title").textContent = cam.name || "CCTV";
    document.getElementById("cam-id").textContent = `${cam.city} · ${cam.road} · ${cam.opName}`;
    document.getElementById("cam-note").textContent = "Public toll-road traffic camera (BPJT) · generic object detection, no biometric identification";
    document.getElementById("hls-url").value = cam.hls || "";
    document.getElementById("hls-preset").value = featured.some(f => f.hls === cam.hls) ? cam.hls : "";
    document.getElementById("cam-modal").classList.add("open");
    if (cam.hls) { setSrcActive("btn-hls"); ensureEngine().start("hls", cam.hls); }
    else { setSrcActive("btn-sim"); ensureEngine().start("sim"); }
    addEvent("info", `Opened AI feed · ${cam.name} (${cam.city})`);
  }
  function closeCamera() { if (engine) engine.stop(); document.getElementById("cam-modal").classList.remove("open"); }
  function setSrcActive(id) { ["btn-hls", "btn-sim", "btn-webcam", "btn-file"].forEach(b => document.getElementById(b).classList.toggle("active", b === id)); }
  function onEngineStatus(stt, text) {
    const el = document.getElementById("model-status");
    el.className = "model-status " + (stt === "ready" ? "ready" : stt === "loading" ? "loading" : stt === "err" ? "err" : "");
    document.getElementById("model-text").textContent = text;
  }
  function onEngineStats(s) {
    document.getElementById("m-people").textContent = s.people;
    document.getElementById("m-vehicles").textContent = s.vehicles;
    document.getElementById("m-fps").textContent = s.fps;
    const rows = Object.entries(s.byClass).sort((a, b) => b[1] - a[1]);
    document.getElementById("det-list").innerHTML = rows.length
      ? rows.map(([c, n]) => `<div class="det-row"><span class="cls">${esc(c.toUpperCase())}</span><span class="conf">× ${n}</span></div>`).join("")
      : `<div class="det-row"><span class="cls" style="color:var(--text-faint)">— no objects in frame —</span></div>`;
  }
  function initModal() {
    document.getElementById("cam-close").onclick = closeCamera;
    document.getElementById("cam-modal").addEventListener("click", e => { if (e.target.id === "cam-modal") closeCamera(); });
    document.getElementById("btn-hls").onclick = () => { const url = (document.getElementById("hls-url").value || "").trim() || (currentCam && currentCam.hls); if (url) { setSrcActive("btn-hls"); ensureEngine().start("hls", url); } };
    document.getElementById("hls-go").onclick = () => { const url = (document.getElementById("hls-url").value || "").trim(); if (url) { setSrcActive("btn-hls"); ensureEngine().start("hls", url); } };
    document.getElementById("hls-url").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("hls-go").click(); });
    document.getElementById("btn-sim").onclick = () => { setSrcActive("btn-sim"); ensureEngine().start("sim"); };
    document.getElementById("btn-webcam").onclick = () => { setSrcActive("btn-webcam"); ensureEngine().start("webcam"); };
    document.getElementById("btn-file").onclick = () => document.getElementById("file-input").click();
    document.getElementById("file-input").onchange = e => { const f = e.target.files[0]; if (f) { setSrcActive("btn-file"); ensureEngine().start("file", f); } };
    document.getElementById("btn-stop").onclick = () => { if (engine) engine.stop(); onEngineStatus("idle", "AI engine stopped"); };
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
    renderClassBars();
    drawSpark();
    tickClock();

    const live = cams.filter(c => c.active).length;
    addEvent("info", `SENTINEL online · ${cams.length} CCTV nodes nationwide (${live} active)`);
    addEvent("info", `${bts.length} representative BTS sites loaded · AI engine standby`);

    setInterval(tickClock, 1000);
    setInterval(tickAnalytics, 2000);
    setInterval(tickEvents, 4500);
    window.addEventListener("resize", drawSpark);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
