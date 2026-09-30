import pytest
from fastapi.testclient import TestClient
from app.server import app


def test_sih26191_habitations_and_shelters():
    with TestClient(app) as client:
        # 1. Test GET /api/habitations
        hab_res = client.get("/api/habitations")
        assert hab_res.status_code == 200
        habitations = hab_res.json()
        assert len(habitations) >= 5
        
        first_hab = habitations[0]
        assert "id" in first_hab
        assert "name" in first_hab
        assert "total_population" in first_hab
        assert "carrying_capacity_threshold" in first_hab
        assert "demographics" in first_hab
        assert "total_vulnerable" in first_hab["demographics"]

        # 2. Test GET /api/habitations/{id}
        hab_id = first_hab["id"]
        detail_res = client.get(f"/api/habitations/{hab_id}")
        assert detail_res.status_code == 200
        assert detail_res.json()["id"] == hab_id

        # 3. Test GET /api/shelters
        shl_res = client.get("/api/shelters")
        assert shl_res.status_code == 200
        shelters = shl_res.json()
        assert len(shelters) >= 4
        
        first_shl = shelters[0]
        assert "max_capacity" in first_shl
        assert "available_capacity" in first_shl
        assert "amenities" in first_shl


def test_sih26191_hazard_red_zones():
    with TestClient(app) as client:
        # 1. Test GET /api/red-zones
        rz_res = client.get("/api/red-zones")
        assert rz_res.status_code == 200
        red_zones = rz_res.json()
        assert len(red_zones) >= 4
        
        first_rz = red_zones[0]
        assert "severity_index" in first_rz
        assert 0.0 <= first_rz["severity_index"] <= 100.0
        assert first_rz["risk_level"] in ["CRITICAL_RED", "HIGH_ORANGE", "MODERATE_YELLOW", "LOW_GREEN"]
        assert "center_lat" in first_rz and "center_lng" in first_rz
        assert "contributing_factors" in first_rz

        # 2. Test GeoJSON format endpoint
        geo_res = client.get("/api/red-zones/geojson")
        assert geo_res.status_code == 200
        geojson = geo_res.json()
        assert geojson["type"] == "FeatureCollection"
        assert len(geojson["features"]) >= 4
        assert geojson["features"][0]["geometry"]["type"] == "Polygon"


def test_sih26191_carrying_capacity_assessment():
    with TestClient(app) as client:
        # 1. Test GET /api/habitations/carrying-capacity
        cap_res = client.get("/api/habitations/carrying-capacity")
        assert cap_res.status_code == 200
        reports = cap_res.json()
        assert len(reports) >= 5
        
        r0 = reports[0]
        assert "current_population_pressure" in r0
        assert "composite_vulnerability_score" in r0
        assert "nearest_shelter_id" in r0
        assert "immediate_relocation_needed" in r0

        # 2. Test GET /api/habitations/carrying-capacity/summary
        sum_res = client.get("/api/habitations/carrying-capacity/summary")
        assert sum_res.status_code == 200
        summary = sum_res.json()
        assert summary["total_habitations"] >= 5
        assert summary["total_population"] > 0
        assert summary["total_shelter_capacity"] > 0
        assert "statewide_shelter_deficit" in summary


def test_sih26191_relocation_planner_and_execution():
    with TestClient(app) as client:
        # 1. Test GET /api/relocation/plan
        plan_res = client.get("/api/relocation/plan")
        assert plan_res.status_code == 200
        plan = plan_res.json()
        assert "allocations" in plan
        assert len(plan["allocations"]) > 0
        
        first_alloc = plan["allocations"][0]
        assert first_alloc["priority_rank"] == 1
        assert first_alloc["evacuees_count"] > 0
        assert first_alloc["convoy_vehicles_needed"]["heavy_buses"] >= 1
        assert len(first_alloc["route_waypoints"]) >= 2

        # 2. Test POST /api/relocation/execute
        exec_payload = {
            "habitation_id": first_alloc["habitation_id"],
            "shelter_id": first_alloc["target_shelter_id"],
            "evacuees_count": 250,
            "notes": "Testing tactical convoy deployment"
        }
        exec_res = client.post("/api/relocation/execute", json=exec_payload)
        assert exec_res.status_code == 200
        data = exec_res.json()
        assert data["status"] == "SUCCESS"
        assert data["shelter"]["evacuees_received"] == 250
        assert data["habitation"]["new_status"] in ["CRITICAL_EVACUATION", "RELOCATED"]
