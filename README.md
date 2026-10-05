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
streamlit run app/streamlit_app.py
pytest
jupyter lab
```

## Possible data sources
- VGN GTFS open data (Nuremberg timetables): https://www.vgn.de/opendata
- OpenStreetMap road network
