/* ============================================================
   VisionEngine — real in-browser object detection (COCO-SSD / TF.js)
   + a synthetic "SIM" street feed so the console is usable with no camera.

   Scope note: this engine detects GENERIC object classes only
   (person, car, motorcycle, bus, truck, bicycle). It does NOT perform
   face recognition or any biometric identification of individuals.
   ============================================================ */

(function () {
  const VEHICLE = new Set(["car", "truck", "bus", "motorcycle", "bicycle"]);
  const WATCH = new Set(["person", ...VEHICLE]);
  const SCORE_MIN = 0.45;   // toll cams are distant — a lower gate catches more real vehicles
  // COCO-SSD routinely tags large boxy vehicles (trucks/containers/buses) as "train"
  // from an overhead toll angle; fold that back into "truck" for traffic counting.
  const RELABEL = { train: "truck" };

  const COLORS = {
    person: "#38bdf8",
    car: "#37e39b",
    truck: "#37e39b",
    bus: "#37e39b",
    motorcycle: "#f5a524",
    bicycle: "#f5a524",
    _default: "#9aa"
  };

  class VisionEngine {
    constructor(canvas, video, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.video = video;
      this.onStats = opts.onStats || function () {};
      this.onStatus = opts.onStatus || function () {};
      this.onEvent = opts.onEvent || function () {};
      this.W = canvas.width;
      this.H = canvas.height;

      this.model = null;
      this.running = false;
      this.mode = null;       // 'hls' | 'webcam' | 'file' | 'sim'
      this.stream = null;
      this.hls = null;
      this._raf = null;
      this._last = performance.now();
      this._fps = 0;
      this._sim = null;
      this._alertCooldown = 0;
      this._hlsTimeout = null;
      this.detectDisabled = false;   // set if the source is CORS-tainted (can play, can't read pixels)
    }

    async _ensureModel() {
      if (this.model) return this.model;
      if (typeof cocoSsd === "undefined") {
        this.onStatus("err", "Model lib not loaded (offline?)");
        throw new Error("cocoSsd missing");
      }
      this.onStatus("loading", "Loading COCO-SSD model…");
      // mobilenet_v2 base: noticeably better recall on small/distant traffic than the lite base.
      this.model = await cocoSsd.load({ base: "mobilenet_v2" });
      this.onStatus("ready", "AI VISION ENGINE · ONLINE");
      return this.model;
    }

    async start(mode, arg) {
      this.stop();
      this.mode = mode;
      this.running = true;
      this.detectDisabled = false;

      if (mode === "sim") {
        this.onStatus("ready", "SIMULATED FEED · analytics demo");
        this._startSim();
        return;
      }

      try {
        await this._ensureModel();
      } catch (e) {
        this._startSim();
        return;
      }

      if (mode === "hls") {
        const ok = await this._attachHls(arg);
        if (!ok) return;           // _attachHls already fell back to sim
      } else if (mode === "webcam") {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720, facingMode: "environment" },
            audio: false
          });
          this.video.srcObject = this.stream;
          await this.video.play();
          this.onStatus("ready", "LIVE CAMERA · AI detection active");
        } catch (e) {
          this.onStatus("err", "Camera blocked — using SIM feed");
          this._startSim();
          return;
        }
      } else if (mode === "file") {
        this.video.srcObject = null;
        this.video.crossOrigin = null;
        this.video.src = URL.createObjectURL(arg);
        this.video.loop = true;
        this.video.muted = true;
        await this.video.play().catch(() => {});
        this.onStatus("ready", "VIDEO FEED · AI detection active");
      }

      this._detectLoop();
    }

    /* Attach a live HLS stream via hls.js (MSE) or native playback (Safari).
       Returns true once playing, false if it failed and fell back to sim. */
    _attachHls(url) {
      return new Promise(resolve => {
        const v = this.video;
        v.srcObject = null;
        v.crossOrigin = "anonymous";   // needed for native HLS so the canvas isn't tainted
        v.muted = true;
        v.loop = false;
        v.playsInline = true;

        let settled = false;
        const clear = () => { if (this._hlsTimeout) { clearTimeout(this._hlsTimeout); this._hlsTimeout = null; } };
        const ready = async () => {
          if (settled) return; settled = true; clear();
          try { await v.play(); } catch (e) {}
          this.onStatus("ready", "LIVE CCTV · AI detection active");
          resolve(true);
        };
        const fail = (msg) => {
          if (settled) return; settled = true; clear();
          this.onStatus("err", msg + " — using SIM feed");
          this._startSim();
          resolve(false);
        };

        if (window.Hls && window.Hls.isSupported()) {
          const hls = new Hls({ liveSyncDurationCount: 3, manifestLoadingTimeOut: 12000, fragLoadingTimeOut: 20000, enableWorker: true });
          this.hls = hls;
          hls.loadSource(url);
          hls.attachMedia(v);
          hls.on(Hls.Events.MANIFEST_PARSED, ready);
          hls.on(Hls.Events.ERROR, (evt, data) => {
            if (!data.fatal) return;
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { hls.recoverMediaError(); return; } catch (e) {} }
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && settled) { try { hls.startLoad(); return; } catch (e) {} }
            fail("HLS " + (data.details || "error"));
          });
        } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
          v.src = url;
          v.addEventListener("loadedmetadata", ready, { once: true });
          v.addEventListener("error", () => fail("HLS load failed"), { once: true });
        } else {
          fail("HLS unsupported in this browser");
          return;
        }
        // generous: some city cameras (720p60) take ~10 s to deliver their first segment
        this._hlsTimeout = setTimeout(() => fail("HLS timeout / unreachable"), 25000);
      });
    }

    stop() {
      this.running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this._hlsTimeout) { clearTimeout(this._hlsTimeout); this._hlsTimeout = null; }
      if (this._sim) { clearInterval(this._sim.timer); this._sim = null; }
      if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
      if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
      if (this.video) {
        try { this.video.pause(); } catch (e) {}
        if (this.video.src) { try { URL.revokeObjectURL(this.video.src); } catch (e) {} this.video.removeAttribute("src"); }
        this.video.srcObject = null;
        this.video.crossOrigin = null;
      }
      this.ctx.clearRect(0, 0, this.W, this.H);
    }

    async _detectLoop() {
      if (!this.running || this.mode === "sim") return;
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        let preds = [];
        if (!this.detectDisabled) {
          try {
            preds = await this.model.detect(v, 30);
          } catch (e) {
            // A cross-origin source with no CORS headers taints the canvas:
            // keep showing the stream, but stop trying to read its pixels.
            if (/secur|cross-origin|tainted/i.test(String(e && e.message))) {
              this.detectDisabled = true;
              this.onStatus("ready", "LIVE · detection blocked (CORS-restricted feed)");
            }
          }
        }
        preds = preds
          .map(p => (RELABEL[p.class] ? Object.assign({}, p, { class: RELABEL[p.class] }) : p))
          .filter(p => p.score >= SCORE_MIN && WATCH.has(p.class));
        this._drawVideoFrame(v, preds);
        if (!this.detectDisabled) this._emit(preds);
      }
      this._tickFps();
      this._raf = requestAnimationFrame(() => this._detectLoop());
    }

    _drawVideoFrame(v, preds) {
      const ctx = this.ctx, W = this.W, H = this.H;
      // cover-fit the video into the canvas
      const vr = v.videoWidth / v.videoHeight, cr = W / H;
      let dw, dh, dx, dy;
      if (vr > cr) { dh = H; dw = H * vr; dx = (W - dw) / 2; dy = 0; }
      else { dw = W; dh = W / vr; dx = 0; dy = (H - dh) / 2; }
      ctx.drawImage(v, dx, dy, dw, dh);
      const sx = dw / v.videoWidth, sy = dh / v.videoHeight;

      preds.forEach(p => {
        const [x, y, w, h] = p.bbox;
        this._box(dx + x * sx, dy + y * sy, w * sx, h * sy, p.class, p.score);
      });
      this._overlayGrid();
    }

    _box(x, y, w, h, cls, score) {
      const ctx = this.ctx;
      const col = COLORS[cls] || COLORS._default;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = col;
      ctx.strokeRect(x, y, w, h);
      // corner ticks
      const t = Math.min(12, w / 3, h / 3);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, y + t); ctx.lineTo(x, y); ctx.lineTo(x + t, y);
      ctx.moveTo(x + w - t, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + t);
      ctx.moveTo(x, y + h - t); ctx.lineTo(x, y + h); ctx.lineTo(x + t, y + h);
      ctx.moveTo(x + w - t, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - t);
      ctx.stroke();
      // label
      const label = `${cls.toUpperCase()} ${(score * 100) | 0}%`;
      ctx.font = "10px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = "rgba(5,8,10,0.82)";
      ctx.fillRect(x, y - 15, tw, 14);
      ctx.fillStyle = col;
      ctx.fillText(label, x + 5, y - 4);
    }

    _overlayGrid() {
      const ctx = this.ctx, W = this.W, H = this.H;
      ctx.strokeStyle = "rgba(55,227,155,0.05)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 6; i++) {
        ctx.beginPath(); ctx.moveTo((W / 6) * i, 0); ctx.lineTo((W / 6) * i, H); ctx.stroke();
      }
    }

    _emit(preds) {
      const by = {};
      preds.forEach(p => { by[p.class] = (by[p.class] || 0) + 1; });
      const people = by.person || 0;
      let vehicles = 0; VEHICLE.forEach(c => vehicles += (by[c] || 0));
      this.onStats({ fps: this._fps, byClass: by, people, vehicles, total: preds.length });

      // generic, anonymous anomaly alerting (density spikes only)
      if (this._alertCooldown > 0) { this._alertCooldown--; return; }
      if (people >= 6) { this.onEvent("alert", `High pedestrian density detected (${people})`); this._alertCooldown = 90; }
      else if (vehicles >= 8) { this.onEvent("warn", `Traffic congestion forming (${vehicles} vehicles)`); this._alertCooldown = 90; }
    }

    _tickFps() {
      const now = performance.now();
      const dt = now - this._last; this._last = now;
      if (dt > 0) this._fps = Math.round(0.8 * this._fps + 0.2 * (1000 / dt));
    }

    /* ---------------- SIMULATED FEED ---------------- */
    _startSim() {
      const W = this.W, H = this.H;
      const horizon = H * 0.26;
      const actors = [];
      const spawn = () => {
        const isPerson = Math.random() < 0.35;
        const lane = 0.3 + Math.random() * 0.4;
        actors.push({
          person: isPerson,
          cls: isPerson ? "person" : ["car", "car", "truck", "bus", "motorcycle"][(Math.random() * 5) | 0],
          x: lane, depth: 0, speed: 0.0018 + Math.random() * 0.0022,
          side: Math.random() < 0.5 ? -1 : 1,
          conf: 0.62 + Math.random() * 0.34
        });
      };
      for (let i = 0; i < 6; i++) { spawn(); actors[i].depth = Math.random(); }

      const draw = () => {
        if (!this.running) return;
        const ctx = this.ctx;
        // road scene
        ctx.fillStyle = "#070b0d"; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#0d1316"; ctx.fillRect(0, horizon, W, H - horizon);
        // sky grid
        ctx.strokeStyle = "rgba(55,227,155,0.05)";
        for (let i = 0; i <= 10; i++) { ctx.beginPath(); ctx.moveTo((W / 10) * i, horizon); ctx.lineTo(W / 2, horizon * 0.3); ctx.stroke(); }
        // road edges (perspective)
        ctx.strokeStyle = "rgba(120,140,130,0.25)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(W * 0.46, horizon); ctx.lineTo(W * 0.02, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(W * 0.54, horizon); ctx.lineTo(W * 0.98, H); ctx.stroke();
        // lane dashes
        this._simDash = (this._simDash || 0) + 0.012;
        ctx.setLineDash([14, 20]); ctx.lineDashOffset = -this._simDash * 400;
        ctx.strokeStyle = "rgba(200,200,160,0.18)";
        ctx.beginPath(); ctx.moveTo(W * 0.5, horizon); ctx.lineTo(W * 0.5, H); ctx.stroke();
        ctx.setLineDash([]);

        const by = {};
        for (let i = actors.length - 1; i >= 0; i--) {
          const a = actors[i];
          a.depth += a.speed * (a.person ? 0.7 : 1);
          if (a.depth >= 1) { actors.splice(i, 1); continue; }
          const scale = Math.pow(a.depth, 2.1);
          const cx = W / 2 + (a.x - 0.5) * W * (0.1 + a.depth * 1.7) * a.side * 0.6 + (a.x - 0.5) * W * a.depth;
          const y = horizon + (H - horizon) * a.depth;
          let w, h;
          if (a.person) { w = 10 + 42 * scale; h = w * 2.4; }
          else { w = 26 + 150 * scale; h = w * 0.72; }
          const x = cx - w / 2, top = y - h;
          // body
          ctx.fillStyle = a.person ? "rgba(70,110,140,0.55)" : "rgba(60,80,75,0.7)";
          ctx.fillRect(x, top, w, h);
          if (a.depth > 0.12) this._box(x, top, w, h, a.cls, a.conf);
          by[a.cls] = (by[a.cls] || 0) + 1;
        }
        this._overlayGrid();
        if (Math.random() < 0.03) spawn();

        const people = by.person || 0;
        let vehicles = 0; VEHICLE.forEach(c => vehicles += (by[c] || 0));
        this._fps = 24 + ((Math.random() * 4) | 0);
        this.onStats({ fps: this._fps, byClass: by, people, vehicles, total: people + vehicles });
      };

      this._sim = { timer: setInterval(draw, 1000 / 24) };
    }
  }

  window.VisionEngine = VisionEngine;
})();
