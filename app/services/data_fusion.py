"""
Central Multi-Source Data Fusion & Orchestration Pipeline (SIH26191)

Fuses 4 primary intelligence streams:
1. Ministry of Earth Sciences (MoES / IMD) Hydro-Meteorological Hazard Feed
2. Indian Census Demographics & Vulnerability Enumeration Database
3. Geospatial Gazetteer & Administrative Boundaries Engine
4. Evacuation Shelters Infrastructure & Headroom Persistence Engine

Outputs unified, structured intelligence payloads for frontend endpoints:
- GET /api/strategic/zone-insight
- GET /api/strategic/zone-insight/{zone_id}
- GET /api/habitations/carrying-capacity
"""

import math
import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timezone

from app.database import (
    get_all_habitations, get_habitation_by_id,
    get_all_shelters, get_shelter_by_id
)
from app.services.moes_weather import MoESHazardService
from app.services.census_demographics import CensusDemographicsEngine, CENSUS_HABITATION_PROFILES
from app.geocoding import check_spatial_boundary, calcDistanceKm

logger = logging.getLogger("cad.data_fusion")

# Canonical zone cross-reference mapping (Habitation ID <-> Strategic Red Zone ID)
ZONE_METADATA_REGISTRY = {
    "HAB-VEL-01": {
        "zone_id": "ZN-44B",
        "zone_name": "THIRUVANAMADUR",
        "alias_keys": ["hab-vel-01", "zn-44b", "velachery", "thiruvanamadur", "vel"],
        "default_shelter_ids": ["SHL-CHN-01", "SHL-CHN-02"]
    },
    "HAB-ENN-02": {
        "zone_id": "ZN-12A",
        "zone_name": "ENNORE CREEK",
        "alias_keys": ["hab-enn-02", "zn-12a", "ennore", "ennore creek", "enn"],
        "default_shelter_ids": ["SHL-CHN-03", "SHL-CHN-02"]
    },
    "HAB-CUD-03": {
        "zone_id": "ZN-08C",
        "zone_name": "CUDDALORE OLD TOWN",
        "alias_keys": ["hab-cud-03", "zn-08c", "cuddalore", "devanampattinam", "cud"],
        "default_shelter_ids": ["SHL-CUD-01"]
    },
    "HAB-NIL-04": {
        "zone_id": "ZN-04D",
        "zone_name": "COONOOR HILL SLOPES",
        "alias_keys": ["hab-nil-04", "zn-04d", "coonoor", "nilgiris", "nil"],
        "default_shelter_ids": ["SHL-NIL-01"]
    },
    "HAB-MDU-05": {
        "zone_id": "ZN-19E",
        "zone_name": "MADURAI VAIGAI",
        "alias_keys": ["hab-mdu-05", "zn-19e", "madurai", "vaigai", "mdu"],
        "default_shelter_ids": ["SHL-MDU-01"]
    },
    "HAB-THO-06": {
        "zone_id": "ZN-22F",
        "zone_name": "THOOTHUKUDI HARBOUR",
        "alias_keys": ["hab-tho-06", "zn-22f", "thoothukudi", "tuticorin", "tho"],
        "default_shelter_ids": ["SHL-THO-01"]
    },
    "HAB-PER-07": {
        "zone_id": "ZN-31G",
        "zone_name": "PERUNGUDI BASIN",
        "alias_keys": ["hab-per-07", "zn-31g", "perungudi", "pallikaranai", "per"],
        "default_shelter_ids": ["SHL-CHN-01"]
    },
    "HAB-TRC-08": {
        "zone_id": "ZN-15H",
        "zone_name": "SRIRANGAM KAVERI",
        "alias_keys": ["hab-trc-08", "zn-15h", "srirangam", "trichy", "tiruchirappalli", "trc"],
        "default_shelter_ids": ["SHL-TRC-01"]
    }
}


class DataFusionEngine:
    """
    Central Orchestration Pipeline fusing:
    IMD Meteorological Telemetry + Indian Census Demographics + GIS Boundaries + Evacuation Shelters.
    """

    @staticmethod
    def resolve_habitation_id(query_id: str) -> str:
        """Resolves zone aliases (e.g. 'ZN-44B' or 'velachery') to canonical habitation ID."""
        if not query_id:
            return "HAB-VEL-01"
        q = query_id.lower().strip()
        for hid, meta in ZONE_METADATA_REGISTRY.items():
            if q == hid.lower() or q == meta["zone_id"].lower() or any(k in q for k in meta["alias_keys"]):
                return hid
        return "HAB-VEL-01"

    @staticmethod
    async def fuse_zone_insight(zone_query: str = "HAB-VEL-01") -> Dict[str, Any]:
        """
        Main fusion function: synthesizes all 4 data streams for a strategic red zone.
        Outputs exact JSON payload powering the frontend right-hand insight panel.
        """
        canonical_hid = DataFusionEngine.resolve_habitation_id(zone_query)
        zone_meta = ZONE_METADATA_REGISTRY.get(canonical_hid, ZONE_METADATA_REGISTRY["HAB-VEL-01"])

        # Stream 1: SQLite Habitation Core Profile
        hab = await get_habitation_by_id(canonical_hid)
        lat = hab.latitude if hab else 12.9791
        lon = hab.longitude if hab else 80.2185
        district = hab.district if hab else "Chennai"
        full_name = hab.name if hab else "Velachery Lowland Settlement"
        terrain = hab.terrain_type if hab else "COASTAL_LOWLAND"
        elevation = hab.elevation_m if hab else 3.8

        # Stream 2: MoES / IMD Dynamic Weather Telemetry & Predictive Onset Timeline
        weather_insight = await MoESHazardService.get_zone_meteorological_insight(
            district=district,
            habitation_id=canonical_hid,
            terrain_type=terrain,
            elevation_m=elevation,
            lat=lat,
            lon=lon
        )

        # Stream 3: Indian Census Demographics, Housing Breakdown & Carrying Capacity
        census_data = await CensusDemographicsEngine.calculate_affected_victims_and_vulnerability(
            habitation_id=canonical_hid,
            hazard_severity=weather_insight.get("timeline_percent", 90) / 100.0
        )

        # Stream 4: Spatial Gazetteer & Administrative Sector Checks
        boundary_info = check_spatial_boundary(lat, lon)

        # Stream 5: Evacuation Shelters Persistence & Available Headroom
        all_shelters = await get_all_shelters()
        
        # Calculate distance to each shelter and sort
        scored_shelters = []
        for s in all_shelters:
            dist = round(calcDistanceKm(lat, lon, s.latitude, s.longitude), 1)
            scored_shelters.append({
                "id": s.id,
                "name": s.name,
                "district": s.district,
                "latitude": s.latitude,
                "longitude": s.longitude,
                "max_capacity": s.max_capacity,
                "current_occupancy": s.current_occupancy,
                "available_capacity": s.available_capacity,
                "distance_km": dist,
                "status": s.status
            })
        scored_shelters.sort(key=lambda x: x["distance_km"])

        # Filter target shelters matching zone configuration or nearest
        preferred_ids = zone_meta.get("default_shelter_ids", [])
        matched_destinations = [s for s in scored_shelters if s["id"] in preferred_ids]
        if not matched_destinations:
            matched_destinations = scored_shelters[:2]

        primary_shelter_list = []
        for sh in matched_destinations:
            primary_shelter_list.append({
                "id": sh["id"],
                "name": f"{sh['name']} (Capacity: {sh['max_capacity']:,}, Open: {sh['available_capacity']:,})",
                "raw_name": sh["name"],
                "capacity": sh["max_capacity"],
                "current": sh["current_occupancy"],
                "open": sh["available_capacity"],
                "dist": f"{sh['distance_km']} km",
                "status": sh["status"]
            })

        # Calculate shelter occupancy metrics
        tot_cap = sum(s["max_capacity"] for s in matched_destinations) or 2000
        tot_open = sum(s["available_capacity"] for s in matched_destinations) or 400
        tot_occ = sum(s["current_occupancy"] for s in matched_destinations) or (tot_cap - tot_open)
        occ_pct = max(5, min(95, int((tot_occ / tot_cap) * 100)))
        avail_pct = 100 - occ_pct

        primary_shelter = matched_destinations[0] if matched_destinations else scored_shelters[0]
        shelter_coords = [primary_shelter["latitude"], primary_shelter["longitude"]]
        target_shelter_id = primary_shelter["id"]

        # Evacuation logistics calculation
        evacuees_count = census_data["estimated_affected_victims"]
        buses_needed = max(3, math.ceil(evacuees_count / 300))
        ambulances_needed = max(2, math.ceil((census_data["demographic_breakdown"]["differently_abled"] + census_data["demographic_breakdown"]["critical_medical"]) / 25))
        escorts_needed = 2
        convoys_str = f"🚌 {buses_needed} Heavy Buses | 🚑 {ambulances_needed} Ambulances | 🚓 {escorts_needed} SDRF Escorts"

        # Construct fused response payload
        return {
            "status": "SUCCESS",
            "zoneId": zone_meta["zone_id"],
            "zoneName": zone_meta["zone_name"],
            "habitationId": canonical_hid,
            "fullName": full_name,
            "district": district,
            "administrativeBoundary": boundary_info,
            "expectedOnset": weather_insight["expected_onset_str"],
            "expectedOnsetHours": weather_insight["expected_onset_hours"],
            "riskIntensity": weather_insight["risk_intensity"],
            "intensityPercent": weather_insight["timeline_percent"],
            "timelinePhase": weather_insight["timeline_phase"],
            "disaster": weather_insight["disaster_type"],
            "cause": weather_insight["meteorological_reason"],
            "scale": weather_insight["predicted_scale"],
            "victims": census_data["victims_label"],
            "victimsCount": evacuees_count,
            "victimsBreakdown": census_data["victims_breakdown"],
            "measures": weather_insight["recommended_measures"],
            "currentDensity": census_data["population_density_per_sq_km"],
            "safeCapacity": census_data["safe_density_limit"],
            "pressureRatio": str(census_data["carrying_capacity"].get("capacity_pressure_ratio", "3.5")),
            "demoBreakdown": {
                "elderly": census_data["demographic_breakdown"]["elderly"],
                "children": census_data["demographic_breakdown"]["children"],
                "pwd": census_data["demographic_breakdown"]["differently_abled"],
                "medical": census_data["demographic_breakdown"]["critical_medical"]
            },
            "demoVulnerableCount": census_data["total_vulnerable_count"],
            "demoVulnerablePct": census_data["total_vulnerable_pct"],
            "housingDistribution": census_data["housing_distribution"],
            "shelterDestinations": primary_shelter_list,
            "shelterOccupancyText": f"{primary_shelter['name'].split('(')[0].strip()}: {tot_open:,} / {tot_cap:,} Headroom",
            "shelterOccPercent": occ_pct,
            "shelterAvailPercent": avail_pct,
            "center": [lat, lon],
            "shelterCoords": shelter_coords,
            "convoys": convoys_str,
            "targetShelterId": target_shelter_id,
            "evacueesCount": evacuees_count,
            "fusedAt": datetime.now(timezone.utc).isoformat()
        }

    @staticmethod
    async def fuse_all_zone_insights() -> List[Dict[str, Any]]:
        """Synthesizes insights for all active monitored zones."""
        results = []
        for hid in ZONE_METADATA_REGISTRY.keys():
            insight = await DataFusionEngine.fuse_zone_insight(hid)
            results.append(insight)
        return results

    @staticmethod
    async def fuse_carrying_capacity_reports() -> List[Dict[str, Any]]:
        """
        Calculates Carrying Capacity & Vulnerability reports across all habitations,
        fusing Census density and shelter headroom.
        """
        habitations = await get_all_habitations()
        shelters = await get_all_shelters()

        total_shelter_avail = sum(s.available_capacity for s in shelters)

        reports = []
        for h in habitations:
            prof = await CensusDemographicsEngine.query_habitation_census_by_id(h.id)
            pop = h.total_population
            safe_thresh = h.carrying_capacity_threshold or 1000
            density_score = h.current_density_score or round(pop / safe_thresh, 2)
            pop_deficit = max(0, pop - safe_thresh)

            # Shelter allocation
            assigned_capacity = min(pop_deficit, total_shelter_avail)
            deficit = max(0, pop_deficit - assigned_capacity)

            reports.append({
                "habitation_id": h.id,
                "habitation_name": h.name,
                "district": h.district,
                "current_population": pop,
                "safe_threshold": safe_thresh,
                "carrying_capacity_pressure_ratio": density_score,
                "population_deficit": pop_deficit,
                "shelter_headroom_assigned": assigned_capacity,
                "net_relocation_deficit": deficit,
                "vulnerability_metrics": prof["demographics"] if prof else {},
                "housing_structures": prof["housing_structures"] if prof else {},
                "status": "CRITICAL_OVER_CAPACITY" if density_score > 2.5 else "HIGH_CAPACITY",
                "evaluated_at": datetime.now(timezone.utc).isoformat()
            })

        return reports
