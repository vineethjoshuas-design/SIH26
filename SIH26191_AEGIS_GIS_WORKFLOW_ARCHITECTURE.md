# 🛡️ AEGIS-GIS // STRATEGIC RELOCATION & HAZARD INTELLIGENCE (SIH26191)
## System Workflow, Data Fusion Architecture & Operational Specification

---

### Executive Overview & Mission

**AEGIS-GIS** is a predictive, strategic disaster intelligence and population relocation platform designed for the **Ministry of Home Affairs (MHA)**, **State Emergency Operations Centers (SEOC)**, **National Disaster Management Authority (NDMA)**, and **District Disaster Management Authorities (DDMA)**.

Under problem statement **SIH26191**, AEGIS-GIS shifts disaster response from reactive emergency dispatch to **proactive, automated predictive risk modeling**, calculating **Carrying Capacity Stress**, identifying **Dynamic Hazard Red Zones**, and orchestrating **Safe Population Relocation Convoys** before catastrophic events unfold.

---

### 1. Four Primary Data Integration Streams

AEGIS-GIS fuses four heterogeneous national data sources into a real-time predictive intelligence engine:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                AEGIS-GIS DATA FUSION ENGINE                            │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
        ┌───────────────────────────────────┼────────────────────────────────────┐
        │                                   │                                    │
        ▼                                   ▼                                    ▼
┌────────────────────────┐      ┌────────────────────────┐      ┌────────────────────────┐
│  1. MoES / IMD HAZARD  │      │  2. CENSUS ENUMERATION │      │  3. GIS GAZETTEER &    │
│  - Heavy Rainfall Grid │      │  - Granular Population │      │     ADMIN BOUNDARIES   │
│  - Cyclone Gust Scales │      │  - Density per sq. km  │      │  - Tamil Nadu Grids    │
│  - Reservoir Discharge │      │  - Housing (Pucca/Kut) │      │  - Village Polygons    │
│  - Storm Surge Indices │      │  - Fragility (PwD/60+) │      │  - Point-in-Polygon    │
└──────────────┬─────────┘      └───────────┬────────────┘      └───────────┬────────────┘
               │                            │                               │
               └────────────────────────────┼───────────────────────────────┘
                                            │
                                            ▼
                               ┌────────────────────────┐
                               │  4. EVACUATION SHELTER │
                               │     PERSISTENCE (DB)   │
                               │  - Max Capacity Limit  │
                               │  - Live Available Room │
                               │  - Amenity Verification│
                               │  - Transit Distance    │
                               └────────────┬───────────┘
                                            │
                                            ▼
                           ┌─────────────────────────────────┐
                           │   CENTRAL FUSION ORCHESTRATOR   │
                           │   - Predictive Timeline (Hours) │
                           │   - Dynamic "Reason / Cause"    │
                           │   - Carrying Capacity Deficit   │
                           │   - Mobilization Convoys Plan   │
                           └─────────────────────────────────┘
```

#### Stream 1: Ministry of Earth Sciences (MoES / IMD) Hazard Feed
- **Module**: `app/services/moes_weather.py` (`MoESHazardService`)
- **Telemetry Ingested**:
  - IMD 24-Hour Cumulative Rainfall Classification: Light (<15.5mm), Moderate (15.6–64.4mm), Heavy (64.5–115.5mm), Very Heavy (115.6–204.4mm), Extremely Heavy (>204.5mm).
  - IMD Cyclone & Wind Scale: Depression (32–49 km/h), Deep Depression (50–61 km/h), Cyclonic Storm (62–88 km/h), Severe/Super Cyclone (>89 km/h).
  - Major Upper Catchment Reservoir Telemetry: Real-time inflows and surplus discharge rates from Chembarambakkam Reservoir (Adyar Basin), Poondi Reservoir (Kosasthalaiyar Basin), Vaigai Dam, Mettur Dam (Kaveri Basin), and Pillur Dam.
- **Operational Output**:
  - Dynamically synthesizes the exact **Reason / Cause** string citing meteorological conditions and dam discharge volumes.
  - Computes the **Predictive Timeline** (hours to onset, e.g. 14h for Velachery flood, 8h for Coonoor mountain debris flow).

#### Stream 2: Indian Census Demographics Database
- **Module**: `app/services/census_demographics.py` (`CensusDemographicsEngine`) & SQLite `cad_disaster.db`
- **Granular Attributes Tracked**:
  - Baseline population & household enumeration counts per village/ward.
  - Population density per square kilometer.
  - Housing structure distribution: Permanent/Pucca %, Semi-Permanent %, and Temporary Kutcha/Thatch % (with structural collapse vulnerability ratings).
  - Vulnerability index metrics: Breakdowns of elderly (60+), children (<5), differently-abled (PwD), chronic medical cases, and pregnant women.
- **Operational Output**:
  - Computes exact estimated affected victim counts ($EST.\ X,XXX\ People$).
  - Produces formatted demographic audit strings for decision-makers.

#### Stream 3: Geospatial Gazetteer & Administrative Boundaries
- **Module**: `app/geocoding.py`
- **Spatial Features**:
  - Tamil Nadu statewide gazetteer of institutions, transport hubs, hospitals, and coordinates.
  - District grid boundaries (`TN_DISTRICT_BOUNDS`) and ray-casting point-in-polygon algorithm (`is_point_in_polygon`).
  - Census village and block administrative sector GeoJSON generator (`get_census_boundaries_geojson`).
- **Operational Output**:
  - Provides smooth multi-polygon boundaries for Leaflet GIS tactical overlays and heatmaps.

#### Stream 4: Evacuation Shelters Infrastructure & Persistence
- **Module**: `app/database.py` (`cad_disaster.db`)
- **Key Attributes**:
  - Shelter Name and ID (e.g. `Shelter S-9 (Guru Nanak Relief Center)`, `Shelter S-10 (St. Bede's State Disaster Camp)`, `Shelter S-3`, etc.).
  - Maximum capacity limits.
  - Real-time open / available headroom slots.
  - Emergency amenities (medical post, backup generator, community kitchen, clean water, warming stations).
- **Operational Output**:
  - Powers the **Primary Relocation Destinations** widget and guarantees evacuation routing matches verified shelter capacity.

---

### 2. Central Data Fusion Pipeline (`app/services/data_fusion.py`)

The `DataFusionEngine` unifies all four data streams on demand and serves the frontend via structured REST endpoints:

- `GET /api/strategic/zone-insight` (Default view: Velachery `ZN-44B`)
- `GET /api/strategic/zone-insight/{zone_id}` (Query by `HAB-VEL-01`, `ZN-44B`, `velachery`, `HAB-CUD-03`, `coonoor`, etc.)
- `GET /api/strategic/zone-insights` (All monitored sectors)
- `GET /api/geospatial/boundaries` (Administrative GeoJSON boundary polygons)
- `GET /api/habitations/carrying-capacity` (Carrying capacity reports)

#### Example Fused JSON Payload
```json
{
  "status": "SUCCESS",
  "zoneId": "ZN-44B",
  "zoneName": "THIRUVANAMADUR",
  "habitationId": "HAB-VEL-01",
  "fullName": "Velachery Lowland Settlement",
  "expectedOnset": "14 HOURS (Approx)",
  "expectedOnsetHours": 14.0,
  "riskIntensity": "CRITICAL",
  "intensityPercent": 92,
  "timelinePhase": "CRITICAL RELOCATION PHASE",
  "disaster": "Riverine Flood / Flash Flood Inundation",
  "cause": "IMD Red Alert: 345mm forecasted rainfall in 24hr cycle, compounded by 6,200 cusecs surplus discharge from Chembarambakkam Reservoir into Adyar River Basin.",
  "scale": "Widespread inundation of Habitations H-12, H-13, H-14 across low-lying drainage depressions.",
  "victims": "EST. 3,800 People",
  "victimsBreakdown": "Derived from Census: 940 Households • 620 Elderly • 940 Children • 85 Differently-Abled • 188 Kutcha Units",
  "currentDensity": 3000,
  "safeCapacity": 857,
  "pressureRatio": "3.5",
  "demoBreakdown": { "elderly": 620, "children": 940, "pwd": 85, "medical": 45 },
  "demoVulnerableCount": "1,740",
  "demoVulnerablePct": "41.4%",
  "shelterDestinations": [
    {
      "id": "SHL-CHN-01",
      "name": "Shelter S-9 (Guru Nanak Relief Center) (Capacity: 2,000, Open: 400)",
      "capacity": 2000,
      "current": 1600,
      "open": 400,
      "dist": "4.2 km"
    },
    {
      "id": "SHL-CHN-02",
      "name": "Shelter S-10 (St. Bede's State Disaster Camp) (Capacity: 1,800, Open: 280)",
      "capacity": 1800,
      "current": 1520,
      "open": 280,
      "dist": "5.8 km"
    }
  ],
  "shelterOccupancyText": "Shelter S-9: 680 / 3,800 Headroom",
  "shelterOccPercent": 82,
  "shelterAvailPercent": 18,
  "center": [12.9791, 80.2185],
  "convoys": "🚌 13 Heavy Buses | 🚑 6 Ambulances | 🚓 2 SDRF Escorts",
  "targetShelterId": "SHL-CHN-01",
  "evacueesCount": 3800
}
```

---

### 3. UI/UX Architecture & Clean Map Canvas

The frontend dashboard strictly adheres to the strategic MHA intelligence interface:
- **Zero Tactical Marker Clutter**: Zero point-pins, dot icons, or callout numbers (`ZN-*`) on the main map.
- **Smooth Gradient Heatmaps**: Statewide multi-color density heatmaps (Green safe zones $\rightarrow$ Amber high risk $\rightarrow$ Red critical zones).
- **Zero Canvas Popups / Modals**: Clicking anywhere on the map does not trigger obstructive white popups. All insights render cleanly in the dedicated right-hand predictive intelligence panel.
- **4-Tab Navigation Rail**:
  1. `ENGINE`: Background data fusion pipeline, real-time ingestion telemetry, and sync controls.
  2. `HAZARD ZONES`: Dynamic graded risk polygons, carrying capacity pressure, and primary relocation routes.
  3. `GEOLOGICAL`: Geotechnical soil moisture, liquefaction potential, and active fault line shear zones.
  4. `RELOCATION`: Comprehensive evacuation convoy plans and multi-shelter capacity headroom balancing.

---

### 4. Operational Relocation Protocol (SOP)

1. **Detection & Threshold Trigger**: IMD rainfall accumulation or reservoir surplus discharge breaches critical threshold.
2. **Carrying Capacity Stress Assessment**: Habitation population pressure exceeds $2.0\times$ safe threshold, flagging an immediate population deficit.
3. **Automated Shelter Matching**: Nearest operational shelters with verified available capacity are assigned.
4. **Logistics Fleet Computation**: Required heavy transport buses and ALS ambulances (calculated from PwD and chronic medical Census rosters) are mobilized.
5. **Convoy Dispatch Order**: With one click, the system commits the relocation order, logs the operation in SQLite, reserves shelter capacity, and broadcasts a real-time event to all connected terminals.

---

### 5. Resilient Offline Operation

AEGIS-GIS is architected to operate fully in disconnected disaster zones:
- Embedded deterministic heuristic triage rule engine.
- Local SQLite database (`cad_disaster.db`) using `aiosqlite`.
- Embedded Haversine routing and local gazetteer fallback.
- Client-side Leaflet.js and Chart.js rendering without mandatory cloud API tokens.
