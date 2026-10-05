// Network diagnosis: heatmaps of problem types plus a supply-vs-demand grid.

const { esc } = NetMap;
const LAYER_ORDER = ["supply_demand", "delay_buildup", "bunching", "service_gaps", "pt_vs_car", "parallel_rail"];
const SUPPLY_DEMAND = {
  title: "Over- / under-supply",
  question: "Where are places offered out of proportion to the residents who live there? (300 m cells)",
  lever: "Take bus trips from over-supplied (blue) corridors, especially where rail already serves, and spend the drivers on red areas",
  source: "timetable + Zensus 2022",
};
// sequential ramp for heatmaps (one hue family, light -> dark)
const HEAT_STOPS = [[0.15, "#fde4c8"], [0.4, "#f6a35c"], [0.65, "#e4682b"], [0.85, "#b83a17"], [1, "#7a1f0b"]];
const HEAT_GRADIENT = Object.fromEntries(HEAT_STOPS);
// diverging: red = less supply per resident than typical, grey = typical, blue = more
const DIV = [[-2, "#b42b2b"], [-1, "#e07b7b"], [-0.4, "#f3c1c1"], [0.4, "#e9e8e3"], [1, "#bcd6f5"], [2, "#6da7ec"], [Infinity, "#1c5cab"]];
const UNSERVED = "#5e1515";

const map = L.map("map", { preferCanvas: true, zoomControl: false }).setView([49.4521, 11.0767], 12);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, className: "tiles-grey",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · VGN GTFS (CC BY 3.0 DE) · Zensus 2022 © Destatis (dl-de/by-2-0)',
}).addTo(map);
map.createPane("grid").style.zIndex = 330;
const canvas = L.canvas({ pane: "grid" });
const dataLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);

const net = NetMap.create(map, { initialLayers: { "net-Regio": false } });
function fadeNetwork() {
  for (const ls of Object.values(net.lineFeatures)) for (const l of ls) l.setStyle({ ...l._baseStyle, opacity: 0.3, weight: Math.max(1.5, l._baseStyle.weight - 1) });
  net.setLabelFilter(() => false);
}

let meta = {}, current = null, cache = {};

function renderLayerList() {
  const box = document.getElementById("layer-list");
  box.innerHTML = LAYER_ORDER.map((k) => {
    const m = k === "supply_demand" ? SUPPLY_DEMAND : meta[k];
    return `<button data-key="${k}"><span>${esc(m.title)}</span><span class="src">${esc(m.source)}</span></button>`;
  }).join("");
  box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => select(b.dataset.key)));
}

async function fetchLayer(key) {
  const busOnly = document.getElementById("bus-only").checked;
  const ck = `${key}:${busOnly}`;
  if (!cache[ck]) {
    const url = key === "supply_demand" ? "/api/diagnose/supply_demand" : `/api/diagnose/${key}?bus_only=${busOnly}`;
    cache[ck] = (await fetch(url)).json();
  }
  return cache[ck];
}

async function select(key) {
  current = key;
  document.querySelectorAll("#layer-list button").forEach((b) => b.classList.toggle("active", b.dataset.key === key));
  const m = key === "supply_demand" ? SUPPLY_DEMAND : meta[key];
  document.getElementById("info-title").textContent = m.title;
  document.getElementById("info-question").textContent = m.question;
  document.getElementById("info-lever").textContent = m.lever;
  document.getElementById("info-source").textContent = "Loading…";
  document.getElementById("bus-only-row").classList.toggle("hidden", m.source !== "observed");
  document.getElementById("sd-mode").classList.toggle("hidden", key !== "supply_demand");
  dataLayer.clearLayers();
  markerLayer.clearLayers();
  document.getElementById("top-list").innerHTML = '<li class="loading">computing… (first time can take ~30 s)</li>';
  document.getElementById("line-list").innerHTML = "";
  document.getElementById("summary").innerHTML = "";
  const data = await fetchLayer(key);
  if (current !== key) return;
  key === "supply_demand" ? renderSupplyDemand(data) : renderHeat(data);
}

// ---------- heat layers ----------
function renderHeat(d) {
  document.getElementById("info-source").textContent = `${d.source} · ${d.period}`;
  L.heatLayer(d.points, { radius: 20, blur: 16, maxZoom: 14, max: 1, minOpacity: 0.25, gradient: HEAT_GRADIENT }).addTo(dataLayer);
  const fmtVal = (v) => (d.key === "pt_vs_car" ? `${v.toFixed(2)}×` : d.key === "service_gaps" ? `${v.toFixed(0)} min` : Math.round(v).toLocaleString("en"));
  document.getElementById("legend").innerHTML = `
    <div class="ramp" style="background:linear-gradient(90deg, ${HEAT_STOPS.map((x) => x[1]).join(",")})"></div>
    <div class="ramp-labels"><span>${fmtVal(d.scale[0])}</span><span>${esc(d.unit)}</span><span>≥ ${fmtVal(d.scale[1])}</span></div>`;
  document.getElementById("top-title").textContent = "Top problem spots";
  const ol = document.getElementById("top-list");
  ol.innerHTML = d.top.map((it, i) => `<li data-i="${i}"><span class="val">${fmtVal(it.value)}</span><b>${esc(it.label)}</b>
    <span class="sub">${esc(it.detail)}${it.lines.length ? " · " + esc(it.lines.slice(0, 6).join(", ")) : ""}</span></li>`).join("");
  d.top.forEach((it, i) => {
    const m = L.circleMarker([it.lat, it.lon], { radius: 9, color: "#0b0b0b", weight: 1.5, fillColor: "#fff", fillOpacity: 0.9 })
      .bindTooltip(`${i + 1}`, { permanent: true, direction: "center", className: "rank-label" })
      .bindPopup(`<div class="popup"><h3>${i + 1}. ${esc(it.label)}</h3><p class="meta">${esc(it.detail)}</p>${it.lines.length ? `<p>${esc(it.lines.join(", "))}</p>` : ""}</div>`);
    markerLayer.addLayer(m);
  });
  ol.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
    const it = d.top[+li.dataset.i];
    map.flyTo([it.lat, it.lon], 15);
    markerLayer.getLayers()[+li.dataset.i].openPopup();
  }));
  renderLines(d.by_line, d.unit, "Lines most affected");
  document.getElementById("summary").innerHTML = `<div class="tile"><span class="label">Locations</span><span class="value">${d.count.toLocaleString("en")}</span></div>`;
}

function renderLines(rows, unit, title) {
  document.getElementById("lines-title").textContent = title;
  if (!rows?.length) { document.getElementById("line-list").innerHTML = '<li class="muted">–</li>'; return; }
  const max = Math.max(...rows.map((r) => r.value ?? r.share));
  document.getElementById("line-list").innerHTML = rows.map((r) => {
    const v = r.value ?? r.share;
    const txt = r.share !== undefined ? `${Math.round(r.share * 100)} % of its places` : `${Math.round(v).toLocaleString("en")} ${esc(unit)}`;
    return `<li><b>${esc(r.line)}</b> · ${txt}<span class="bar" style="width:${(60 * v) / max}px"></span></li>`;
  }).join("");
}

// ---------- supply vs demand grid ----------
const CLASS_LABEL = { unserved: "Not served (no stop / almost no service)", under: "Under-supplied", balanced: "Typical", over: "Over-supplied", destination: "Few residents (destination area)" };
function divColor(v) { for (const [t, c] of DIV) if (v <= t) return c; return DIV.at(-1)[1]; }

function renderSupplyDemand(d) {
  const mode = document.querySelector('input[name="sdmode"]:checked').value;
  document.getElementById("info-source").textContent = `${d.source} · ${d.assumptions}`;
  dataLayer.clearLayers();
  const cols = Object.fromEntries(d.columns.map((c, i) => [c, i]));
  const maxBus = Math.max(...d.grid.filter((g) => g[cols.rail_covered]).map((g) => g[cols.bus_places]), 1);
  for (const g of d.grid) {
    const cls = g[cols.class], idx = g[cols.index], bus = g[cols.bus_places], rail = g[cols.rail_places];
    let style;
    if (mode === "index") {
      style = cls === "destination" ? { color: "#9a9994", weight: 0.5, fillColor: "#ffffff", fillOpacity: 0.05, dashArray: "2 3" }
        : cls === "unserved" ? { color: UNSERVED, weight: 0.5, fillColor: UNSERVED, fillOpacity: 0.7 }
        : { color: "#ffffff", weight: 0.5, fillColor: divColor(idx), fillOpacity: 0.65 };
    } else {
      if (!g[cols.rail_covered] || !bus) continue;
      const t = Math.log1p(bus) / Math.log1p(maxBus);
      style = { color: "#ffffff", weight: 0.5, fillColor: t > 0.85 ? "#104281" : t > 0.7 ? "#1c5cab" : t > 0.55 ? "#3987e5" : "#9ec5f4", fillOpacity: 0.7 };
    }
    const r = L.rectangle([[g[0], g[1]], [g[2], g[3]]], { ...style, renderer: canvas });
    const ratio = 2 ** idx;
    r.bindTooltip(`<b>${CLASS_LABEL[cls]}</b><br>${g[cols.residents].toLocaleString("en")} residents<br>
      Places/day in reach: bus ${bus.toLocaleString("en")} · rail ${rail.toLocaleString("en")}<br>
      ${cls === "destination" || cls === "unserved" ? "" : `${ratio >= 1 ? ratio.toFixed(1) + "× more" : (1 / ratio).toFixed(1) + "× less"} supply per resident than typical`}
      ${g[cols.rail_covered] ? "<br>Rail already serves this cell" : ""}`, { sticky: true });
    dataLayer.addLayer(r);
  }
  document.getElementById("legend").innerHTML = mode === "index" ? `
    <div class="ramp" style="background:linear-gradient(90deg, ${DIV.map((x) => x[1]).join(",")})"></div>
    <div class="ramp-labels"><span>4× less</span><span>typical (${d.summary.median_places_per_resident} places/resident)</span><span>4× more</span></div>
    <div class="cat-legend"><span><i style="background:${UNSERVED}"></i>Not served</span><span><i style="background:#fff;border:1px dashed #9a9994"></i>Few residents</span></div>`
    : `<div class="ramp" style="background:linear-gradient(90deg,#9ec5f4,#3987e5,#1c5cab,#104281)"></div>
       <div class="ramp-labels"><span>few bus places</span><span>many bus places where rail serves</span></div>`;
  const s = d.summary, pct = (x) => `${Math.round((100 * x) / s.residents)} %`;
  document.getElementById("summary").innerHTML = `
    <div class="tile"><span class="label">Not served</span><span class="value">${s.residents_unserved.toLocaleString("en")}</span><span class="sub">residents (${pct(s.residents_unserved)})</span></div>
    <div class="tile"><span class="label">Under-supplied</span><span class="value">${s.residents_under.toLocaleString("en")}</span><span class="sub">residents (${pct(s.residents_under)})</span></div>
    <div class="tile"><span class="label">Over-supplied</span><span class="value">${s.residents_over.toLocaleString("en")}</span><span class="sub">residents (${pct(s.residents_over)})</span></div>
    <div class="tile"><span class="label">Bus places where rail serves</span><span class="value">${Math.round(s.bus_places_in_rail_covered * 100)} %</span><span class="sub">of all VAG bus places</span></div>`;
  document.getElementById("top-title").textContent = "Largest under-served areas";
  const ol = document.getElementById("top-list");
  ol.innerHTML = d.unserved_clusters.map((c, i) => `<li data-i="${i}"><span class="val">${c.residents.toLocaleString("en")}</span><b>Area ${i + 1}</b>
    <span class="sub">${c.places_per_resident} places/resident · nearest stop ${c.nearest_stop_m} m · bus lines: ${esc(c.bus_lines.join(", ") || "none")}</span></li>`).join("");
  markerLayer.clearLayers();
  d.unserved_clusters.forEach((c, i) => markerLayer.addLayer(L.circleMarker([c.lat, c.lon], { radius: 9, color: "#0b0b0b", weight: 1.5, fillColor: "#fff", fillOpacity: 0.9 })
    .bindTooltip(`${i + 1}`, { permanent: true, direction: "center", className: "rank-label" })));
  ol.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => { const c = d.unserved_clusters[+li.dataset.i]; map.flyTo([c.lat, c.lon], 15); }));
  renderLines(d.redundant_lines, "", "Bus lines mostly where rail already serves");
}
document.querySelectorAll('input[name="sdmode"]').forEach((r) => r.addEventListener("change", () => select("supply_demand")));
document.getElementById("bus-only").addEventListener("change", () => select(current));
document.getElementById("show-network").addEventListener("change", (e) => {
  for (const k of ["net-UBahn", "net-Tram", "net-Bus"]) net.setLayer(k, e.target.checked);
  if (e.target.checked) fadeNetwork();
});
document.getElementById("show-live").addEventListener("change", (e) => net.setVehiclesVisible(e.target.checked));

(async () => {
  meta = await (await fetch("/api/diagnose")).json();
  renderLayerList();
  select("supply_demand");
  await net.start();
  net.setVehiclesVisible(false);
  fadeNetwork();
})();
