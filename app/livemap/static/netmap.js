// Shared map layer for the live map and the planner: the coloured network (U-Bahn, tram,
// bus lines with line-number badges) and live vehicles animated between stops from the
// real-time data (PULS API), moving along the routed stop-to-stop segments.

const NetMap = (() => {
  // City bus lines have no official colours (livemap.vag.de draws them all grey). There are
  // ~50 of them, so colours repeat: each line gets a fixed slot by its rank in the sorted
  // line list (neighbouring numbers usually serve the same district and get different
  // colours). Identity is carried by the line labels and hover highlight, not colour alone.
  const BUS_PALETTE = [
    "#2a78d6", "#d95926", "#13915f", "#b5338a", "#7a5c00", "#4a3aa7", "#c0392b", "#0f7c8c",
    "#8e44ad", "#5b7a00", "#a0522d", "#1c5cab", "#d4477a", "#2e7d32", "#6d4c41", "#00838f",
  ];
  const REGIO_COLOR = "#b9bec8";

  // ---------- helpers ----------
  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0b0b" : "#ffffff";
  }
  function delayStatus(trip, delay) {
    if (!trip.realtime) return "none";
    if (delay <= 60) return "good";
    if (delay <= 180) return "warning";
    if (delay <= 300) return "serious";
    return "critical";
  }
  function fmtDelay(sec) {
    const m = Math.round(sec / 60);
    if (m === 0) return "on time";
    return m > 0 ? `+${m} min` : `${-m} min early`;
  }
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const lineLabel = (product, line) => `${product === "UBahn" ? "" : product + " "}${line}`;

  /**
   * opts:
   *   initialLayers   {"net-UBahn": true, "net-Tram": true, "net-Bus": true, "net-Regio": false}
   *   labelMinZoom    zoom from which line badges show (default 13)
   *   onLineClick(product, line)
   *   vehicleFilter(trip) -> bool     extra filter on top of the product toggles
   *   vehicleClass(trip) -> string    extra CSS class for a vehicle marker
   *   onStats(stats), onUpdate(data)  called after each animation frame / poll
   */
  function create(map, opts = {}) {
    const o = { labelMinZoom: 13, pollMs: 15000, animateMs: 1000, ...opts };
    for (const [name, z] of [["network", 350], ["trip", 420], ["labels", 430], ["stops", 450]]) {
      if (!map.getPane(name)) map.createPane(name).style.zIndex = z;
    }
    const layers = { "net-Regio": L.layerGroup(), "net-Bus": L.layerGroup(), "net-Tram": L.layerGroup(), "net-UBahn": L.layerGroup() };
    const vehicleLayer = L.layerGroup().addTo(map);
    const tripLayer = L.layerGroup().addTo(map);
    const labelLayer = L.layerGroup().addTo(map);
    const lineLabels = [];
    const lineColor = {}; // rail line -> official colour
    const busColor = {}; // bus line -> assigned colour
    const lineFeatures = {}; // "Product:Line" -> [L.GeoJSON] (each with _baseStyle)
    const showProducts = { Bus: true, Tram: true, UBahn: true };
    const markers = new Map(); // trip id -> L.marker
    const segments = new Map(); // id -> { pts, cum, len }
    let trips = [];
    let openTripId = null;
    let labelFilter = null; // (product, line) -> bool

    function busColorOf(line) {
      if (!busColor[line]) { // lines not in the static network (e.g. replacement services)
        let h = 0;
        for (const ch of line) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        busColor[line] = BUS_PALETTE[h % BUS_PALETTE.length];
      }
      return busColor[line];
    }
    const colorOf = (product, line) => (product === "Bus" ? busColorOf(line) : lineColor[line] || "#52514e");

    // ---------- network ----------
    async function loadNetwork() {
      const net = await (await fetch("/api/network")).json();
      for (const f of net.features) if (f.properties.color) lineColor[f.properties.line] = f.properties.color;
      const busLines = [...new Set(net.features.filter((f) => f.properties.product === "Bus" && f.properties.operator === "vag")
        .map((f) => f.properties.line))].sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
      busLines.forEach((l, i) => { busColor[l] = BUS_PALETTE[i % BUS_PALETTE.length]; });
      // draw regional first so city lines sit on top
      const rank = (p) => ({ vgn: 0, Bus: 1, Tram: 2, UBahn: 3 }[p.operator === "vgn" ? "vgn" : p.product]);
      net.features.sort((a, b) => rank(a.properties) - rank(b.properties));
      for (const f of net.features) {
        const p = f.properties;
        const regio = p.product === "Bus" && p.operator === "vgn";
        const style = p.product === "UBahn" ? { color: p.color, weight: 5, opacity: 0.9 }
          : p.product === "Tram" ? { color: p.color, weight: 4, opacity: 0.85 }
          : regio ? { color: REGIO_COLOR, weight: 1.5, opacity: 0.8, dashArray: "4 4" }
          : { color: busColor[p.line], weight: 3, opacity: 0.8 };
        const layer = L.geoJSON(f, { style: { ...style, pane: "network" } });
        layer.bindTooltip(`${lineLabel(p.product, p.line)}${regio ? " (VGN)" : ""}`, { sticky: true });
        layer.on("click", () => o.onLineClick?.(p.product, p.line));
        layer._baseStyle = style;
        layer._regio = regio;
        layers[regio ? "net-Regio" : `net-${p.product}`].addLayer(layer);
        if (!regio) {
          addLineLabels(f, p, style.color);
          (lineFeatures[`${p.product}:${p.line}`] ||= []).push(layer);
        }
      }
      const init = { "net-UBahn": true, "net-Tram": true, "net-Bus": true, "net-Regio": false, ...o.initialLayers };
      for (const [k, lg] of Object.entries(layers)) if (init[k]) lg.addTo(map);
      updateLabels();
    }

    // Line-number badges at 25 % and 75 % along each line.
    function addLineLabels(f, p, color) {
      const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
      const pts = parts.flat();
      const dist = [0];
      for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = dist[dist.length - 1];
      if (!total) return;
      for (const frac of [0.25, 0.75]) {
        const i = dist.findIndex((d) => d >= total * frac);
        const [lon, lat] = pts[Math.max(0, i)];
        const label = L.marker([lat, lon], {
          icon: L.divIcon({
            className: "line-label-icon",
            html: `<div class="line-label ${p.product.toLowerCase()}" style="--c:${color};--fg:${textColorFor(color)}">${esc(p.line)}</div>`,
            iconSize: null, iconAnchor: [12, 9],
          }),
          pane: "labels", keyboard: false,
        });
        label.on("click", () => o.onLineClick?.(p.product, p.line));
        lineLabels.push({ marker: label, layer: `net-${p.product}`, product: p.product, line: p.line });
      }
    }
    function updateLabels() {
      const zoomOk = map.getZoom() >= o.labelMinZoom;
      for (const l of lineLabels) {
        const want = zoomOk && map.hasLayer(layers[l.layer]) && (!labelFilter || labelFilter(l.product, l.line));
        if (want && !map.hasLayer(l.marker)) labelLayer.addLayer(l.marker);
        if (!want && map.hasLayer(l.marker)) labelLayer.removeLayer(l.marker);
      }
    }
    map.on("zoomend", updateLabels);

    function setLayer(key, on) {
      on ? layers[key].addTo(map) : map.removeLayer(layers[key]);
      updateLabels();
    }

    // ---------- segments (routed paths between stops) ----------
    function addSegment(id, pts) {
      const cum = [0];
      for (let i = 1; i < pts.length; i++) {
        const dy = pts[i][0] - pts[i - 1][0], dx = (pts[i][1] - pts[i - 1][1]) * 0.65; // cos(49.45°)
        cum.push(cum[i - 1] + Math.hypot(dx, dy) * 111320);
      }
      segments.set(Number(id), { pts, cum, len: cum[cum.length - 1] });
    }
    async function loadMissingSegments() {
      const missing = [...new Set(trips.flatMap((t) => t.stops.map((s) => s.seg)).filter((id) => id !== undefined && !segments.has(id)))];
      if (!missing.length) return;
      const res = await fetch("/api/segments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(missing) });
      for (const [id, pts] of Object.entries(await res.json())) addSegment(id, pts);
    }
    function alongSegment(seg, f) {
      const d = seg.len * f;
      let i = 1;
      while (i < seg.cum.length - 1 && seg.cum[i] < d) i++;
      const span = seg.cum[i] - seg.cum[i - 1];
      const g = span > 0 ? (d - seg.cum[i - 1]) / span : 1;
      const [a, b] = [seg.pts[i - 1], seg.pts[i]];
      return [a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g];
    }
    // Where a vehicle stands at stop i: on the line (end of the arriving path) if known.
    function stopPoint(s, i) {
      const inSeg = segments.get(s[i].seg), outSeg = s[i + 1] && segments.get(s[i + 1].seg);
      if (inSeg) return inSeg.pts[inSeg.pts.length - 1];
      if (outSeg) return outSeg.pts[0];
      return [s[i].lat, s[i].lon];
    }
    function tripPath(trip) {
      const pts = [];
      for (const st of trip.stops) {
        const seg = segments.get(st.seg);
        if (seg) pts.push(...seg.pts);
        else pts.push([st.lat, st.lon]);
      }
      return pts;
    }
    // Position + current delay of a trip at time t (epoch seconds), or null if not on the road.
    function locate(trip, t) {
      const s = trip.stops;
      if (s.length < 2) return null;
      const first = s[0], last = s[s.length - 1];
      if (t < first.dep - 120 || t > last.arr + 60) return null;
      const at = (i) => { const [lat, lon] = stopPoint(s, i); return { lat, lon, delay: s[i].delay, next: i }; };
      if (t <= first.dep) return { ...at(0), next: 0 };
      for (let i = 1; i < s.length; i++) {
        const a = s[i - 1], b = s[i];
        if (t <= b.arr) {
          const f = b.arr > a.dep ? Math.min(1, Math.max(0, (t - a.dep) / (b.arr - a.dep))) : 1;
          const seg = segments.get(b.seg);
          const [lat, lon] = seg ? alongSegment(seg, f) : [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
          return { lat, lon, delay: b.delay, next: i };
        }
        if (t <= b.dep) return at(i);
      }
      return at(s.length - 1);
    }

    // ---------- vehicles ----------
    async function poll() {
      try {
        const data = await (await fetch("/api/vehicles")).json();
        trips = data.trips;
        await loadMissingSegments();
        o.onUpdate?.(data, trips);
        animate();
      } catch {
        o.onUpdate?.(null, trips);
      }
    }

    function iconFor(t, status, extra) {
      const c = colorOf(t.product, t.line);
      return L.divIcon({
        className: `veh-icon ${extra}`,
        html: `<div class="veh ${t.product.toLowerCase()}" style="--c:${c};--fg:${textColorFor(c)}">${esc(t.line)}<i class="dot ${status}"></i></div>`,
        iconSize: null,
        iconAnchor: [14, 11],
      });
    }

    function animate() {
      const now = Date.now() / 1000;
      const seen = new Set();
      const stats = { total: 0, byProduct: { Bus: 0, Tram: 0, UBahn: 0 }, rt: 0, ontime: 0, late: 0, delaySum: 0, lines: {} };
      for (const t of trips) {
        const pos = locate(t, now);
        if (!pos) continue;
        stats.total++;
        stats.byProduct[t.product]++;
        if (t.realtime) {
          stats.rt++;
          stats.delaySum += Math.max(0, pos.delay);
          if (pos.delay <= 60) stats.ontime++;
          if (pos.delay > 180) stats.late++;
          const l = (stats.lines[`${t.product}|${t.line}`] ||= { product: t.product, line: t.line, n: 0, sum: 0 });
          l.n++; l.sum += Math.max(0, pos.delay);
        }
        if (!showProducts[t.product] || (o.vehicleFilter && !o.vehicleFilter(t))) continue;
        seen.add(t.id);
        const status = delayStatus(t, pos.delay);
        const extra = o.vehicleClass?.(t) || "";
        let m = markers.get(t.id);
        if (!m) {
          m = L.marker([pos.lat, pos.lon], { icon: iconFor(t, status, extra), keyboard: false });
          m.on("click", () => openTrip(t.id, m));
          m.addTo(vehicleLayer);
          markers.set(t.id, m);
        } else {
          m.setLatLng([pos.lat, pos.lon]);
          if (m._status !== status || m._extra !== extra) m.setIcon(iconFor(t, status, extra));
        }
        m._status = status;
        m._extra = extra;
        m._trip = t;
        m._pos = pos;
      }
      for (const [id, m] of markers) if (!seen.has(id)) { vehicleLayer.removeLayer(m); markers.delete(id); }
      if (openTripId && markers.has(openTripId)) renderTripPopup(markers.get(openTripId));
      o.onStats?.(stats);
    }

    function openTrip(id, m) {
      openTripId = id;
      tripLayer.clearLayers();
      const t = m._trip, c = colorOf(t.product, t.line);
      L.polyline(tripPath(t), { color: c, weight: 4, opacity: 0.6, dashArray: "6 6", pane: "trip" }).addTo(tripLayer);
      t.stops.forEach((s, i) => L.circleMarker(stopPoint(t.stops, i), { radius: 3, color: c, weight: 2, fillColor: "#fff", fillOpacity: 1, pane: "trip" }).bindTooltip(s.name).addTo(tripLayer));
      m.bindPopup("", { maxWidth: 320, autoPan: false });
      renderTripPopup(m);
      m.openPopup();
    }
    function renderTripPopup(m) {
      const t = m._trip, pos = m._pos;
      if (!m.getPopup()) return;
      const status = delayStatus(t, pos.delay);
      const label = { good: "✓ on time", warning: "▲ " + fmtDelay(pos.delay), serious: "▲ " + fmtDelay(pos.delay), critical: "■ " + fmtDelay(pos.delay), none: "○ no real-time data" }[status];
      const rows = t.stops.map((s, i) => `<tr class="${i < pos.next ? "past" : ""}"><td>${fmtTime(s.dep || s.arr)}</td><td>${esc(s.name)}</td>
        <td class="${s.delay > 180 ? "late" : ""}">${t.realtime ? fmtDelay(s.delay) : ""}</td></tr>`);
      const from = Math.max(0, pos.next - 2);
      m.setPopupContent(`<div class="popup"><h3>${esc(lineLabel(t.product, t.line))} → ${esc(t.direction)}</h3>
        <p class="meta"><i class="dot ${status}"></i> ${label} · vehicle ${esc(t.vehicle ?? "?")}</p>
        ${o.tripNote ? o.tripNote(t) : ""}
        <table>${rows.slice(from, from + 8).join("")}</table></div>`);
    }
    map.on("popupclose", (e) => {
      if (e.popup._source && e.popup._source._trip) { openTripId = null; tripLayer.clearLayers(); }
    });

    // ---------- stops (VAG, with live departures on click) ----------
    const stopsLayer = L.layerGroup();
    let stopsOn = false, stopsForced = false;
    async function loadStops(visible = true) {
      const stops = await (await fetch("/api/stops")).json();
      for (const s of stops) {
        const m = L.circleMarker([s.lat, s.lon], {
          radius: 4, color: "#52514e", weight: 1.5, fillColor: "#fff", fillOpacity: 1, pane: "stops",
        });
        m.bindTooltip(s.name);
        m.on("click", () => showDepartures(m, s));
        stopsLayer.addLayer(m);
      }
      stopsOn = visible;
      updateStops();
    }
    function updateStops() {
      const want = (stopsOn || stopsForced) && map.getZoom() >= (o.stopsMinZoom ?? 14);
      if (want && !map.hasLayer(stopsLayer)) stopsLayer.addTo(map);
      if (!want && map.hasLayer(stopsLayer)) map.removeLayer(stopsLayer);
    }
    map.on("zoomend", updateStops);
    async function showDepartures(marker, stop) {
      marker.bindPopup(`<div class="popup"><h3>${esc(stop.name)}</h3><p class="meta">Loading departures…</p></div>`).openPopup();
      try {
        const deps = await (await fetch(`/api/departures/${stop.vgn_id}`)).json();
        const rows = deps.map((d) => {
          const planned = new Date(d.planned), actual = d.actual ? new Date(d.actual) : planned;
          const delay = (actual - planned) / 1000;
          return `<tr><td><b>${esc(d.line)}</b></td><td>${esc(d.direction)}</td><td>${fmtTime(planned / 1000)}</td>
            <td class="${delay > 180 ? "late" : ""}">${d.realtime ? fmtDelay(delay) : "timetable"}</td></tr>`;
        }).join("");
        marker.setPopupContent(`<div class="popup"><h3>${esc(stop.name)}</h3><p class="meta">${esc(stop.products.join(" · "))}</p>
          <table>${rows || "<tr><td>No departures</td></tr>"}</table></div>`);
      } catch {
        marker.setPopupContent(`<div class="popup"><h3>${esc(stop.name)}</h3><p class="meta">Departures unavailable</p></div>`);
      }
    }

    async function start() {
      await loadNetwork();
      await poll();
      setInterval(poll, o.pollMs);
      setInterval(animate, o.animateMs);
    }

    return {
      start, animate, setLayer, updateLabels, colorOf, layers, lineFeatures, vehicleLayer, loadStops,
      setStopsVisible(on) { stopsOn = on; updateStops(); },
      forceStops(on) { stopsForced = on; updateStops(); },
      get trips() { return trips; },
      setProductVisible(product, on) { showProducts[product] = on; animate(); },
      setLabelFilter(fn) { labelFilter = fn; updateLabels(); },
      setVehiclesVisible(on) { on ? vehicleLayer.addTo(map) : map.removeLayer(vehicleLayer); },
    };
  }

  return { create, esc, fmtTime, fmtDelay, delayStatus, textColorFor, lineLabel, REGIO_COLOR };
})();
