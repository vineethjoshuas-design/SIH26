import math
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone

from app.models import Habitation, EvacuationShelter, HabitationCapacityReport
from app.database import get_all_habitations, get_all_shelters
from app.services.red_zone import haversine_distance_km, RedZoneEngine


class CarryingCapacityService:
    @staticmethod
    async def evaluate_habitations_capacity() -> List[HabitationCapacityReport]:
        """
        Computes carrying capacity threshold stress, environmental vulnerability,
        and immediate shelter deficit for all vulnerable habitations in Tamil Nadu.
        """
        habitations = await get_all_habitations()
        shelters = await get_all_shelters()
        red_zones = await RedZoneEngine.evaluate_red_zones()
        rz_map = {rz.affected_habitation_ids[0]: rz for rz in red_zones if rz.affected_habitation_ids}

        reports: List[HabitationCapacityReport] = []

        for hab in habitations:
            # 1. Population Pressure on Emergency Carrying Capacity
            cap_threshold = max(1, hab.carrying_capacity_threshold)
            pressure_ratio = round(hab.total_population / cap_threshold, 2)

            # 2. Extract Hazard Severity from Red Zone engine
            rz = rz_map.get(hab.id)
            hazard_index = rz.severity_index if rz else 50.0

            # 3. Demographics Vulnerability Ratio
            vulnerable_count = hab.demographics.total_vulnerable
            if vulnerable_count == 0:
                vulnerable_count = int(hab.total_population * 0.35)
            vuln_ratio = min(1.0, vulnerable_count / max(1, hab.total_population))

            # 4. Composite Vulnerability Score (0 - 100)
            # Weighted: 40% Hazard Index + 35% Capacity Stress + 25% Demographic Fragility
            stress_component = min(100.0, pressure_ratio * 25.0)
            composite_score = round(
                (0.40 * hazard_index) + (0.35 * stress_component) + (0.25 * (vuln_ratio * 100.0)),
                1
            )
            composite_score = min(100.0, max(10.0, composite_score))

            # 5. Risk Classification
            if composite_score >= 70.0:
                risk_tier = "CRITICAL_RED"
            elif composite_score >= 50.0:
                risk_tier = "HIGH_ORANGE"
            elif composite_score >= 35.0:
                risk_tier = "MODERATE_YELLOW"
            else:
                risk_tier = "LOW_GREEN"

            # 6. Find Closest Safe Evacuation Shelter
            closest_shelter: Optional[EvacuationShelter] = None
            min_dist = float("inf")
            for shl in shelters:
                dist = haversine_distance_km(hab.latitude, hab.longitude, shl.latitude, shl.longitude)
                if dist < min_dist:
                    min_dist = dist
                    closest_shelter = shl

            # 7. Evaluate Local Shelter Deficit
            available_cap = closest_shelter.available_capacity if closest_shelter else 0
            shelter_deficit = max(0, hab.total_population - available_cap)
            
            # Need relocation if severely over capacity threshold and high risk
            immediate_relocation = (
                composite_score >= 60.0 or
                hab.status in ["CRITICAL_EVACUATION", "AT_RISK"] or
                pressure_ratio >= 2.5
            )

            reports.append(HabitationCapacityReport(
                habitation_id=hab.id,
                habitation_name=hab.name,
                district=hab.district,
                total_population=hab.total_population,
                vulnerable_population=vulnerable_count,
                capacity_threshold=cap_threshold,
                current_population_pressure=pressure_ratio,
                terrain_hazard_index=hazard_index,
                composite_vulnerability_score=composite_score,
                risk_classification=risk_tier,
                status=hab.status,
                nearest_shelter_id=closest_shelter.id if closest_shelter else None,
                nearest_shelter_name=closest_shelter.name if closest_shelter else None,
                nearest_shelter_distance_km=round(min_dist, 2) if closest_shelter else None,
                shelter_deficit=shelter_deficit,
                immediate_relocation_needed=immediate_relocation
            ))

        # Sort highest composite vulnerability first
        reports.sort(key=lambda r: r.composite_vulnerability_score, reverse=True)
        return reports

    @staticmethod
    async def get_summary_metrics() -> Dict[str, Any]:
        """Provides high-level dashboard telemetry for carrying capacity deficit"""
        reports = await CarryingCapacityService.evaluate_habitations_capacity()
        shelters = await get_all_shelters()

        total_population = sum(r.total_population for r in reports)
        total_vulnerable = sum(r.vulnerable_population for r in reports)
        at_risk_count = sum(1 for r in reports if r.immediate_relocation_needed)
        total_shelter_cap = sum(s.max_capacity for s in shelters)
        current_occupied = sum(s.current_occupancy for s in shelters)
        total_avail_shelter = sum(s.available_capacity for s in shelters)
        statewide_deficit = max(0, sum(r.shelter_deficit for r in reports if r.immediate_relocation_needed))

        return {
            "total_habitations": len(reports),
            "total_population": total_population,
            "total_vulnerable": total_vulnerable,
            "habitations_at_risk": at_risk_count,
            "total_shelter_capacity": total_shelter_cap,
            "current_shelter_occupancy": current_occupied,
            "available_shelter_capacity": total_avail_shelter,
            "statewide_shelter_deficit": statewide_deficit,
            "reports": [r.model_dump() for r in reports]
        }
