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

const net = NetMap.create(map, { initialLayers: { "net-Regio": false }, onLineClick: (p, l) => highlight(new Set([`${p}:${l}`])) });

// ---------- line highlighting ----------
let highlighted = null; // Set of "Product:Line" or null
const lineKey = (label) => { const [p, ...rest] = label.split(" "); return `${p}:${rest.join(" ")}`; };
function highlight(keys) {
  highlighted = keys && keys.size ? keys : null;
  const fade = document.getElementById("fade-lines").checked;
  for (const [key, ls] of Object.entries(net.lineFeatures)) {
    const on = highlighted?.has(key);
    for (const l of ls) {
      const b = l._baseStyle;
      l.setStyle(on ? { ...b, weight: b.weight + 2, opacity: 1 }
        : fade || highlighted ? { ...b, opacity: highlighted ? 0.15 : 0.3, weight: Math.max(1.5, b.weight - 1) } : b);
      if (on) l.bringToFront();
    }
  }
  net.setLabelFilter(highlighted ? (p, l) => highlighted.has(`${p}:${l}`) : fade ? () => false : null);
  document.getElementById("line-filter").value = highlighted?.size === 1 ? [...highlighted][0] : "";
}
function fillLineFilter() {
  const order = { UBahn: 0, Tram: 1, Bus: 2 };
  const keys = Object.keys(net.lineFeatures).sort((a, b) => {
    const [pa, la] = a.split(":"), [pb, lb] = b.split(":");
    return order[pa] - order[pb] || la.localeCompare(lb, "de", { numeric: true });
  });
  document.getElementById("line-filter").insertAdjacentHTML("beforeend",
    keys.map((k) => `<option value="${k}">${esc(NetMap.lineLabel(...k.split(":")))}</option>`).join(""));
}
document.getElementById("line-filter").addEventListener("change", (e) => highlight(e.target.value ? new Set([e.target.value]) : null));
document.getElementById("fade-lines").addEventListener("change", () => highlight(highlighted));

let meta = {}, current = null, cache = {};
let topExpanded = false;
const TOP_N = 5;
// collapse long lists to the first TOP_N entries
function limitTop() {
  const items = [...document.querySelectorAll("#top-list li")];
  items.forEach((li, i) => li.classList.toggle("hidden", !topExpanded && i >= TOP_N));
  const btn = document.getElementById("top-more");
  btn.classList.toggle("hidden", items.length <= TOP_N);
  btn.textContent = topExpanded ? "Show fewer" : `Show ${items.length - TOP_N} more`;
}
document.getElementById("top-more").addEventListener("click", () => { topExpanded = !topExpanded; limitTop(); });

function renderLayerList() {
  const box = document.getElementById("layer-list");
  box.innerHTML = LAYER_ORDER.map((k) => {
    const m = k === "supply_demand" ? SUPPLY_DEMAND : meta[k];
    return `<button data-key="${k}">${esc(m.title)}</button>`;
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
  document.getElementById("info-question").textContent = m.question;
  document.getElementById("info-source").textContent = "Loading…";
  document.getElementById("bus-only-row").classList.toggle("hidden", m.source !== "observed");
  topExpanded = false;
  document.getElementById("sd-mode").classList.toggle("hidden", key !== "supply_demand");
  dataLayer.clearLayers();
  markerLayer.clearLayers();
  closeSpot();
  document.getElementById("top-list").innerHTML = '<li class="loading">computing… (first time can take ~30 s)</li>';
  document.getElementById("line-list").innerHTML = "";
  document.getElementById("summary").innerHTML = "";
  const data = await fetchLayer(key);
  if (current !== key) return;
  key === "supply_demand" ? renderSupplyDemand(data) : renderHeat(data);
}

// ---------- problem spots ----------
// Every layer is turned into the same spot shape so the sidebar and suggestions work alike:
// { label, detail, valueText, lat, lon, lines: ["Bus 36", ...], station?, extra }
let spots = [];
function renderSpots(title) {
  document.getElementById("top-title").textContent = title;
  const ol = document.getElementById("top-list");
  ol.innerHTML = spots.map((sp, i) => `<li data-i="${i}"><span class="val">${esc(sp.valueText)}</span><b>${esc(sp.label)}</b>
    <span class="sub">${esc(sp.detail)}</span></li>`).join("");
  ol.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => selectSpot(spots[+li.dataset.i])));
  markerLayer.clearLayers();
  spots.slice(0, TOP_N).forEach((sp, i) => {
    const m = L.circleMarker([sp.lat, sp.lon], { radius: 10, color: "#0b0b0b", weight: 1.5, fillColor: "#fff", fillOpacity: 0.95 })
      .bindTooltip(`${i + 1}`, { permanent: true, direction: "center", className: "rank-label" });
    m.on("click", () => selectSpot(sp));
    markerLayer.addLayer(m);
  });
  limitTop();
}

function renderHeat(d) {
  document.getElementById("info-source").textContent = `${d.source} · ${d.period}`;
  L.heatLayer(d.points, { radius: 20, blur: 16, maxZoom: 14, max: 1, minOpacity: 0.25, gradient: HEAT_GRADIENT }).addTo(dataLayer);
  const fmtVal = (v) => (d.key === "pt_vs_car" ? `${v.toFixed(2)}×` : d.key === "service_gaps" ? `${v.toFixed(0)} min` : Math.round(v).toLocaleString("en"));
  document.getElementById("legend").innerHTML = `
    <div class="ramp" style="background:linear-gradient(90deg, ${HEAT_STOPS.map((x) => x[1]).join(",")})"></div>
    <div class="ramp-labels"><span>${fmtVal(d.scale[0])}</span><span>${esc(d.unit)}</span><span>≥ ${fmtVal(d.scale[1])}</span></div>`;
  spots = d.top.map((it) => ({ ...it, kind: d.key, valueText: fmtVal(it.value) }));
  renderSpots("Problem spots");
  renderLines(d.by_line, d.unit, "Lines most affected");
}

function renderLines(rows, unit, title) {
  document.getElementById("lines-title").textContent = title;
  if (!rows?.length) { document.getElementById("line-list").innerHTML = '<li class="muted">–</li>'; return; }
  const max = Math.max(...rows.map((r) => r.value ?? r.share));
  const ol = document.getElementById("line-list");
  ol.innerHTML = rows.slice(0, 5).map((r, i) => {
    const v = r.value ?? r.share;
    const txt = r.share !== undefined ? `${Math.round(r.share * 100)} % of its places` : `${Math.round(v).toLocaleString("en")} ${esc(unit)}`;
    return `<li data-i="${i}"><b>${esc(r.line)}</b> · ${txt}<span class="bar" style="width:${(60 * v) / max}px"></span></li>`;
  }).join("");
  // a line is a spot too: select it to see the line and what to do with it
  ol.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
    const r = rows[+li.dataset.i];
    selectLineSpot(r, title);
  }));
}

function selectLineSpot(r, context) {
  const key = lineKey(r.line);
  const feats = net.lineFeatures[key] || [];
  const b = feats.length ? L.featureGroup(feats).getBounds() : null;
  const c = b?.isValid() ? b.getCenter() : map.getCenter();
  selectSpot({ label: r.line, detail: context, valueText: "", lat: c.lat, lon: c.lng, lines: [r.line], kind: current === "supply_demand" ? "redundant_line" : `${current}_line`, extra: r, bounds: b });
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
        : cls === "unserved" ? { color: UNSERVED, weight: 0.5, fillColor: UNSERVED, fillOpacity: 0.6 }
        : { color: "#ffffff", weight: 0.5, fillColor: divColor(idx), fillOpacity: 0.55 };
    } else {
      if (!g[cols.rail_covered] || !bus) continue;
      const t = Math.log1p(bus) / Math.log1p(maxBus);
      style = { color: "#ffffff", weight: 0.5, fillColor: t > 0.85 ? "#104281" : t > 0.7 ? "#1c5cab" : t > 0.55 ? "#3987e5" : "#9ec5f4", fillOpacity: 0.6 };
    }
    const r = L.rectangle([[g[0], g[1]], [g[2], g[3]]], { ...style, renderer: canvas, interactive: true });
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
    <div class="tile"><span class="label">Residents under-supplied or not served</span><span class="value">${pct(s.residents_unserved + s.residents_under)}</span><span class="sub">${(s.residents_unserved + s.residents_under).toLocaleString("en")} people</span></div>
    <div class="tile"><span class="label">VAG bus places where rail already serves</span><span class="value">${Math.round(s.bus_places_in_rail_covered * 100)} %</span><span class="sub">candidates to redistribute</span></div>`;
  spots = d.unserved_clusters.map((c, i) => ({
    label: `Under-served area ${i + 1}`, kind: "under_served", lat: c.lat, lon: c.lon, lines: c.lines,
    valueText: `${c.residents.toLocaleString("en")} residents`,
    detail: `${c.places_per_resident} places/resident · nearest stop ${c.nearest_stop_m} m · bus: ${c.bus_lines.join(", ") || "none"}`, extra: c,
  }));
  renderSpots("Largest under-served areas");
  renderLines(d.redundant_lines, "", "Bus lines mostly where rail already serves");
}
document.querySelectorAll('input[name="sdmode"]').forEach((r) => r.addEventListener("change", () => select("supply_demand")));
document.getElementById("bus-only").addEventListener("change", () => select(current));

// ---------- selected spot + suggestions ----------
let plannerMeta = null;
async function getPlannerMeta() {
  plannerMeta ||= await (await fetch("/api/planner/meta")).json();
  return plannerMeta;
}
function nearestStation(lat, lon, ids = null) {
  let best = null, bd = Infinity;
  for (const s of plannerMeta.stations) {
    if (ids && !ids.has(s.id)) continue;
    const d = Math.hypot((s.lat - lat) * 111.3, (s.lon - lon) * 72.4);
    if (d < bd) { bd = d; best = s; }
  }
  return best && { ...best, km: bd };
}
const short = (n) => n.replace(/^(Nürnberg|Fürth) /, "");
// regular bus lines only: E = rail replacement, N = night buses
const busLines = (sp) => sp.lines.filter((l) => /^Bus [^EN]/.test(l));

// Rule-based suggestions. Each one may carry a planner feature; its driver effect is computed by the server.
function suggestionsFor(sp) {
  const out = [];
  const ref = lineKey;
  const bus = busLines(sp);
  const uStations = new Set(plannerMeta.lines.filter((l) => l.product === "UBahn").flatMap((l) => l.stations.map((s) => s.id)));
  const feeder = () => {
    const from = sp.station ? plannerMeta.stations.find((s) => s.id === sp.station) : nearestStation(sp.lat, sp.lon);
    const hub = from && nearestStation(from.lat, from.lon, new Set([...uStations].filter((id) => id !== from.id)));
    if (!from || !hub || hub.km < 1) return;
    out.push({
      title: `Express feeder ${short(from.name)} → ${short(hub.name)} (U-Bahn), every 15 min`,
      why: `Direct link to the nearest U-Bahn (${hub.km.toFixed(1)} km) instead of a slow local route.`,
      feature: { type: "add_express", name: `X-${short(from.name).slice(0, 6)}`, stations: [from.id, hub.id], headway_min: 15, from_h: 6, to_h: 20, days: "weekday" },
    });
  };
  switch (sp.kind) {
    case "delay_buildup":
      bus.slice(0, 2).forEach((l) => out.push({
        title: `Bus lane / signal priority for ${l}`, why: `Vehicles lose time on ${sp.label} (${sp.detail}). Faster running can save a vehicle.`,
        feature: { type: "speedup", line: ref(l), pct: 10 },
      }));
      break;
    case "bunching":
      if (bus.length >= 2) out.push({ title: `Interleave ${bus[0]} and ${bus[1]}`, why: "Shift one timetable so the two lines don't run right behind each other.", feature: { type: "debunch", line_a: ref(bus[0]), line_b: ref(bus[1]) } });
      bus.slice(0, 1).forEach((l) => out.push({ title: `More recovery time / headway control for ${l}`, why: "Bunching usually starts with a late bus picking up everyone. Longer turnaround buffers or headway-based dispatching help. (Operational, not in the planner.)" }));
      break;
    case "service_gaps":
    case "under_served":
      bus.slice(0, 2).forEach((l) => out.push({ title: `More trips on ${l} (06–20 h, double frequency)`, why: "Shorter waits for the people living here. Costs drivers, so pair it with a saving elsewhere.", feature: { type: "densify_line", line: ref(l), from_h: 6, to_h: 20 } }));
      if (!bus.length) feeder();
      break;
    case "pt_vs_car":
      feeder();
      bus.slice(0, 1).forEach((l) => out.push({ title: `More trips on ${l} (06–20 h)`, why: "Shorter waits make the trip faster from here.", feature: { type: "densify_line", line: ref(l), from_h: 6, to_h: 20 } }));
      break;
    case "parallel_rail":
      bus.slice(0, 2).forEach((l) => out.push({ title: `Thin ${l} to every 2nd trip 06–20 h`, why: `Rail (${(sp.parallel_to || []).join(", ")}) runs on the same section. Frees drivers for under-served areas.`, feature: { type: "thin_line", line: ref(l), from_h: 6, to_h: 20, keep_every: 2 } }));
      break;
    case "redundant_line":
    case "parallel_rail_line":
      out.push({ title: `Thin ${sp.label} to every 2nd trip 06–20 h`, why: `${sp.extra?.share ? Math.round(sp.extra.share * 100) + " % of its places are" : "Much of it runs"} where rail already serves.`, feature: { type: "thin_line", line: ref(sp.label), from_h: 6, to_h: 20, keep_every: 2 } });
      out.push({ title: `Remove ${sp.label}`, why: "The radical option. Check the evaluation for who loses a direct connection.", feature: { type: "remove_line", line: ref(sp.label) } });
      break;
    default:
      if (sp.label.startsWith("Bus ")) out.push({ title: `Bus lane / signal priority for ${sp.label}`, why: sp.detail, feature: { type: "speedup", line: ref(sp.label), pct: 10 } });
  }
  return out;
}

async function selectSpot(sp) {
  await getPlannerMeta();
  document.getElementById("spot").classList.remove("hidden");
  document.getElementById("spots-section").classList.add("hidden");
  document.getElementById("spot-title").textContent = sp.label + (sp.valueText ? ` · ${sp.valueText}` : "");
  document.getElementById("spot-detail").textContent = sp.detail;
  document.getElementById("spot-lines").innerHTML = sp.lines.length
    ? sp.lines.map((l) => { const [p, ...r] = l.split(" "); const c = net.colorOf(p, r.join(" ")); return `<button class="chip-line ${p.toLowerCase()}" data-key="${lineKey(l)}" style="--c:${c};--fg:${NetMap.textColorFor(c)}">${esc(r.join(" "))}</button>`; }).join("")
    : '<span class="muted small">No VAG line serves this spot.</span>';
  document.querySelectorAll("#spot-lines button").forEach((b) => b.addEventListener("click", () => highlight(new Set([b.dataset.key]))));
  highlight(new Set(sp.lines.map(lineKey)));
  if (sp.bounds?.isValid()) map.flyToBounds(sp.bounds, { padding: [30, 30] });
  else map.flyTo([sp.lat, sp.lon], 15);

  const ul = document.getElementById("spot-suggestions");
  const sugg = suggestionsFor(sp);
  ul.innerHTML = sugg.length ? sugg.map((s, i) => `<li>
      <b>${esc(s.title)}</b><span class="why">${esc(s.why)}</span>
      ${s.feature ? `<span class="effect" id="eff-${i}"><span class="chip">estimating drivers…</span></span><button class="primary small" data-i="${i}">Add to plan</button>` : ""}
    </li>`).join("") : '<li class="muted">No automatic suggestion for this spot.</li>';
  ul.querySelectorAll("button[data-i]").forEach((b) => b.addEventListener("click", () => {
    queueFeature({ ...sugg[+b.dataset.i].feature, title: sugg[+b.dataset.i].title });
    b.textContent = "✓ Added"; b.disabled = true;
  }));
  sugg.forEach(async (s, i) => {
    if (!s.feature) return;
    const res = await fetch("/api/planner/inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ features: [s.feature] }) });
    const step = (await res.json()).steps?.[0]?.Bus;
    const el = document.getElementById(`eff-${i}`);
    if (!el || !step) return;
    const peak = step.peak, h = Math.round(step.hours);
    el.innerHTML = peak > 0 ? `<span class="chip gain">+${peak} drivers free</span>` : peak < 0 ? `<span class="chip cost">needs ${-peak} drivers</span>` : `<span class="chip">± 0 drivers at peak</span>`;
    if (h) el.innerHTML += `<span class="chip ${h > 0 ? "gain" : "cost"}">${h > 0 ? "+" : ""}${h} h/day</span>`;
  });
}
function closeSpot() {
  document.getElementById("spot").classList.add("hidden");
  document.getElementById("spots-section").classList.remove("hidden");
  highlight(null);
}
document.getElementById("spot-close").addEventListener("click", closeSpot);

// suggestions are handed to the planner through localStorage
function queueFeature(f) {
  const q = JSON.parse(localStorage.getItem("planner.pending") || "[]");
  q.push(f);
  localStorage.setItem("planner.pending", JSON.stringify(q));
  updateQueued();
}
function updateQueued() {
  const n = JSON.parse(localStorage.getItem("planner.pending") || "[]").length;
  const el = document.getElementById("queued");
  el.textContent = n ? `+${n}` : "";
  el.classList.toggle("hidden", !n);
}

// ---------- map controls ----------
document.querySelectorAll("[data-layer]").forEach((cb) => cb.addEventListener("change", () => net.setLayer(cb.dataset.layer, cb.checked)));
document.getElementById("show-stops").addEventListener("change", (e) => net.setStopsVisible(e.target.checked));
document.getElementById("show-live").addEventListener("change", (e) => net.setVehiclesVisible(e.target.checked));
document.getElementById("show-problems").addEventListener("change", (e) => {
  for (const lg of [dataLayer, markerLayer]) e.target.checked ? lg.addTo(map) : map.removeLayer(lg);
});

(async () => {
  updateQueued();
  meta = await (await fetch("/api/diagnose")).json();
  renderLayerList();
  select("supply_demand");
  await net.start();
  net.setVehiclesVisible(false);
  net.loadStops(true);
  fillLineFilter();
  highlight(null);
})();
