import math
import uuid
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
import logging

from app.models import RedZonePolygon, Habitation
from app.database import get_all_habitations, get_incidents
from app.services.realtime_feed import TamilNaduRealtimeCollector
from app.services.moes_weather import MoESHazardService
from app.services.census_demographics import CensusDemographicsEngine

logger = logging.getLogger("cad.red_zone")

def haversine_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(dlon / 2) ** 2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def generate_circle_polygon(center_lat: float, center_lng: float, radius_meters: float, num_points: int = 16) -> List[List[float]]:
    """Generates coordinates array [ [lng, lat], ... ] for GeoJSON Polygon"""
    coords = []
    r_lat = radius_meters / 111320.0
    r_lng = radius_meters / (111320.0 * math.cos(math.radians(center_lat)))
    
    for i in range(num_points):
        angle = (2 * math.pi * i) / num_points
        d_lat = r_lat * math.sin(angle)
        d_lng = r_lng * math.cos(angle)
        coords.append([round(center_lng + d_lng, 6), round(center_lat + d_lat, 6)])
    coords.append(coords[0])  # Close polygon
    return coords


class RedZoneEngine:
    @staticmethod
    async def evaluate_red_zones() -> List[RedZonePolygon]:
        """
        Delineates real-time hazard-based Red Zones across Tamil Nadu.
        Merges MoES / IMD weather thresholds, upper catchment hydro-telemetry,
        Indian Census demographics, active incidents, and habitation terrain risk.
        """
        habitations = await get_all_habitations()
        incidents = await get_incidents()
        
        # Fetch live meteorological conditions
        try:
            weather_data = await TamilNaduRealtimeCollector.get_statewide_telemetry()
            station_reports = {
                r.get("district"): r.get("telemetry", {})
                for r in weather_data.get("station_reports", [])
            }
        except Exception as e:
            logger.warning(f"Error fetching live weather telemetry: {e}")
            station_reports = {}

        red_zones: List[RedZonePolygon] = []

        for hab in habitations:
            # 1. District Weather Component
            wx = station_reports.get(hab.district, {})
            rain_mm = wx.get("precipitation_mm", 0.0)
            wind_kmh = wx.get("wind_gust_kmh", 15.0)

            # MoES Hazard & Catchment Hydrology calculation
            moes_hazard = MoESHazardService.calculate_hazard_onset(
                district=hab.district,
                habitation_id=hab.id,
                terrain_type=hab.terrain_type,
                precip_mm_24h=rain_mm,
                wind_gust_kmh=wind_kmh,
                elevation_m=hab.elevation_m
            )

            # Indian Census Demographics Profile
            census_prof = CensusDemographicsEngine.get_habitation_profile(hab.id)
            kutcha_pct = census_prof["housing_structures"]["temporary_kutcha_pct"] if census_prof else 20.0
            density_val = census_prof["population_density_per_sq_km"] if census_prof else (hab.total_population / max(0.5, hab.area_sq_km))
            
            # Weather risk factor weighted by IMD thresholds
            sim_precip = moes_hazard["simulated_rainfall_mm"]
            weather_score = min(100.0, (sim_precip * 0.28) + (wind_kmh * 0.35))

            # 2. Terrain & Inundation Factor with Housing Structure Vulnerability
            structural_vulnerability = (kutcha_pct / 100.0) * 25.0  # Kutcha mud houses collapse in flood

            if hab.terrain_type == "HILL_SLOPE":
                terrain_score = (hab.landslide_risk_factor * 75.0) + (hab.flood_risk_factor * 10.0) + structural_vulnerability
                hazard_type = "LANDSLIDE"
            elif hab.terrain_type == "COASTAL_LOWLAND":
                terrain_score = (hab.flood_risk_factor * 65.0) + max(0.0, (10.0 - hab.elevation_m) * 2.5) + structural_vulnerability
                hazard_type = "COASTAL_SURGE" if hab.elevation_m < 3.0 else "INUNDATION"
            elif hab.terrain_type == "RIVER_BASIN":
                terrain_score = (hab.flood_risk_factor * 70.0) + max(0.0, (8.0 - (hab.elevation_m % 10)) * 1.5) + structural_vulnerability
                hazard_type = "FLASH_FLOOD"
            else:
                terrain_score = (hab.flood_risk_factor * 55.0) + (hab.current_density_score * 6.0) + structural_vulnerability
                hazard_type = "MULTI_HAZARD"

            terrain_score = min(100.0, max(15.0, terrain_score))

            # 3. Active Incident Density & Urgency Component within 5 km
            nearby_incidents = [
                inc for inc in incidents
                if haversine_distance_km(hab.latitude, hab.longitude, inc.latitude, inc.longitude) <= 5.0
            ]
            
            incident_score = 0.0
            if nearby_incidents:
                max_urgency = max(inc.urgency_score for inc in nearby_incidents)
                incident_score = min(100.0, (len(nearby_incidents) * 20.0) + (max_urgency * 0.6))
            else:
                if hab.status == "CRITICAL_EVACUATION":
                    incident_score = 70.0
                elif hab.status == "AT_RISK":
                    incident_score = 50.0

            # Composite Multi-Hazard Severity Index (0 - 100)
            composite_severity = (0.35 * weather_score) + (0.35 * terrain_score) + (0.30 * incident_score)
            composite_severity = round(min(100.0, max(10.0, composite_severity)), 1)

            # Classify Risk Tier
            if composite_severity >= 70.0:
                risk_level = "CRITICAL_RED"
                action = f"IMMEDIATE EVACUATION MANDATED: {moes_hazard['recommended_measures']}"
                radius_m = 2200.0
            elif composite_severity >= 50.0:
                risk_level = "HIGH_ORANGE"
                action = "PRE-EVACUATION ADVISORY: Mobilize community shelters and early warning."
                radius_m = 1800.0
            elif composite_severity >= 30.0:
                risk_level = "MODERATE_YELLOW"
                action = "STANDBY ALERT: Continuous sensor telemetry and drain clearance."
                radius_m = 1400.0
            else:
                risk_level = "LOW_GREEN"
                action = "ROUTINE MONITORING: Normal conditions."
                radius_m = 1000.0

            poly_coords = generate_circle_polygon(hab.latitude, hab.longitude, radius_m)
            geojson_feature = {
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [poly_coords]
                },
                "properties": {
                    "habitation_id": hab.id,
                    "habitation_name": hab.name,
                    "severity_index": composite_severity,
                    "risk_level": risk_level,
                    "hazard_type": hazard_type,
                    "moes_hazard": moes_hazard,
                    "census_profile": census_prof,
                    "population_density_per_sq_km": density_val
                }
            }

            rz = RedZonePolygon(
                id=f"RZ-{hab.id}",
                name=f"{hab.name} Red Zone Corridor",
                district=hab.district,
                hazard_type=hazard_type,
                risk_level=risk_level,
                severity_index=composite_severity,
                center_lat=hab.latitude,
                center_lng=hab.longitude,
                radius_meters=radius_m,
                boundary_geojson=geojson_feature,
                contributing_factors={
                    "rainfall_mm_hr": rain_mm,
                    "simulated_rainfall_mm_24h": sim_precip,
                    "wind_gust_kmh": wind_kmh,
                    "terrain_factor": round(terrain_score, 1),
                    "nearby_incident_count": len(nearby_incidents),
                    "elevation_m": hab.elevation_m,
                    "moes_disaster_type": moes_hazard["disaster_type"],
                    "moes_reason_cause": moes_hazard["meteorological_reason"],
                    "moes_expected_onset": moes_hazard["expected_onset_str"],
                    "census_density_per_sq_km": density_val,
                    "kutcha_housing_pct": kutcha_pct
                },
                affected_habitation_ids=[hab.id],
                total_people_at_risk=hab.total_population if risk_level in ["CRITICAL_RED", "HIGH_ORANGE"] else int(hab.total_population * 0.4),
                recommended_action=action,
                updated_at=datetime.now(timezone.utc).isoformat()
            )
            red_zones.append(rz)

        # Sort with most critical first
        red_zones.sort(key=lambda x: x.severity_index, reverse=True)
        return red_zones

    @staticmethod
    async def get_geojson_collection() -> Dict[str, Any]:
        """Returns standard GeoJSON FeatureCollection for Leaflet map overlay"""
        zones = await RedZoneEngine.evaluate_red_zones()
        features = [z.boundary_geojson for z in zones if z.boundary_geojson]
        return {
            "type": "FeatureCollection",
            "features": features
        }
