// Nuremberg live network map. Vehicles are animated client-side by interpolating
// between stops using real-time (Ist) times, falling back to timetable (Soll) times.

const VEHICLE_POLL_MS = 15000;
const ANIMATE_MS = 1000;
const STOPS_MIN_ZOOM = 14;
const BUS_COLOR = getComputedStyle(document.documentElement).getPropertyValue("--bus").trim();
const LABEL_MIN_ZOOM = 13;
// City bus lines have no official colours (livemap.vag.de draws them all grey). There are
// ~50 of them, so colours repeat: each line gets a fixed slot by its rank in the sorted
// line list (neighbouring numbers usually serve the same district and get different
// colours). Identity is carried by the line labels and hover highlight, not colour alone.
const BUS_PALETTE = [
  "#2a78d6", "#d95926", "#13915f", "#b5338a", "#7a5c00", "#4a3aa7", "#c0392b", "#0f7c8c",
  "#8e44ad", "#5b7a00", "#a0522d", "#1c5cab", "#d4477a", "#2e7d32", "#6d4c41", "#00838f",
];

const map = L.map("map", { preferCanvas: true, zoomControl: false }).setView([49.4521, 11.0767], 13);
L.control.zoom({ position: "topright" }).addTo(map);

const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const basemaps = {
  "Light (grey)": L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR, className: "tiles-grey" }),
  OpenStreetMap: L.tileLayer(OSM_URL, { maxZoom: 19, attribution: OSM_ATTR }),
};
basemaps["Light (grey)"].addTo(map);
L.control.layers(basemaps, null, { position: "topright" }).addTo(map);

map.createPane("network").style.zIndex = 350;
map.createPane("stops").style.zIndex = 450;
map.createPane("trip").style.zIndex = 420;
map.createPane("labels").style.zIndex = 430;

const layers = {
  "net-Regio": L.layerGroup(),
  "net-Bus": L.layerGroup(),
  "net-Tram": L.layerGroup(),
  "net-UBahn": L.layerGroup(),
  stops: L.layerGroup(),
};
const vehicleLayer = L.layerGroup().addTo(map);
const tripLayer = L.layerGroup().addTo(map);
const labelLayer = L.layerGroup().addTo(map);
const lineLabels = [];
const lineColor = {};      // line -> official color (rail)
const busColor = {};       // line -> assigned color (city bus)
const lineFeatures = {};   // line -> [L.Polyline]
let trips = [];
const markers = new Map(); // trip id -> L.marker
let selectedLine = "";
let openTripId = null;

// ---------- helpers ----------
function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0b0b" : "#ffffff";
}
function busColorOf(line) {
  if (!busColor[line]) {  // lines not in the static network (e.g. replacement services)
    let h = 0;
    for (const ch of line) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    busColor[line] = BUS_PALETTE[h % BUS_PALETTE.length];
  }
  return busColor[line];
}
const colorOf = (t) => (t.product === "Bus" ? busColorOf(t.line) : lineColor[t.line] || "#52514e");

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

// Routed stop-to-stop paths from the server (snapped to the line geometry), by id.
const segments = new Map(); // id -> { pts: [[lat, lon]], cum: [m], len: m }
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
  const s = trip.stops, pts = [];
  s.forEach((st, i) => {
    const seg = segments.get(st.seg);
    if (seg) pts.push(...seg.pts);
    else pts.push([st.lat, st.lon]);
  });
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

// ---------- network ----------
async function loadNetwork() {
  const net = await (await fetch("/api/network")).json();
  for (const f of net.features) {
    const p = f.properties;
    if (p.color) lineColor[p.line] = p.color;
  }
  const busLines = [...new Set(net.features.filter((f) => f.properties.product === "Bus" && f.properties.operator === "vag")
    .map((f) => f.properties.line))].sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
  busLines.forEach((l, i) => { busColor[l] = BUS_PALETTE[i % BUS_PALETTE.length]; });
  // draw regional first so city lines sit on top
  const order = { vgn: 0, Bus: 1, Tram: 2, UBahn: 3 };
  net.features.sort((a, b) => (order[a.properties.operator === "vgn" ? "vgn" : a.properties.product]) - (order[b.properties.operator === "vgn" ? "vgn" : b.properties.product]));
  for (const f of net.features) {
    const p = f.properties;
    const regio = p.product === "Bus" && p.operator === "vgn";
    const style = p.product === "UBahn" ? { color: p.color, weight: 5, opacity: 0.9 }
      : p.product === "Tram" ? { color: p.color, weight: 4, opacity: 0.85 }
      : regio ? { color: "#b9bec8", weight: 1.5, opacity: 0.8, dashArray: "4 4" }
      : { color: busColor[p.line], weight: 3, opacity: 0.8 };
    const layer = L.geoJSON(f, { style: { ...style, pane: "network" } });
    layer.bindTooltip(`${p.product === "UBahn" ? "" : p.product + " "}${p.line}${regio ? " (VGN)" : ""}`, { sticky: true });
    layer.on("click", () => setLine(p.line));
    layer._baseStyle = style;
    layers[regio ? "net-Regio" : `net-${p.product}`].addLayer(layer);
    if (!regio) addLineLabels(f, p, style.color);
    (lineFeatures[p.line] ||= []).push(layer);
  }
  for (const [k, lg] of Object.entries(layers)) if (k !== "stops" && document.querySelector(`[data-layer="${k}"]`).checked) lg.addTo(map);
  updateLabelVisibility();
}

// Line-number badges at 25 % and 75 % along each line (shown from LABEL_MIN_ZOOM).
function addLineLabels(f, p, color) {
  const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const pts = parts.flat();
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = dist[dist.length - 1];
  if (!total) return;
  const cls = p.product.toLowerCase();
  for (const frac of [0.25, 0.75]) {
    const i = dist.findIndex((d) => d >= total * frac);
    const [lon, lat] = pts[Math.max(0, i)];
    const label = L.marker([lat, lon], {
      icon: L.divIcon({
        className: "line-label-icon",
        html: `<div class="line-label ${cls}" style="--c:${color};--fg:${textColorFor(color)}">${esc(p.line)}</div>`,
        iconSize: null, iconAnchor: [12, 9],
      }),
      pane: "labels", keyboard: false,
    });
    label.on("click", () => setLine(p.line));
    label._line = p.line;
    lineLabels.push({ marker: label, layer: `net-${p.product}` });
  }
}
function updateLabelVisibility() {
  const zoomOk = map.getZoom() >= LABEL_MIN_ZOOM;
  for (const { marker, layer } of lineLabels) {
    const want = zoomOk && map.hasLayer(layers[layer]) && (!selectedLine || marker._line === selectedLine);
    if (want && !map.hasLayer(marker)) labelLayer.addLayer(marker);
    if (!want && map.hasLayer(marker)) labelLayer.removeLayer(marker);
  }
}
map.on("zoomend", updateLabelVisibility);

async function loadStops() {
  const stops = await (await fetch("/api/stops")).json();
  for (const s of stops) {
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 4, color: "#52514e", weight: 1.5, fillColor: "#fff", fillOpacity: 1, pane: "stops",
    });
    m.bindTooltip(s.name);
    m.on("click", () => showDepartures(m, s));
    layers.stops.addLayer(m);
  }
  updateStopsVisibility();
}
function updateStopsVisibility() {
  const want = document.querySelector('[data-layer="stops"]').checked && map.getZoom() >= STOPS_MIN_ZOOM;
  if (want && !map.hasLayer(layers.stops)) layers.stops.addTo(map);
  if (!want && map.hasLayer(layers.stops)) map.removeLayer(layers.stops);
}
map.on("zoomend", updateStopsVisibility);

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

// ---------- vehicles ----------
async function pollVehicles() {
  try {
    const data = await (await fetch("/api/vehicles")).json();
    trips = data.trips;
    await loadMissingSegments();
    document.getElementById("updated").textContent = data.updated
      ? `Live · data from ${fmtTime(data.updated)} · ${trips.length} trips tracked`
      : "Loading live data (first poll takes ~30 s)…";
    updateLineFilter();
    animate();
  } catch {
    document.getElementById("updated").textContent = "Server unreachable — retrying…";
  }
}

function vehicleVisible(t) {
  if (!document.querySelector(`[data-veh="${t.product}"]`).checked) return false;
  return !selectedLine || t.line === selectedLine;
}

function iconFor(t, status) {
  const c = colorOf(t);
  const cls = t.product.toLowerCase();
  return L.divIcon({
    className: "veh-icon",
    html: `<div class="veh ${cls}" style="--c:${c};--fg:${textColorFor(c)}">${esc(t.line)}<i class="dot ${status}"></i></div>`,
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
    if (!vehicleVisible(t)) continue;
    seen.add(t.id);
    const status = delayStatus(t, pos.delay);
    let m = markers.get(t.id);
    if (!m) {
      m = L.marker([pos.lat, pos.lon], { icon: iconFor(t, status), keyboard: false });
      m._status = status;
      m.on("click", () => openTrip(t.id, m));
      m.addTo(vehicleLayer);
      markers.set(t.id, m);
    } else {
      m.setLatLng([pos.lat, pos.lon]);
      if (m._status !== status) { m.setIcon(iconFor(t, status)); m._status = status; }
    }
    m._trip = t;
    m._pos = pos;
  }
  for (const [id, m] of markers) if (!seen.has(id)) { vehicleLayer.removeLayer(m); markers.delete(id); }
  if (openTripId && markers.has(openTripId)) renderTripPopup(markers.get(openTripId));
  renderStats(stats);
}

function renderStats(s) {
  document.getElementById("kpi-total").textContent = s.total;
  document.getElementById("kpi-split").textContent = `${s.byProduct.Bus} bus · ${s.byProduct.Tram} tram · ${s.byProduct.UBahn} U-Bahn`;
  document.getElementById("kpi-ontime").textContent = s.rt ? `${Math.round((100 * s.ontime) / s.rt)} %` : "–";
  document.getElementById("kpi-delay").textContent = s.rt ? `${(s.delaySum / s.rt / 60).toFixed(1)} min` : "–";
  document.getElementById("kpi-late").textContent = s.rt ? s.late : "–";
  const worst = Object.values(s.lines).filter((l) => l.n >= 2)
    .map((l) => ({ ...l, avg: l.sum / l.n })).sort((a, b) => b.avg - a.avg).slice(0, 6);
  document.getElementById("worst-lines").innerHTML = worst.map((l) =>
    `<li data-line="${esc(l.line)}"><b>${l.product === "UBahn" ? "" : l.product + " "}${esc(l.line)}</b> · Ø ${fmtDelay(l.avg)} <span class="muted">(${l.n} vehicles)</span></li>`).join("");
}
document.getElementById("worst-lines").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) setLine(li.dataset.line);
});

function openTrip(id, m) {
  openTripId = id;
  tripLayer.clearLayers();
  const t = m._trip;
  L.polyline(tripPath(t), { color: colorOf(t), weight: 4, opacity: 0.6, dashArray: "6 6", pane: "trip" }).addTo(tripLayer);
  t.stops.forEach((s, i) => L.circleMarker(stopPoint(t.stops, i), { radius: 3, color: colorOf(t), weight: 2, fillColor: "#fff", fillOpacity: 1, pane: "trip" }).bindTooltip(s.name).addTo(tripLayer));
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
  m.setPopupContent(`<div class="popup"><h3>${t.product === "UBahn" ? "" : t.product + " "}${esc(t.line)} → ${esc(t.direction)}</h3>
    <p class="meta"><i class="dot ${status}"></i> ${label} · vehicle ${esc(t.vehicle ?? "?")}</p>
    <table>${rows.slice(from, from + 8).join("")}</table></div>`);
}
map.on("popupclose", (e) => {
  if (e.popup._source && e.popup._source._trip) { openTripId = null; tripLayer.clearLayers(); }
});

// ---------- controls ----------
function updateLineFilter() {
  const sel = document.getElementById("line-filter");
  const lines = [...new Set(trips.map((t) => `${t.product}|${t.line}`))];
  const key = lines.sort().join(",");
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  const rank = { UBahn: 0, Tram: 1, Bus: 2 };
  lines.sort((a, b) => {
    const [pa, la] = a.split("|"), [pb, lb] = b.split("|");
    return rank[pa] - rank[pb] || la.localeCompare(lb, "de", { numeric: true });
  });
  sel.innerHTML = `<option value="">All lines</option>` + lines.map((k) => {
    const [p, l] = k.split("|");
    return `<option value="${esc(l)}"${l === selectedLine ? " selected" : ""}>${p === "UBahn" ? "" : p + " "}${esc(l)}</option>`;
  }).join("");
}
function setLine(line) {
  selectedLine = selectedLine === line ? "" : line;
  document.getElementById("line-filter").value = selectedLine;
  for (const [l, feats] of Object.entries(lineFeatures)) {
    for (const f of feats) {
      const base = f._baseStyle;
      f.setStyle(selectedLine && l !== selectedLine ? { ...base, opacity: 0.15 }
        : selectedLine ? { ...base, weight: base.weight + 3, opacity: 1, color: base.color === "#b9bec8" ? BUS_COLOR : base.color } : base);
      if (selectedLine === l) f.bringToFront();
    }
  }
  updateLabelVisibility();
  animate();
}
document.getElementById("line-filter").addEventListener("change", (e) => setLine(e.target.value || selectedLine));
document.querySelectorAll("[data-layer]").forEach((cb) => cb.addEventListener("change", () => {
  const k = cb.dataset.layer;
  if (k === "stops") return updateStopsVisibility();
  cb.checked ? layers[k].addTo(map) : map.removeLayer(layers[k]);
  updateLabelVisibility();
}));
document.querySelectorAll("[data-veh]").forEach((cb) => cb.addEventListener("change", animate));

// ---------- boot ----------
(async () => {
  await loadNetwork();
  loadStops();
  await pollVehicles();
  setInterval(pollVehicles, VEHICLE_POLL_MS);
  setInterval(animate, ANIMATE_MS);
})();
