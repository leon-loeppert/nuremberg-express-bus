// Network diagnosis: heatmaps of problem types plus a supply-vs-demand grid.

const { esc } = NetMap;
const LAYER_ORDER = ["proposals", "supply_demand", "delay_buildup", "bunching", "service_gaps", "pt_vs_car", "parallel_rail"];
const SUPPLY_DEMAND = {
  title: "Over- / under-supply",
  question: "Where are places offered out of proportion to the residents who live there? (300 m cells)",
  lever: "Take bus trips from over-supplied (blue) corridors, especially where rail already serves, and spend the drivers on red areas",
  source: "timetable + Zensus 2022",
};
const PROPOSALS = {
  title: "★ Express check",
  question: "Concrete changes for the whole network: where to take drivers from, and where to spend them.",
  source: "model",
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
    const m = k === "supply_demand" ? SUPPLY_DEMAND : k === "proposals" ? PROPOSALS : meta[k];
    return `<button data-key="${k}" class="${k === "proposals" ? "star" : ""}">${esc(m.title)}</button>`;
  }).join("");
  box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => select(b.dataset.key)));
}

async function fetchLayer(key) {
  const busOnly = document.getElementById("bus-only").checked;
  const ck = `${key}:${busOnly}`;
  if (!cache[ck]) {
    const url = key === "supply_demand" ? "/api/diagnose/supply_demand" : key === "proposals" ? "/api/proposals" : `/api/diagnose/${key}?bus_only=${busOnly}`;
    cache[ck] = (await fetch(url)).json();
  }
  return cache[ck];
}

async function select(key) {
  current = key;
  document.querySelectorAll("#layer-list button").forEach((b) => b.classList.toggle("active", b.dataset.key === key));
  const m = key === "supply_demand" ? SUPPLY_DEMAND : key === "proposals" ? PROPOSALS : meta[key];
  document.getElementById("info-question").textContent = m.question;
  document.getElementById("info-source").textContent = "Loading…";
  document.getElementById("bus-only-row").classList.toggle("hidden", m.source !== "observed");
  topExpanded = false;
  document.getElementById("sd-mode").classList.toggle("hidden", key !== "supply_demand");
  dataLayer.clearLayers();
  markerLayer.clearLayers();
  closeSpot();
  document.getElementById("legend").innerHTML = "";
  document.getElementById("top-list").innerHTML = '<li class="loading">computing… (first time can take ~30 s)</li>';
  document.getElementById("line-list").innerHTML = "";
  document.getElementById("summary").innerHTML = "";
  const data = await fetchLayer(key);
  if (current !== key) return;
  document.getElementById("proposals").classList.toggle("hidden", key !== "proposals");
  document.getElementById("verdict").classList.toggle("hidden", key !== "proposals");
  document.getElementById("spots-section").classList.toggle("hidden", key === "proposals");
  if (key === "proposals") renderProposals(data);
  else key === "supply_demand" ? renderSupplyDemand(data) : renderHeat(data);
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
    case "region":
      for (const x of proposals.express.filter((e) => e.coords.some(([la, lo]) => Math.hypot((la - sp.lat) * 111.3, (lo - sp.lon) * 72.4) < 2))) {
        out.push({ title: `Express ${x.title}`, why: `Stops within 2 km of this region; ${(100 * x.share_faster).toFixed(1)} % of all trips get faster by ${x.avg_saving_min} min.`, feature: x.feature });
      }
      bus.slice(0, 2).forEach((l) => out.push({ title: `More trips on ${l} (06–20 h, double frequency)`, why: `${l} serves the most residents of this region.`, feature: { type: "densify_line", line: ref(l), from_h: 6, to_h: 20 } }));
      if (!out.length) feeder();
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
  document.getElementById("proposals").classList.add("hidden");
  regionLayer.clearLayers();
  if (sp.boxes) for (const b of sp.boxes) L.rectangle([[b[0], b[1]], [b[2], b[3]]], { color: "#b42b2b", weight: 1, fillColor: "#e07b7b", fillOpacity: 0.35, renderer: canvas, interactive: false }).addTo(regionLayer);
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
  document.getElementById(current === "proposals" ? "proposals" : "spots-section").classList.remove("hidden");
  regionLayer.clearLayers();
  highlight(current === "proposals" && proposals ? new Set(proposals.cuts.map((c) => lineKey(c.line))) : null);
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
  select("proposals");
  await net.start();
  net.setVehiclesVisible(false);
  net.loadStops(true);
  fillLineFilter();
  highlight(null);
})();

// ---------- proposals ----------
let proposals = null;
const regionLayer = L.layerGroup().addTo(map);
const fmtDrivers = (n) => (n > 0 ? `<span class="chip gain">+${n} drivers free</span>` : n < 0 ? `<span class="chip cost">needs ${-n} drivers</span>` : '<span class="chip">± 0 drivers</span>');

function drawExpress(x, strong) {
  const line = L.polyline(x.path || x.coords, { color: "#4a3aa7", weight: strong ? 7 : 5, opacity: strong ? 1 : 0.8, dashArray: strong ? null : "8 6" }).addTo(dataLayer);
  x.coords.forEach((c, i) => L.circleMarker(c, { radius: 5, color: "#4a3aa7", weight: 3, fillColor: "#fff", fillOpacity: 1 })
    .bindTooltip(x.stop_names[i]).addTo(dataLayer));
  L.marker(x.coords[0], { icon: L.divIcon({ className: "", html: `<div class="express-tag">${esc(x.name)}</div>`, iconSize: null, iconAnchor: [-6, 10] }) }).addTo(dataLayer);
  line.on("click", () => focusExpress(x));
  return line;
}
function focusExpress(x) {
  dataLayer.clearLayers();
  renderProposalMap(x.name);
  map.flyToBounds(L.latLngBounds(x.path || x.coords), { padding: [60, 60], maxZoom: 14 });
}
function renderProposalMap(strongName = null) {
  const inPackage = new Set(proposals.package.express.map((x) => x.feature.name));
  for (const x of proposals.express) drawExpress(x, x.name === strongName || (!strongName && inPackage.has(x.name)));
}

function addToPlan(features, btn) {
  features.forEach(queueFeature);
  if (btn) { btn.textContent = "✓ Added"; btn.disabled = true; }
}

const pct = (x, d = 1) => `${(100 * x).toFixed(d)} %`;
function renderVerdict(d) {
  const v = d.verdict, p = d.package;
  const all = [...p.cuts.map((c) => ({ ...c.feature, title: c.title })), ...p.express.map((x) => ({ ...x.feature, title: `Express ${x.title}` }))];
  document.getElementById("verdict").innerHTML = `
    <h3>${v.achieved ? "✓ Yes" : "✗ Not yet"}: ${p.express.length} express line${p.express.length === 1 ? "" : "s"} without hiring</h3>
    <p class="muted small">Goal: faster public transport with the bus drivers we already have.</p>
    <table class="vt">
      <tr><td>Bus drivers at peak</td><td>${v.drivers_before} → <b>${v.drivers_after}</b> ${v.drivers_ok ? '<span class="status good">✓ no new drivers</span>' : '<span class="status critical">▲ over budget</span>'}</td></tr>
      <tr><td>Weekday rush hours</td><td><b>${pct(v.share_faster)}</b> of trips faster by ${v.avg_saving_min} min, ${pct(v.share_slower)} slower by ${v.avg_loss_min} min · <b>≈ ${v.hours_saved_per_day.toLocaleString("en")} h</b> saved per weekday*</td></tr>
      <tr><td>Whole week, all day</td><td>avg. trip ${v.pt_minutes_before.toFixed(2)} → <b>${v.pt_minutes_after.toFixed(2)} min</b> · PT ≤ 1.5× car ${pct(v.competitive_before)} → ${pct(v.competitive_after)} · wait ${v.wait_before.toFixed(1)} → ${v.wait_after.toFixed(1)} min</td></tr>
    </table>
    <button class="primary" id="pkg-add">Open this package in the planner (${all.length} changes)</button>
    <p class="muted tiny">* scaled to ~450,000 VAG trips per weekday; demand estimated from residents and stop activity (no passenger counts).</p>`;
  document.getElementById("pkg-add").addEventListener("click", (e) => { addToPlan(all, e.target); location.href = "/planner"; });

  document.getElementById("package").innerHTML = `
    <h2>The package</h2>
    <ul>${p.express.map((x) => `<li class="plus"><b>+ ${esc(x.title)}</b> ${fmtDrivers(-x.drivers)}<span class="chip gain">≈ ${x.hours_saved_per_day} h/day saved</span></li>`).join("")}
        ${p.cuts.map((c) => `<li class="minus">− ${esc(c.title)} ${fmtDrivers(c.drivers)}${c.hours_lost_per_day ? `<span class="chip cost">≈ ${c.hours_lost_per_day} h/day lost</span>` : ""}</li>`).join("")}</ul>`;
}

function renderProposals(d) {
  proposals = d;
  document.getElementById("info-source").textContent = "Demand: gravity model on 1 km zones (Zensus 2022 residents × stop activity, 4 km distance decay). Express corridors: zone pairs ≥ 4 km where PT is much slower than 1.3× the car, weighted by demand. Express routes follow streets (OSRM) and are timed on that route with rush-hour congestion. Every candidate is costed with the driver model and its effect measured on all zone-to-zone trips at 07:30 and 16:30. Drivers are freed by thinning or removing bus lines where rail already serves, cheapest passenger loss first.";
  renderVerdict(d);
  renderProposalMap();
  highlight(new Set(d.package.cuts.map((c) => lineKey(c.title.split(" ").slice(-2).join(" ")))));

  const ex = document.getElementById("express-list");
  ex.innerHTML = d.express.map((x, i) => `<li data-i="${i}">
      <b>${esc(x.title)}</b>
      <span class="why">${x.km} km on the street · ~${x.run_minutes} min end to end in rush hour · every 15 min, Mon–Fri 06–20 h</span>
      <span class="why">${pct(x.share_faster, 2)} of all trips get faster, by ${x.avg_saving_min} min on average</span>
      <span>${fmtDrivers(-x.drivers)}<span class="chip gain">≈ ${x.hours_saved_per_day} h/day saved</span></span>
      <span class="actions"><button class="primary small" data-add="${i}">Add to plan</button><button class="link" data-show="${i}">Show on map</button></span>
    </li>`).join("") || '<li class="muted">No express line saves enough time.</li>';
  ex.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => addToPlan([{ ...d.express[+b.dataset.add].feature, title: `Express ${d.express[+b.dataset.add].title}` }], b)));
  ex.querySelectorAll("[data-show]").forEach((b) => b.addEventListener("click", () => focusExpress(d.express[+b.dataset.show])));

  const cu = document.getElementById("cut-list");
  cu.innerHTML = d.cuts.map((c, i) => {
    const [prod, ...ln] = c.line.split(" "), col = net.colorOf(prod, ln.join(" "));
    return `<li>
      <span><button class="chip-line bus" style="--c:${col};--fg:${NetMap.textColorFor(col)}" data-line="${i}">${esc(ln.join(" "))}</button> <b>${esc(c.title.replace(` ${c.line}`, ""))}</b></span>
      <span class="why">${Math.round(c.rail_share * 100)} % of its places are where rail already serves · ${c.residents_losing_only_service.toLocaleString("en")} residents have no other stop</span>
      <span>${fmtDrivers(c.drivers)}${c.hours_lost_per_day ? `<span class="chip cost">≈ ${c.hours_lost_per_day} h/day lost</span>` : '<span class="chip">no measurable loss</span>'}</span>
      <span class="actions"><button class="primary small" data-add="${i}">Add to plan</button></span>
    </li>`;
  }).join("");
  cu.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => { const c = d.cuts[+b.dataset.add]; addToPlan([{ ...c.feature, title: c.title }], b); }));
  cu.querySelectorAll("[data-line]").forEach((b) => b.addEventListener("click", () => {
    const key = lineKey(d.cuts[+b.dataset.line].line);
    highlight(new Set([key]));
    const fb = L.featureGroup(net.lineFeatures[key] || []).getBounds();
    if (fb.isValid()) map.flyToBounds(fb, { padding: [40, 40] });
  }));

  const rl = document.getElementById("region-list");
  rl.innerHTML = d.regions.under.map((r, i) => `<li data-i="${i}"><span class="val">${r.residents.toLocaleString("en")}</span><b>${esc(r.name)}</b>
    <span class="sub">${r.places_per_resident} places/resident (typical 40) · bus: ${esc(r.lines.slice(0, 5).map((l) => l.replace("Bus ", "")).join(", ") || "none")}</span></li>`).join("");
  rl.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
    const r = d.regions.under[+li.dataset.i];
    selectSpot({ ...r, kind: "region", label: r.name, valueText: `${r.residents.toLocaleString("en")} residents`,
      detail: `${r.places_per_resident} places/resident (typical 40) · ${r.unserved_residents.toLocaleString("en")} without any stop nearby`,
      lines: r.lines.slice(0, 8), station: r.anchor.id, bounds: L.latLngBounds(r.boxes.flatMap((b) => [[b[0], b[1]], [b[2], b[3]]])) });
  }));
}
