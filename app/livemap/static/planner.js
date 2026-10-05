// Network planner: edit the timetable with features, watch the driver inventory react,
// then run a historical evaluation of the scenario against today's timetable.

const DAY = "2026-09-28";
const COLORS = { scen: "#2a78d6", base: "#9a9994", cap: "#0b0b0b", over: "#d03b3b",
  removed: "#d03b3b", thinned: "#eda100", shortened: "#eb6834", speedup: "#0ca30c", merged: "#b5338a", express: "#4a3aa7" };
const TYPE_LABEL = {
  remove_line: "Remove line", thin_line: "Thin out trips", shorten_line: "Shorten line", speedup: "Speed up line",
  interline: "Merge lines", debunch: "Interleave lines", add_express: "Add express line",
};
const DAYS_LABEL = { all: "every day", weekday: "Mon–Fri", weekend: "Sat/Sun" };

let meta, lineById = {}, stationById = {};
let features = [];
let inventory = null;
let nextId = 1;
let draft = null; // express line being drawn: { stations: [] }

// ---------- map ----------
const map = L.map("map", { preferCanvas: true, zoomControl: false }).setView([49.4521, 11.0767], 12);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, className: "tiles-grey",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Timetable: VGN GTFS (CC BY 3.0 DE)',
}).addTo(map);
map.createPane("halo").style.zIndex = 340; // scenario effects glow under the coloured lines
map.createPane("fx").style.zIndex = 425;
map.createPane("st").style.zIndex = 450;
const haloLayer = L.layerGroup().addTo(map);
const fxLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup();
let hintEl = null;

// Same coloured network and live vehicles as the live map; vehicles of lines the scenario
// removes are faded so you can see what would be missing on the street right now.
const refMatches = (ref, product, line) => {
  const [p, l] = ref.split(":");
  return p === product && (l === "*" || l === line);
};
const removedBy = (product, line) => features.find((f) => f.enabled && f.type === "remove_line" && refMatches(f.line, product, line));
const net = NetMap.create(map, {
  vehicleClass: (t) => (removedBy(t.product, t.line) ? "veh-removed" : ""),
  tripNote: (t) => (removedBy(t.product, t.line) ? '<p class="meta" style="color:#a12a2a">✗ Not running in your scenario</p>' : ""),
  onStats: (s) => {
    liveBadge.innerHTML = `<i class="live-dot"></i>Live · <b>${s.total}</b> vehicles <span class="muted">(${s.byProduct.Bus} bus · ${s.byProduct.Tram} tram · ${s.byProduct.UBahn} U)</span>`;
  },
});
const liveBadge = L.DomUtil.create("div", "live-badge");
const LiveControl = L.Control.extend({ onAdd: () => liveBadge });
new LiveControl({ position: "bottomleft" }).addTo(map);
liveBadge.textContent = "Live vehicles loading…";
// map layer toggles (same as on the live map)
document.querySelectorAll("[data-layer]").forEach((cb) => cb.addEventListener("change", () => net.setLayer(cb.dataset.layer, cb.checked)));
document.querySelectorAll("[data-veh]").forEach((cb) => cb.addEventListener("change", () => {
  net.setProductVisible(cb.dataset.veh, cb.checked);
  const on = [...document.querySelectorAll("[data-veh]")].some((x) => x.checked);
  liveBadge.style.display = on ? "" : "none";
}));

function styleLines() {
  const focus = document.getElementById("focus-changes").checked;
  const active = features.filter((f) => f.enabled);
  const touched = new Set();
  const refsOf = (f) => [f.line, f.line_a, f.line_b].filter(Boolean);
  for (const [key, ls] of Object.entries(net.lineFeatures)) {
    const [product, line] = key.split(":");
    if (active.some((f) => refsOf(f).some((r) => refMatches(r, product, line)))) touched.add(key);
  }
  const fade = focus && active.length > 0;
  for (const [key, ls] of Object.entries(net.lineFeatures)) {
    for (const l of ls) l.setStyle(fade && !touched.has(key) ? { ...l._baseStyle, opacity: 0.18 } : l._baseStyle);
  }
  net.setLabelFilter(fade ? (p, l) => touched.has(`${p}:${l}`) : null);
  haloLayer.clearLayers();
  fxLayer.clearLayers();
  const paint = (ref, halo, line = {}) => {
    for (const [key, ls] of Object.entries(net.lineFeatures)) {
      const [product, ln] = key.split(":");
      if (!refMatches(ref, product, ln)) continue;
      for (const l of ls) {
        l.setStyle({ ...l._baseStyle, ...line });
        L.geoJSON(l.toGeoJSON(), { style: { color: halo, weight: l._baseStyle.weight + 9, opacity: 0.35, pane: "halo" }, interactive: false }).addTo(haloLayer);
      }
    }
  };
  for (const f of active) {
    if (f.type === "remove_line") paint(f.line, COLORS.removed, { dashArray: "2 8", opacity: 0.6 });
    if (f.type === "thin_line") paint(f.line, COLORS.thinned, { dashArray: "10 6" });
    if (f.type === "speedup") paint(f.line, COLORS.speedup);
    if (f.type === "interline" || f.type === "debunch") { paint(f.line_a, COLORS.merged); paint(f.line_b, COLORS.merged); }
    if (f.type === "shorten_line") {
      paint(f.line, COLORS.shortened);
      const s = stationById[f.at_station];
      if (s) L.marker([s.lat, s.lon], { icon: L.divIcon({ className: "", html: '<div class="express-label" style="background:#eb6834">✂ cut</div>', iconSize: null }), pane: "fx" }).addTo(fxLayer);
    }
    if (f.type === "add_express") drawExpress(f.stations, f.name, false);
  }
  if (draft) drawExpress(draft.stations, draft.name || "new", true);
  net.animate(); // re-class vehicles of removed lines
}
document.getElementById("focus-changes").addEventListener("change", styleLines);

function drawExpress(ids, name, isDraft) {
  const pts = ids.map((id) => stationById[id]).filter(Boolean).map((s) => [s.lat, s.lon]);
  if (!pts.length) return;
  L.polyline(pts, { color: "#fff", weight: 9, opacity: 0.9, pane: "fx" }).addTo(fxLayer);
  L.polyline(pts, { color: COLORS.express, weight: 5, dashArray: isDraft ? "6 6" : null, pane: "fx" }).addTo(fxLayer);
  pts.forEach((p, i) => {
    L.circleMarker(p, { radius: 5, color: COLORS.express, weight: 3, fillColor: "#fff", fillOpacity: 1, pane: "fx" })
      .bindTooltip(stationById[ids[i]].name).addTo(fxLayer);
  });
  L.marker(pts[0], { icon: L.divIcon({ className: "", html: `<div class="express-label">${esc(name)}</div>`, iconSize: null, iconAnchor: [-8, 8] }), pane: "fx" }).addTo(fxLayer);
}

function buildStationLayer() {
  for (const s of meta.stations) {
    const m = L.circleMarker([s.lat, s.lon], { radius: 4, color: "#52514e", weight: 1.5, fillColor: "#fff", fillOpacity: 1, pane: "st", className: "station-dot" });
    m.bindTooltip(s.name);
    m.on("click", () => {
      if (!draft) return;
      draft.stations.push(s.id);
      renderForm();
      styleLines();
    });
    stationLayer.addLayer(m);
  }
}
function setDrawMode(on) {
  if (on) {
    stationLayer.addTo(map);
    hintEl = L.DomUtil.create("div", "map-hint", document.getElementById("map"));
    hintEl.textContent = "Click stations in order to draw the express line";
  } else {
    map.removeLayer(stationLayer);
    hintEl?.remove();
    hintEl = null;
  }
}

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lineName = (ref) => {
  if (!ref) return "?";
  const [p, l] = ref.split(":");
  if (l === "*") return { Bus: "all buses", Tram: "all trams", UBahn: "all U-Bahn" }[p];
  return `${p === "UBahn" ? "" : p + " "}${l}`;
};
const hh = (h) => { const x = ((h % 24) + 24) % 24; return `${String(Math.floor(x)).padStart(2, "0")}:${String(Math.round((x % 1) * 60)).padStart(2, "0")}`; };

function featureTitle(f) {
  if (f.title) return f.title;
  switch (f.type) {
    case "remove_line": return `Remove ${lineName(f.line)}`;
    case "thin_line": return `${lineName(f.line)}: every ${f.keep_every}. trip ${hh(f.from_h)}–${hh(f.to_h)}`;
    case "shorten_line": return `Shorten ${lineName(f.line)} at ${stationById[f.at_station]?.name ?? "?"}`;
    case "speedup": return `Speed up ${lineName(f.line)} by ${f.pct} %`;
    case "interline": return `Merge ${lineName(f.line_a)} + ${lineName(f.line_b)}`;
    case "debunch": return `Interleave ${lineName(f.line_a)} with ${lineName(f.line_b)}`;
    case "add_express": return `Express ${f.name} (${f.stations.length} stops, every ${f.headway_min} min)`;
  }
  return f.type;
}
function featureDesc(f) {
  const days = DAYS_LABEL[f.days || "all"];
  switch (f.type) {
    case "thin_line": return `${days}`;
    case "shorten_line": return `drops the part towards ${stationById[f.drop_towards]?.name ?? "?"} · ${days}`;
    case "add_express": return `${hh(f.from_h)}–${hh(f.to_h)} · ${days} · ${f.stations.map((s) => stationById[s]?.name.replace(/^(Nürnberg|Fürth) /, "")).join(" – ")}`;
    default: return days;
  }
}

// ---------- features ----------
function addFeature(f) {
  features.push({ id: nextId++, enabled: true, days: "all", ...f });
  changed();
}
function changed() {
  renderFeatures();
  renderPresets();
  styleLines();
  refreshInventory();
}

function renderFeatures() {
  const ul = document.getElementById("features");
  document.getElementById("no-features").classList.toggle("hidden", features.length > 0);
  ul.innerHTML = "";
  features.forEach((f, i) => {
    const step = inventory?.steps?.[i];
    const chips = step && f.enabled ? chipHtml(step) : "";
    const li = document.createElement("li");
    li.className = f.enabled ? "" : "off";
    li.innerHTML = `<input type="checkbox" ${f.enabled ? "checked" : ""} aria-label="enable" />
      <span class="title">${esc(featureTitle(f))}</span>
      <button class="x" title="Remove">×</button>
      <div class="desc">${chips || ""}${f.type === "add_express" || f.type === "shorten_line" ? `<span class="small muted">${esc(featureDesc(f))}</span>` : ""}</div>`;
    li.querySelector("input").addEventListener("change", (e) => { f.enabled = e.target.checked; changed(); });
    li.querySelector(".x").addEventListener("click", () => { features = features.filter((x) => x !== f); changed(); });
    ul.appendChild(li);
  });
}
function chipHtml(step) {
  const out = [];
  for (const [pool, label] of [["Bus", "bus drivers"], ["Tram", "tram drivers"], ["UBahn", "U-Bahn drivers"]]) {
    const s = step[pool];
    if (!s || (s.peak === 0 && Math.abs(s.hours) < 0.5)) continue;
    if (s.peak) out.push(`<span class="chip ${s.peak > 0 ? "gain" : "cost"}">${s.peak > 0 ? "+" : ""}${s.peak} ${label}</span>`);
    out.push(`<span class="chip ${s.hours > 0 ? "gain" : "cost"}">${s.hours > 0 ? "+" : ""}${Math.round(s.hours)} h</span>`);
  }
  return out.join("") || '<span class="chip">no driver effect</span>';
}

function renderPresets() {
  const ul = document.getElementById("presets");
  ul.innerHTML = "";
  const used = new Set(features.map((f) => f.title).filter(Boolean));
  for (const p of meta.presets.filter((x) => !used.has(x.title))) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${esc(p.title)}</span><button>Add</button>`;
    li.querySelector("button").addEventListener("click", () => addFeature(structuredClone(p)));
    ul.appendChild(li);
  }
}

// ---------- forms ----------
let formType = null;
function renderAddButtons() {
  const sel = document.getElementById("add-select");
  sel.insertAdjacentHTML("beforeend", Object.entries(TYPE_LABEL).map(([t, l]) => `<option value="${t}">${l}</option>`).join(""));
  sel.addEventListener("change", () => { if (sel.value) openForm(sel.value); sel.value = ""; });
}
function lineOptions(includeAll, selected) {
  const all = includeAll ? [["Bus:*", "All bus lines"], ["Tram:*", "All tram lines"]] : [];
  return all.map(([v, l]) => `<option value="${v}">${l}</option>`).join("") + meta.lines.map((l) => {
    const extra = [l.drivers_peak ? `${l.drivers_peak} drivers` : "driverless", l.parallel_rail != null ? `${Math.round(l.parallel_rail * 100)} % next to rail` : null].filter(Boolean).join(" · ");
    return `<option value="${l.id}" ${l.id === selected ? "selected" : ""}>${lineName(l.id)} — ${esc(l.headsigns.join(" / "))} (${extra})</option>`;
  }).join("");
}
const daysSelect = (v = "all") => `<label>Days<select name="days">${Object.entries(DAYS_LABEL).map(([k, l]) => `<option value="${k}" ${k === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>`;

function openForm(type) {
  formType = type;
  draft = type === "add_express" ? { stations: [], name: `X${features.filter((f) => f.type === "add_express").length + 3}` } : null;
  setDrawMode(type === "add_express");
  renderForm();
  styleLines();
}
function closeForm() {
  formType = null;
  draft = null;
  setDrawMode(false);
  document.getElementById("feature-form").classList.add("hidden");
  styleLines();
}
function renderForm() {
  const form = document.getElementById("feature-form");
  form.classList.remove("hidden");
  const t = formType;
  let body = `<b>${TYPE_LABEL[t]}</b>`;
  if (["remove_line", "thin_line", "shorten_line", "speedup"].includes(t)) {
    body += `<label>Line<select name="line">${lineOptions(t === "thin_line" || t === "speedup")}</select></label>`;
  }
  if (t === "thin_line") body += `<div class="row"><label>From (h)<input name="from_h" type="number" step="0.5" value="20"></label><label>To (h)<input name="to_h" type="number" step="0.5" value="27"></label><label>Keep every<input name="keep_every" type="number" min="2" value="2"></label></div>`;
  if (t === "speedup") body += `<label>Running time reduction (%)<input name="pct" type="number" min="1" max="40" value="10"></label>`;
  if (t === "shorten_line") body += `<label>Cut at station<select name="at_station"></select></label><label>Drop the part towards<select name="drop_towards"></select></label>`;
  if (t === "interline" || t === "debunch") body += `<label>Line A<select name="line_a">${lineOptions(false)}</select></label><label>Line B${t === "debunch" ? " (gets shifted)" : ""}<select name="line_b">${lineOptions(false)}</select></label>`;
  if (t === "add_express") {
    body += `<div class="row"><label>Name<input name="name" value="${esc(draft.name)}"></label><label>Every (min)<input name="headway_min" type="number" min="3" value="15"></label><label>Dwell (s)<input name="dwell_s" type="number" value="30"></label></div>
      <div class="row"><label>From (h)<input name="from_h" type="number" step="0.5" value="6"></label><label>To (h)<input name="to_h" type="number" step="0.5" value="20"></label><span></span></div>
      <span class="hint">Click stations on the map in order (${draft.stations.length} selected)</span>
      <ol>${draft.stations.map((s, i) => `<li>${esc(stationById[s].name)} <button type="button" data-i="${i}">×</button></li>`).join("")}</ol>`;
  }
  body += daysSelect(t === "add_express" ? "weekday" : "all");
  body += `<div class="actions"><button type="button" id="form-cancel">Cancel</button><button class="primary" type="submit">Add to scenario</button></div>`;
  // keep typed values when re-rendering (express form re-renders on each station click)
  const prev = Object.fromEntries(new FormData(form).entries());
  form.innerHTML = body;
  for (const [k, v] of Object.entries(prev)) if (form.elements[k] && k !== "line") form.elements[k].value = v;
  if (prev.line && form.elements.line) form.elements.line.value = prev.line;
  if (t === "shorten_line") {
    const fill = () => {
      const l = lineById[form.elements.line.value];
      form.elements.at_station.innerHTML = l.stations.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
      form.elements.drop_towards.innerHTML = l.termini.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    };
    form.elements.line.addEventListener("change", fill);
    fill();
  }
  if (t === "interline") {
    // only lines that share a terminus with line A can hand over vehicles
    const fillB = () => {
      const a = lineById[form.elements.line_a.value];
      const ends = new Set(a.termini.map((x) => x.id));
      const ok = meta.lines.filter((l) => l.id !== a.id && l.termini.some((x) => ends.has(x.id)));
      form.elements.line_b.innerHTML = ok.length
        ? ok.map((l) => `<option value="${l.id}">${lineName(l.id)} — shared end: ${esc(l.termini.filter((x) => ends.has(x.id)).map((x) => x.name).join(", "))}</option>`).join("")
        : '<option value="">no line shares a terminus</option>';
    };
    form.elements.line_a.addEventListener("change", fillB);
    fillB();
  }
  form.querySelectorAll("ol button").forEach((b) => b.addEventListener("click", () => { draft.stations.splice(+b.dataset.i, 1); renderForm(); styleLines(); }));
  form.elements.name?.addEventListener("input", (e) => { draft.name = e.target.value; styleLines(); });
  document.getElementById("form-cancel").addEventListener("click", closeForm);
}
document.getElementById("feature-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(e.target).entries());
  const num = (k) => (fd[k] !== undefined ? Number(fd[k]) : undefined);
  const f = { type: formType, days: fd.days };
  for (const k of ["line", "line_a", "line_b", "at_station", "drop_towards", "name"]) if (fd[k]) f[k] = fd[k];
  for (const k of ["from_h", "to_h", "keep_every", "pct", "headway_min", "dwell_s"]) if (fd[k] !== undefined) f[k] = num(k);
  if (formType === "add_express") {
    if (draft.stations.length < 2) return alert("Pick at least two stations on the map.");
    f.stations = [...draft.stations];
  }
  if ((formType === "interline" || formType === "debunch") && f.line_a === f.line_b) return alert("Pick two different lines.");
  closeForm();
  addFeature(f);
});

// ---------- inventory ----------
let invTimer = null, invSeq = 0;
function refreshInventory() {
  clearTimeout(invTimer);
  invTimer = setTimeout(async () => {
    const seq = ++invSeq;
    const payload = features.map(({ id, title, ...f }) => f);
    const res = await fetch("/api/planner/inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ day: DAY, features: payload }) });
    if (seq !== invSeq) return; // a newer request is on its way
    const prev = inventory;
    inventory = await res.json();
    renderInventory(prev);
    renderFeatures();
  }, 250);
}

function animateNumber(el, to, fmt = (v) => Math.round(v)) {
  const from = Number(el.dataset.v ?? to);
  el.dataset.v = to;
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 600);
    const e = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function toast(text, cls) {
  const el = document.createElement("div");
  el.className = `toast ${cls}`;
  el.textContent = text;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

const POOL_LABEL = { Bus: "Bus drivers", Tram: "Tram drivers", UBahn: "U-Bahn drivers (U1; U2/U3 driverless)" };
function renderInventory(prev) {
  const { baseline: b, scenario: s } = inventory;
  document.getElementById("inv-day").textContent = `based on weekday ${new Date(inventory.day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}`;
  const bb = b.pools.Bus, sb = s.pools.Bus;
  const pct = (100 * sb.peak) / bb.peak;
  // round towards the budget edge so "1 driver missing" never shows as 100 %
  animateNumber(document.getElementById("cap-pct"), pct, (v) => String(sb.peak > bb.peak ? Math.ceil(v) : Math.floor(v)));
  const over = Object.entries(s.pools).filter(([p, v]) => v.peak > b.pools[p].peak || v.hours > b.pools[p].hours + 0.5);
  const st = document.getElementById("cap-status");
  st.className = `status ${over.length ? "critical" : "good"}`;
  st.textContent = over.length ? `▲ Over budget: ${over.map(([p]) => p).join(", ")}` : "✓ Within budget";

  const box = document.getElementById("pools");
  if (!box.children.length) {
    const tpl = (p) => `
      <div class="pool ${p === "Bus" ? "" : "small"}" data-pool="${p}">
        <div class="top"><span>${POOL_LABEL[p]}</span><span><b class="used-n"></b> / <span class="cap-n"></span> · <span class="free"></span></span></div>
        <div class="bar"><div class="used"></div><div class="freed"></div><div class="over"></div></div>
        <div class="sub"><span>Driver hours/day: <b class="h-used"></b> / <span class="h-cap"></span></span><span class="h-free"></span></div>
      </div>`;
    box.innerHTML = tpl("Bus");
    document.getElementById("pools-other").innerHTML = Object.keys(b.pools).filter((p) => p !== "Bus").map(tpl).join("");
  }
  const other = Object.keys(b.pools).filter((p) => p !== "Bus").map((p) => `${p === "UBahn" ? "U-Bahn" : p} ${s.pools[p].peak}/${b.pools[p].peak}`);
  document.getElementById("other-pools-summary").textContent = `Tram & U-Bahn drivers · ${other.join(" · ")}`;
  for (const p of Object.keys(b.pools)) {
    const el = document.querySelector(`[data-pool="${p}"]`);
    const cap = b.pools[p].peak, used = s.pools[p].peak, free = cap - used;
    const hc = b.pools[p].hours, hu = s.pools[p].hours, hf = hc - hu;
    animateNumber(el.querySelector(".used-n"), used);
    el.querySelector(".cap-n").textContent = cap;
    const freeEl = el.querySelector(".free");
    freeEl.className = `free ${free > 0 ? "gain" : free < 0 ? "cost" : ""}`;
    freeEl.textContent = free > 0 ? `+${free} free` : free < 0 ? `${-free} missing` : "0 free";
    const u = Math.min(used, cap) / (cap || 1);
    el.querySelector(".used").style.width = `${u * 100}%`;
    el.querySelector(".freed").style.left = `${u * 100}%`;
    el.querySelector(".freed").style.width = `${Math.max(0, free) / (cap || 1) * 100}%`;
    el.querySelector(".over").style.width = `${Math.min(1, Math.max(0, -free) / (cap || 1)) * 100}%`;
    animateNumber(el.querySelector(".h-used"), hu);
    el.querySelector(".h-cap").textContent = Math.round(hc);
    el.querySelector(".h-free").textContent = Math.abs(hf) >= 0.5 ? (hf > 0 ? `+${Math.round(hf)} h free` : `${Math.round(-hf)} h missing`) : "";
    el.querySelector(".h-free").style.color = hf > 0 ? "#006300" : "#a12a2a";
    if (prev) {
      const d = (prev.scenario.pools[p].peak - used);
      const dh = Math.round(prev.scenario.pools[p].hours - hu);
      if (d) { toast(`${d > 0 ? "+" : ""}${d} ${p === "Bus" ? "" : p + " "}drivers`, d > 0 ? "gain" : "cost"); el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); }
      else if (p === "Bus" && Math.abs(dh) >= 1) toast(`${dh > 0 ? "+" : ""}${dh} h`, dh > 0 ? "gain" : "cost");
    }
  }
  drawProfile(b.grid, b.pools.Bus.on_duty, s.pools.Bus.on_duty, bb.peak);
}

function drawProfile(grid, base, scen, cap) {
  const W = 348, H = 150, m = { l: 30, r: 6, t: 8, b: 20 };
  const xs = (h) => m.l + ((h - 4) / 22) * (W - m.l - m.r);
  const ymax = Math.max(cap, ...scen, ...base) * 1.1;
  const ys = (v) => H - m.b - (v / ymax) * (H - m.t - m.b);
  const idx = grid.map((h, i) => [h, i]).filter(([h]) => h >= 4 && h <= 26);
  const path = (arr) => idx.map(([h, i], k) => `${k ? "L" : "M"}${xs(h).toFixed(1)},${ys(arr[i]).toFixed(1)}`).join("");
  const area = `${path(base)}L${xs(idx.at(-1)[0])},${ys(0)}L${xs(idx[0][0])},${ys(0)}Z`;
  // red where the scenario needs more drivers than available
  let overPath = "";
  idx.forEach(([h, i]) => { if (scen[i] > cap) overPath += `M${xs(h)},${ys(cap)}L${xs(h)},${ys(scen[i])}`; });
  const ticks = [6, 10, 14, 18, 22, 26].map((h) => `<text x="${xs(h)}" y="${H - 5}" text-anchor="middle">${hh(h)}</text>`).join("");
  const yt = [0, Math.round(cap / 2), cap].map((v) => `<text x="${m.l - 4}" y="${ys(v) + 3}" text-anchor="end">${v}</text><line x1="${m.l}" x2="${W - m.r}" y1="${ys(v)}" y2="${ys(v)}" stroke="#eceae5"/>`).join("");
  const el = document.getElementById("profile-chart");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" font-size="10" fill="#7a7974">
    ${yt}${ticks}
    <path d="${area}" fill="${COLORS.base}" opacity=".3"/>
    <line x1="${m.l}" x2="${W - m.r}" y1="${ys(cap)}" y2="${ys(cap)}" stroke="${COLORS.cap}" stroke-dasharray="4 3" stroke-width="1.5"/>
    <path d="${path(scen)}" fill="none" stroke="${COLORS.scen}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${overPath}" stroke="${COLORS.over}" stroke-width="3" opacity=".7"/>
    <line class="cross" y1="${m.t}" y2="${H - m.b}" stroke="#52514e" stroke-width="1" visibility="hidden"/>
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/>
  </svg><div class="tip hidden"></div>`;
  const svg = el.querySelector("svg"), cross = el.querySelector(".cross"), tip = el.querySelector(".tip");
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const h = 4 + ((x - m.l) / (W - m.l - m.r)) * 22;
    const [, i] = idx.reduce((best, cur) => (Math.abs(cur[0] - h) < Math.abs(best[0] - h) ? cur : best));
    cross.setAttribute("x1", xs(grid[i])); cross.setAttribute("x2", xs(grid[i])); cross.setAttribute("visibility", "visible");
    tip.classList.remove("hidden");
    tip.innerHTML = `<b>${hh(grid[i])}</b><br>Current: ${base[i]}<br>Scenario: <b>${scen[i]}</b><br>Available: ${cap}`;
    tip.style.left = `${Math.min(r.width - 110, (xs(grid[i]) / W) * r.width + 8)}px`;
    tip.style.top = "10px";
  });
  svg.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); tip.classList.add("hidden"); });
}

// ---------- evaluation ----------
const KPI_ROWS = [
  ["Travel time"],
  ["PT / car travel time (median)", (r) => r.pt_car_ratio_median, (v) => v.toFixed(2) + "×", "lower"],
  ["Trips where PT ≤ 1.5× car", (r) => r.share_competitive, (v) => (v * 100).toFixed(1) + " %", "higher"],
  ["Avg. PT travel time", (r) => r.pt_minutes_mean, (v) => v.toFixed(1) + " min", "lower"],
  ["Avg. transfers", (r) => r.transfers_mean, (v) => v.toFixed(2), "lower"],
  ["Not reachable within 2 h", (r) => r.unreachable_share, (v) => (v * 100).toFixed(1) + " %", "lower"],
  ["Service pattern (06–21 h)"],
  ["Expected wait per stop section", (r) => r.expected_wait_min, (v) => v.toFixed(2) + " min", "lower"],
  ["Overlapping departures (< 2 min apart)", (r) => r.overlap_share, (v) => (v * 100).toFixed(2) + " %", "lower"],
  ["Time without service (gap > 20 min)", (r) => r.gap_share, (v) => (v * 100).toFixed(1) + " %", "lower"],
  ["Gaps > 20 min (count)", (r) => r.gaps_over_20min, (v) => v.toLocaleString("en"), "lower"],
  ["Reliability"],
  ["Avg. delay", (r) => r.delay_mean_min, (v) => v.toFixed(2) + " min", "lower"],
  ["Punctuality (≤ 3 min)", (r) => r.punctuality, (v) => (v * 100).toFixed(1) + " %", "higher"],
  ["Resources"],
  ["Bus drivers at peak", (r) => r.drivers_peak.Bus, (v) => v, "lower"],
  ["Tram drivers at peak", (r) => r.drivers_peak.Tram, (v) => v, "lower"],
  ["Bus driver hours (period)", (r) => r.driver_hours_week.Bus, (v) => Math.round(v).toLocaleString("en"), "lower"],
  ["Vehicle-km (period)", (r) => r.vehicle_km, (v) => Math.round(v).toLocaleString("en"), null],
  ["Trips (period)", (r) => r.trips, (v) => v.toLocaleString("en"), null],
];

document.getElementById("eval-run").addEventListener("click", async () => {
  const btn = document.getElementById("eval-run"), status = document.getElementById("eval-status");
  btn.disabled = true;
  const t0 = Date.now();
  const timer = setInterval(() => { status.innerHTML = `<span class="spinner"></span>Planning ~${(features.length ? 2 : 1) * 2400} journeys per day… ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
  try {
    const res = await fetch("/api/planner/evaluate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: document.getElementById("eval-start").value, days: +document.getElementById("eval-days").value, features: features.map(({ id, title, ...f }) => f) }),
    });
    if (!res.ok) throw new Error(await res.text());
    renderKpis(await res.json());
    status.textContent = `Evaluated in ${Math.round((Date.now() - t0) / 1000)} s.`;
  } catch (err) {
    status.textContent = `Evaluation failed: ${err.message}`;
  } finally {
    clearInterval(timer);
    btn.disabled = false;
  }
});

// shown by default; the rest behind "Show all KPIs"
const HEADLINE = new Set(["PT / car travel time (median)", "Trips where PT ≤ 1.5× car", "Expected wait per stop section", "Avg. delay", "Bus drivers at peak"]);
let lastResult = null, showAllKpis = false;
document.getElementById("kpi-more").addEventListener("click", () => {
  showAllKpis = !showAllKpis;
  renderKpis(lastResult);
});

function renderKpis(r) {
  lastResult = r;
  const tb = document.querySelector("#kpi-table tbody");
  tb.innerHTML = "";
  for (const [label, get, fmt, better] of KPI_ROWS) {
    if (!showAllKpis && !HEADLINE.has(label)) continue;
    if (!get) { tb.insertAdjacentHTML("beforeend", `<tr class="group"><td colspan="4">${label}</td></tr>`); continue; }
    const a = get(r.baseline), b = get(r.scenario);
    if (a == null || b == null) continue;
    const d = b - a;
    const eps = Math.abs(a) * 0.001 + 1e-9;
    let cls = "", icon = "";
    if (better && Math.abs(d) > eps) {
      const good = better === "lower" ? d < 0 : d > 0;
      cls = good ? "better" : "worse";
      icon = good ? "✓ " : "▲ ";
    }
    tb.insertAdjacentHTML("beforeend", `<tr><td>${label}</td><td>${fmt(a)}</td><td>${fmt(b)}</td><td class="${cls}">${Math.abs(d) > eps ? icon + (d > 0 ? "+" : "−") + String(fmt(Math.abs(d))) : "–"}</td></tr>`);
  }
  document.getElementById("kpi-table").classList.remove("hidden");
  document.getElementById("eval-method").classList.remove("hidden");
  const more = document.getElementById("kpi-more");
  more.classList.remove("hidden");
  more.textContent = showAllKpis ? "Show key KPIs only" : "Show all KPIs";
  document.getElementById("eval-notes").innerHTML = `Period ${r.period[0]} – ${r.period[1]} · planned timetable: VGN GTFS · car: OSRM free-flow × time-of-day congestion + 5 min access · OD sample: 400 station pairs × 6 departure times/day · delay: ${esc(r.baseline.delay_source)}.`;
}

// ---------- boot ----------
(async () => {
  meta = await (await fetch(`/api/planner/meta?day=${DAY}`)).json();
  for (const l of meta.lines) lineById[l.id] = l;
  for (const s of meta.stations) stationById[s.id] = s;
  await net.start();
  document.querySelectorAll("[data-veh]").forEach((cb) => cb.dispatchEvent(new Event("change")));
  buildStationLayer();
  renderAddButtons();
  renderPresets();
  renderFeatures();
  refreshInventory();
})();
