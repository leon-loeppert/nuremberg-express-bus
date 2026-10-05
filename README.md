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
- **Limitations:** vehicles move in straight lines between stops (not snapped to streets). Occupancy
  (`Besetztgrad`) is currently always "Unbekannt".

## Possible data sources
- VAG PULS API (live departures/trips): https://start.vag.de/dm/api/v1
- VGN GTFS open data (Nuremberg timetables): https://www.vgn.de/opendata
- OpenStreetMap road network
# ClaudeHackathon
