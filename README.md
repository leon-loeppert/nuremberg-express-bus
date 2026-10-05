# Express Buses Despite a Driver Shortage — Fraunhofer IIS Track 1

**Challenge:** Nuremberg has spare buses but too few drivers. How can AI optimise timetables,
routes, rotas and resources so extra express bus lines can launch with minimal (or no) extra staff?

## Structure
```
data/raw/          # source data (GTFS from VGN, demand data, etc.) — git-ignored
data/processed/    # cleaned / derived data — git-ignored
notebooks/         # exploration
src/expressbus/
  data/            # loading & cleaning (GTFS, passenger flows)
  demand/          # demand / passenger-flow modelling
  optimization/    # vehicle & crew scheduling, rota optimisation (OR-Tools / PuLP)
  live/            # live tracker polling the VAG PULS API
app/livemap/       # live network map (FastAPI + Leaflet/OSM)
app/               # Streamlit demo
tests/
```

## Setup
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
cp .env.example .env   # add your ANTHROPIC_API_KEY
```

## Run
```bash
# Live network map -> http://localhost:8000
uvicorn app.livemap.server:app --reload --reload-dir app --reload-dir src

streamlit run app/streamlit_app.py
pytest
jupyter lab
```

## Live map
Shows the U-Bahn, tram and bus network on OpenStreetMap, plus every running vehicle, coloured
by delay. Inspired by https://livemap.vag.de, which shows only U-Bahn/tram; this map adds buses.

- **Static network:** line geometries from the livemap.vag.de files (`lines.xhr`, `buslines.geojson`),
  plus stops from the PULS API. Downloaded once to `data/raw/vag/`; refresh with `python -m expressbus.data.vag`.
- **Live data:** VAG PULS API (`start.vag.de/dm/api/v1`). `/fahrten/{Bus,Tram,UBahn}` lists the trips
  in the current window, and `/fahrten/{product}/{day}/{trip}` gives every stop with planned (Soll)
  and real-time (Ist) times and coordinates. The server polls these (lists every 30 s, trip details
  every 90 s). The browser interpolates vehicle positions between stops every second.
- **Recording:** finished trips are appended to `data/raw/live/trips_<date>.jsonl`, so delay data
  builds up while the server runs. Turn it off with `RECORD_TRIPS=0`.
- **Snapping to streets** (`src/expressbus/live/routing.py`): each stop-to-stop hop follows the
  shortest path along that line's geometry. If that fails, it tries all lines of the same product
  (replacement buses also try the tram network), then road routing via the public OSRM server
  (cached in `data/processed/osrm_cache.json`), and only then a straight line.
- **Limitations:** occupancy (`Besetztgrad`) is currently always "Unbekannt".

## Network planner and historical evaluation
`http://localhost:8000/planner`: switch scenario features on and off, watch the **driver inventory**,
then evaluate the scenario against the current timetable over a past period (default: the week
of 28 Sep – 4 Oct 2026).

- **Timetable:** VGN GTFS (`python -m expressbus.eval.timetable` downloads and preprocesses it).
  VAG lines (U-Bahn, tram, bus) can be edited. S-Bahn trains in the area stay as fixed background.
- **Driver inventory** (`src/expressbus/eval/resources.py`): the GTFS has no vehicle rotations,
  so they are rebuilt by chaining trips at their terminus (min. 5 min layover). Each rotation =
  one vehicle out = one driver on duty; U2/U3 are driverless. Budgets: **drivers at peak** and
  **driver hours/day** per pool (bus, tram, U-Bahn). Capacity = current timetable = 100 %.
- **Features** (`src/expressbus/eval/scenario.py`): remove line, thin out trips in a time window,
  shorten line at a station, speed up line (bus priority), merge lines that share a terminus
  (vehicles and passengers ride through), interleave two lines on a shared section, add an
  express line (stops clicked on the map, running times from OSRM).
- **KPIs** (`src/expressbus/eval/kpis.py`), per day, then aggregated over the period:
  - travel time PT vs. car (median ratio, share of trips where PT ≤ 1.5× car), avg. PT time,
    transfers, unreachable share. Fixed seeded sample: 400 station pairs × 6 departure times/day,
    planned with a connection-scan journey planner. Car = OSRM free-flow × time-of-day
    congestion + 5 min access.
  - service pattern 06–21 h per stop-to-stop section: expected wait, overlapping departures
    (< 2 min apart), time without service (gaps > 20 min).
  - delay and punctuality: observed per line from the recorded live data, weighted by the
    scenario's trips.
  - resources: drivers at peak, driver hours, vehicle-km, trips.
- CLI: `python -m expressbus.eval.engine 2026-09-28 7 scenario.json`

**Assumptions to keep in mind:** the OD sample uses stop activity as a stand-in for demand (no
passenger counts yet). Car congestion factors are estimates. Delays only exist from the day
recording started, so they are a line-level model, not a replay of last week.

## Possible data sources
- VGN GTFS timetable (CC BY 3.0 DE): https://www.vgn.de/opendata/GTFS.zip
- VAG PULS API (live departures/trips): https://start.vag.de/dm/api/v1
- VGN GTFS open data (Nuremberg timetables): https://www.vgn.de/opendata
- OpenStreetMap road network
# ClaudeHackathon
