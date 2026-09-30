import math
import uuid
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
import logging

from app.models import (
    Habitation, EvacuationShelter, RelocationPlanItem,
    RelocationPlanResponse, RelocationExecuteRequest
)
from app.database import (
    get_all_habitations, get_all_shelters, get_habitation_by_id,
    get_shelter_by_id, update_shelter_occupancy, update_habitation_status,
    save_relocation_plan, get_all_relocation_plans
)
from app.services.red_zone import haversine_distance_km
from app.services.capacity import CarryingCapacityService

logger = logging.getLogger("cad.relocation")


def generate_transit_waypoints(start_lat: float, start_lng: float, end_lat: float, end_lng: float, steps: int = 5) -> List[List[float]]:
    """Generates coordinate sequence [ [lat, lng], ... ] simulating the evacuation corridor"""
    waypoints = []
    for i in range(steps + 1):
        t = i / steps
        lat = round(start_lat + (end_lat - start_lat) * t, 5)
        lng = round(start_lng + (end_lng - start_lng) * t, 5)
        # Add slight corridor variation for intermediate points
        if 0 < i < steps:
            lat += round(math.sin(i * 1.5) * 0.0015, 5)
            lng += round(math.cos(i * 1.5) * 0.0015, 5)
        waypoints.append([lat, lng])
    return waypoints


class RelocationPlannerService:
    @staticmethod
    async def generate_relocation_plan() -> RelocationPlanResponse:
        """
        Synthesizes an immediate priority-ranked evacuation and relocation plan
        matching vulnerable habitations with closest operational shelters.
        """
        capacity_reports = await CarryingCapacityService.evaluate_habitations_capacity()
        habitations = await get_all_habitations()
        hab_dict = {h.id: h for h in habitations}
        
        shelters = await get_all_shelters()
        # Track dynamic remaining shelter capacities during allocation
        shelter_cap_tracker = {s.id: s.available_capacity for s in shelters}
        shelter_dict = {s.id: s for s in shelters}

        # Filter habitations requiring immediate relocation or pre-evacuation
        needing_evacuation = [
            r for r in capacity_reports
            if r.immediate_relocation_needed or r.risk_classification in ["CRITICAL_RED", "HIGH_ORANGE"]
        ]
        # Sort by composite vulnerability descending (highest priority first)
        needing_evacuation.sort(key=lambda x: x.composite_vulnerability_score, reverse=True)

        allocations: List[RelocationPlanItem] = []
        rank = 1

        for rep in needing_evacuation:
            hab = hab_dict.get(rep.habitation_id)
            if not hab:
                continue

            target_evacuees = hab.total_population
            vulnerable_count = hab.demographics.total_vulnerable or int(hab.total_population * 0.35)

            # Find closest shelter with available capacity
            candidate_shelters = []
            for s in shelters:
                dist = haversine_distance_km(hab.latitude, hab.longitude, s.latitude, s.longitude)
                remaining = shelter_cap_tracker.get(s.id, 0)
                candidate_shelters.append((dist, remaining, s))

            # Sort by distance
            candidate_shelters.sort(key=lambda x: x[0])

            # Select best shelter
            chosen_shelter = None
            chosen_dist = 5.0
            
            # First try shelter with positive remaining capacity
            for dist, remaining, s in candidate_shelters:
                if remaining > 0:
                    chosen_shelter = s
                    chosen_dist = dist
                    break

            # Fallback to closest shelter even if near capacity
            if not chosen_shelter and candidate_shelters:
                chosen_dist, _, chosen_shelter = candidate_shelters[0]

            if not chosen_shelter:
                continue

            # Deduct from tracker
            alloc_count = min(target_evacuees, shelter_cap_tracker.get(chosen_shelter.id, target_evacuees))
            if alloc_count <= 0:
                alloc_count = target_evacuees  # Emergency overflow allocation
            shelter_cap_tracker[chosen_shelter.id] = max(0, shelter_cap_tracker.get(chosen_shelter.id, 0) - alloc_count)

            # Convoy & Transport Requirements calculation
            buses_needed = max(1, math.ceil(alloc_count / 50.0))
            ambulances_needed = max(1, math.ceil((hab.demographics.critical_medical or 10) / 2.0))
            police_escorts = max(1, math.ceil(buses_needed / 4.0))
            boats = 2 if hab.terrain_type in ["COASTAL_LOWLAND", "RIVER_BASIN"] else 0

            convoy = {
                "heavy_buses": buses_needed,
                "ambulances": ambulances_needed,
                "police_escorts": police_escorts,
                "rescue_boats": boats,
                "total_vehicles": buses_needed + ambulances_needed + police_escorts + boats
            }

            # Distance & transit time estimation (allowing for disaster roadblocks)
            dist_km = round(chosen_dist, 2)
            transit_time = max(8, int(dist_km * 3.2))

            # Evacuation corridor route waypoints
            waypoints = generate_transit_waypoints(
                hab.latitude, hab.longitude, chosen_shelter.latitude, chosen_shelter.longitude
            )

            plan_item = RelocationPlanItem(
                plan_id=f"PLAN-{hab.id}-{chosen_shelter.id[:8]}",
                habitation_id=hab.id,
                habitation_name=hab.name,
                target_shelter_id=chosen_shelter.id,
                target_shelter_name=chosen_shelter.name,
                priority_rank=rank,
                evacuees_count=alloc_count,
                vulnerable_count=vulnerable_count,
                distance_km=dist_km,
                estimated_transit_time_min=transit_time,
                convoy_vehicles_needed=convoy,
                route_waypoints=waypoints,
                status="PENDING",
                timestamp=datetime.now(timezone.utc).isoformat()
            )
            allocations.append(plan_item)
            rank += 1

        total_needed = sum(a.evacuees_count for a in allocations)
        total_avail_shelter = sum(s.available_capacity for s in shelters)
        state_deficit = max(0, total_needed - total_avail_shelter)

        return RelocationPlanResponse(
            total_habitations_evaluated=len(capacity_reports),
            total_at_risk_population=sum(r.total_population for r in needing_evacuation),
            total_evacuation_needed=total_needed,
            total_available_shelter_capacity=total_avail_shelter,
            statewide_shelter_deficit=state_deficit,
            allocations=allocations,
            timestamp=datetime.now(timezone.utc).isoformat()
        )

    @staticmethod
    async def execute_relocation(req: RelocationExecuteRequest) -> Dict[str, Any]:
        """
        Executes an evacuation relocation order:
        Updates habitation status, increments shelter occupancy, logs plan.
        """
        hab = await get_habitation_by_id(req.habitation_id)
        shl = await get_shelter_by_id(req.shelter_id)

        if not hab:
            raise ValueError(f"Habitation {req.habitation_id} not found")
        if not shl:
            raise ValueError(f"Shelter {req.shelter_id} not found")

        evac_count = req.evacuees_count or hab.total_population

        # 1. Update Habitation status to CRITICAL_EVACUATION or RELOCATED
        new_hab_status = "RELOCATED" if evac_count >= hab.total_population else "CRITICAL_EVACUATION"
        await update_habitation_status(hab.id, new_hab_status)

        # 2. Update Shelter Occupancy (+evacuees)
        await update_shelter_occupancy(shl.id, evac_count)

        # 3. Create or update plan record
        plan_id = req.plan_id or f"EXEC-{hab.id}-{uuid.uuid4().hex[:6].upper()}"
        dist_km = round(haversine_distance_km(hab.latitude, hab.longitude, shl.latitude, shl.longitude), 2)
        waypoints = generate_transit_waypoints(hab.latitude, hab.longitude, shl.latitude, shl.longitude)
        
        plan_item = RelocationPlanItem(
            plan_id=plan_id,
            habitation_id=hab.id,
            habitation_name=hab.name,
            target_shelter_id=shl.id,
            target_shelter_name=shl.name,
            priority_rank=1,
            evacuees_count=evac_count,
            vulnerable_count=hab.demographics.total_vulnerable,
            distance_km=dist_km,
            estimated_transit_time_min=max(8, int(dist_km * 3.0)),
            convoy_vehicles_needed={
                "heavy_buses": max(1, math.ceil(evac_count / 50.0)),
                "ambulances": max(1, math.ceil((hab.demographics.critical_medical or 5) / 2.0)),
                "police_escorts": 2
            },
            route_waypoints=waypoints,
            status="MOBILIZING",
            timestamp=datetime.now(timezone.utc).isoformat()
        )
        await save_relocation_plan(plan_item)

        return {
            "status": "SUCCESS",
            "message": f"Immediate relocation executed for {hab.name} -> {shl.name}",
            "plan": plan_item.model_dump(),
            "habitation": {
                "id": hab.id,
                "name": hab.name,
                "new_status": new_hab_status
            },
            "shelter": {
                "id": shl.id,
                "name": shl.name,
                "evacuees_received": evac_count
            }
        }
