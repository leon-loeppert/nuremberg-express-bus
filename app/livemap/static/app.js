// Nuremberg live network map: sidebar, stops and line filter around the shared NetMap layer.

const BUS_COLOR = getComputedStyle(document.documentElement).getPropertyValue("--bus").trim();
const { esc, fmtTime, fmtDelay, lineLabel, REGIO_COLOR } = NetMap;

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

let selectedLine = "";
const layerChecked = (k) => document.querySelector(`[data-layer="${k}"]`).checked;

const net = NetMap.create(map, {
  labelMinZoom: 14,
  initialLayers: Object.fromEntries(["net-UBahn", "net-Tram", "net-Bus", "net-Regio"].map((k) => [k, layerChecked(k)])),
  onLineClick: (_product, line) => setLine(line),
  vehicleFilter: (t) => !selectedLine || t.line === selectedLine,
  onUpdate: (data, trips) => {
    document.getElementById("updated").textContent = !data ? "Server unreachable — retrying…"
      : data.updated ? `Live · data from ${fmtTime(data.updated)} · ${trips.length} trips tracked`
      : "Loading live data (first poll takes ~30 s)…";
    updateLineFilter(trips);
  },
  onStats: renderStats,
});

// ---------- sidebar ----------
function renderStats(s) {
  document.getElementById("kpi-total").textContent = s.total;
  document.getElementById("kpi-split").textContent = `${s.byProduct.Bus} bus · ${s.byProduct.Tram} tram · ${s.byProduct.UBahn} U-Bahn`;
  document.getElementById("kpi-ontime").textContent = s.rt ? `${Math.round((100 * s.ontime) / s.rt)} %` : "–";
  document.getElementById("kpi-delay").textContent = s.rt ? `${(s.delaySum / s.rt / 60).toFixed(1)} min` : "–";
  document.getElementById("kpi-late").textContent = s.rt ? s.late : "–";
  const worst = Object.values(s.lines).filter((l) => l.n >= 2)
    .map((l) => ({ ...l, avg: l.sum / l.n })).sort((a, b) => b.avg - a.avg).slice(0, 6);
  document.getElementById("worst-lines").innerHTML = worst.map((l) =>
    `<li data-line="${esc(l.line)}"><b>${esc(lineLabel(l.product, l.line))}</b> · Ø ${fmtDelay(l.avg)} <span class="muted">(${l.n} vehicles)</span></li>`).join("");
}
document.getElementById("worst-lines").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) setLine(li.dataset.line);
});

function updateLineFilter(trips) {
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
    return `<option value="${esc(l)}"${l === selectedLine ? " selected" : ""}>${esc(lineLabel(p, l))}</option>`;
  }).join("");
}
function setLine(line) {
  selectedLine = selectedLine === line ? "" : line;
  document.getElementById("line-filter").value = selectedLine;
  for (const [key, feats] of Object.entries(net.lineFeatures)) {
    const l = key.split(":")[1];
    for (const f of feats) {
      const base = f._baseStyle;
      f.setStyle(selectedLine && l !== selectedLine ? { ...base, opacity: 0.15 }
        : selectedLine ? { ...base, weight: base.weight + 3, opacity: 1, color: base.color === REGIO_COLOR ? BUS_COLOR : base.color } : base);
      if (selectedLine === l) f.bringToFront();
    }
  }
  net.setLabelFilter(selectedLine ? (_p, l) => l === selectedLine : null);
  net.animate();
}
document.getElementById("line-filter").addEventListener("change", (e) => setLine(e.target.value || selectedLine));
document.querySelectorAll("[data-layer]").forEach((cb) => cb.addEventListener("change", () => {
  if (cb.dataset.layer === "stops") return net.setStopsVisible(cb.checked);
  net.setLayer(cb.dataset.layer, cb.checked);
}));
document.querySelectorAll("[data-veh]").forEach((cb) => cb.addEventListener("change", () => net.setProductVisible(cb.dataset.veh, cb.checked)));

// ---------- boot ----------
(async () => {
  await net.start();
  net.loadStops(layerChecked("stops"));
})();
