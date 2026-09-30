# 🚨 AEGIS-GIS // Strategic Relocation & Hazard Intelligence (SIH26191)

**AEGIS-GIS** is a predictive, strategic disaster intelligence and population relocation platform designed for the **Ministry of Home Affairs (MHA)**, **State Emergency Operations Centers (SEOC)**, **National Disaster Management Authority (NDMA)**, and **District Disaster Management Authorities (DDMA)**.

Under problem statement **SIH26191**, AEGIS-GIS transitions disaster management from reactive dispatch to **proactive, automated predictive risk modeling**, identifying **Dynamic Hazard Red Zones**, calculating **Carrying Capacity Stress**, and orchestrating **Safe Population Relocation Convoys** before disasters strike.

---

## ⚡ Core Capabilities (SIH26191)

1. **Ministry of Earth Sciences (MoES / IMD) Hazard Feed & Predictive Timelines**
   - Ingests real-time hydro-meteorological telemetry: IMD heavy rainfall grid alerts, cyclone storm tracking, wind gusts, and upper catchment reservoir releases (Chembarambakkam, Poondi, Vaigai, Mettur Dam).
   - Computes dynamic **Predictive Timelines** (e.g. 14 hours to peak flood onset) and synthesizes explicit meteorological causality.

2. **Indian Census Demographics & Vulnerability Database**
   - Granular village and ward-level Census attributes for Tamil Nadu target sectors stored in SQLite.
   - Tracks baseline population, density per sq. km, housing distribution (Pucca vs. Semi-Permanent vs. Kutcha/thatch), and vulnerability index metrics (elderly 60+, children <5, differently-abled PwD, chronic medical).
   - Dynamically calculates estimated affected victims and demographic rosters.

3. **Carrying Capacity & Relocation Engine**
   - Evaluates population pressure ratios against safe threshold limits ($Safe\ Capacity\ Headroom$).
   - Matches over-capacity habitations with nearest operational evacuation shelters (e.g. `Shelter S-9`, `Shelter S-10`, `Shelter S-3`).
   - Automatically computes heavy bus and ambulance convoy requirements.

4. **Interactive Strategic GIS Map & Smooth Gradient Heatmaps**
   - Pure strategic MHA intelligence map (Leaflet.js): statewide multi-color hazard heatmaps (Green/Amber/Red), census village boundaries, and graded risk polygons.
   - Zero-clutter, zero-popup UX: all telemetry and relocation plans display exclusively in the dedicated predictive intelligence panel.

5. **Geological Hazard & Tectonic Shear Prediction**
   - Predicts geotechnical slope instability, soil saturation surcharge, and liquefaction risk along active Tamil Nadu fault lines.

6. **Multi-Channel Distress Ingestion & AI Triage**
   - Ingests unstructured streams from social media, Citizen SOS apps, and emergency calls with Gemini AI zero-shot triage and high-speed offline heuristic fallback.

---

## 🏗️ System Architecture

```
AEGIS-GIS/
├── app/
│   ├── server.py             # FastAPI backend with Strategic Fusion endpoints & WebSockets
│   ├── models.py             # Pydantic models for Census, Shelters, Red Zones, and Relocation
│   ├── database.py           # Async SQLite engine (cad_disaster.db) for Habitations & Shelters
│   ├── geocoding.py          # Spatial boundaries, point-in-polygon & Tamil Nadu gazetteer
│   ├── triage_engine.py      # Dual-mode AI triage: Gemini Flash + Offline Heuristic Engine
│   └── services/
│       ├── data_fusion.py    # Central Data Fusion Orchestrator (MoES + Census + Shelters)
│       ├── moes_weather.py   # IMD weather alerts, catchment discharge & predictive onset
│       ├── census_demographics.py # Official Census demographics & vulnerability calculations
│       ├── capacity.py       # Carrying capacity pressure & population deficit evaluations
│       ├── relocation.py     # Safe shelter matching & evacuation convoy route planner
│       ├── geological_predictions.py # Soil strata, saturation & tectonic fault line GIS
│       ├── red_zone.py       # Multi-hazard red zone boundary & severity index engine
│       └── social_ingestion.py # Real-time crowdsourced social media distress worker
├── static/                   # Strategic Command Center Web UI
│   ├── index.html            # 4-Tab Layout: Engine, Red Zones, Geological, Relocation
│   ├── css/style.css         # MIL-SPEC Glassmorphism dark-mode tactical theme
│   └── js/
│       ├── app.js            # Strategic UI controller, Data Fusion charts & insights
│       ├── map.js            # Clean Leaflet GIS map (heatmaps, polygons, zero popups)
│       └── audio.js          # Web Audio emergency alert synthesizer
├── cad_disaster.db           # SQLite database pre-seeded with Census & Shelter schemas
├── SIH26191_AEGIS_GIS_WORKFLOW_ARCHITECTURE.md # Comprehensive system workflow briefing
├── package_project.py        # Automated clean ZIP production packaging utility
├── run.py                    # Server launcher entrypoint
├── requirements.txt          # Python dependencies
├── .env.example              # Environment variable configuration template
└── README.md                 # System overview and quickstart manual
```

---

## 🚀 Setup & Quickstart Guide

### Prerequisites
* **Python**: Python 3.10, 3.11, or 3.12+ (tested up to Python 3.14)
* **OS**: Windows, macOS, or Linux
* **Browser**: Modern web browser (Chrome, Edge, Firefox)

---

### Step 1: Create and Activate a Virtual Environment

**Windows (PowerShell):**
```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
```

**Linux / macOS / Git Bash:**
```bash
python3 -m venv venv
source venv/bin/activate
```

---

### Step 2: Install Dependencies

```bash
pip install -r requirements.txt
```

---

### Step 3: Configure Environment Variables

Create your local `.env` file from the provided template:

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

**Linux / macOS:**
```bash
cp .env.example .env
```

Edit `.env` if you wish to provide optional cloud API keys:
```env
# Optional: Google Gemini API Key for Zero-Shot LLM Triage & Vision Analysis
# Obtain at: https://aistudio.google.com/
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: Google Maps API Key for Live Turn-by-Turn Routing & Dynamic POI Overlays
# Obtain at: https://console.cloud.google.com/google/maps-apis
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here

# Server Bindings
HOST=127.0.0.1
PORT=8000
```

> [!TIP]
> **Zero-Cloud Offline Fallback (No Keys Needed!):**  
> If neither API key is provided, **AEGIS-CAD functions 100% locally with zero downtime**:
> - **Triage Engine**: Automatically falls back to an embedded high-speed deterministic regex & gazetteer rule engine with distress scoring and casualty estimation.
> - **Routing & GIS**: Automatically falls back to the pre-seeded Tamil Nadu spatial gazetteer, local Haversine calculations, and pre-seeded emergency POIs (hospitals, fire stations, helipads).

---

### Step 4: Run the Command Center Server

```bash
python run.py
```

Once the terminal outputs `[*] Launching on: http://0.0.0.0:8000`, open your browser:
👉 **[http://127.0.0.1:8000](http://127.0.0.1:8000)**

---

### Step 5: Run Automated Tests

To verify schema validation, heuristic fallback triage, fleet dispatch, and REST API endpoints:
```bash
python -m pytest -v
```
All 41 tests execute without requiring any external internet connectivity or live API keys.

---

## 📡 CAD API Endpoints

- `POST /api/ingest`: Ingest raw crowdsourced/social message, run AI triage, save, and broadcast to dispatchers.
- `GET /api/incidents`: Filter incidents by `status`, `severity`, `disaster_type`, or keyword search.
- `GET /api/incidents/{id}`: Detailed incident telemetry and assigned first responder units.
- `POST /api/incidents/{id}/dispatch`: Dispatch responder units (`NDRF`, `FIRE`, `EMS`, etc.) to scene.
- `POST /api/incidents/{id}/status`: Transition incident operational status (`PENDING`, `TRIAGED`, `DISPATCHED`, `ON_SCENE`, `RESOLVED`).
- `GET /api/units`: List all emergency responder units and their status.
- `GET /api/stats`: Real-time aggregate statistics (trapped citizens, active critical incidents, units ready).
- `POST /api/simulate/feed`: Trigger a simulated live emergency stream.
- `GET /api/export/sitrep`: Export formatted Markdown Situation Report for Disaster Authorities.
- `WS /ws/cad`: Real-time WebSocket connection for live CAD dispatcher terminals.
