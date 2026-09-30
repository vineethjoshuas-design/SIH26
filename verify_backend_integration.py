import urllib.request
import json
import sys

endpoints = [
    ("/api/strategic/zone-insight", "Strategic Zone Insight Default"),
    ("/api/strategic/zone-insight/HAB-VEL-01", "Strategic Zone Insight Velachery"),
    ("/api/strategic/zone-insight/ZN-44B", "Strategic Zone Insight ZN-44B"),
    ("/api/strategic/zone-insight/HAB-CUD-03", "Strategic Zone Insight Cuddalore"),
    ("/api/strategic/zone-insight/HAB-NIL-04", "Strategic Zone Insight Coonoor"),
    ("/api/strategic/zone-insights", "All Strategic Zone Insights"),
    ("/api/geospatial/boundaries", "Geospatial Administrative Boundaries GeoJSON"),
    ("/api/moes/hazard-telemetry", "MoES Hazard Telemetry"),
    ("/api/census/demographics", "Indian Census Demographics Summary"),
    ("/api/census/demographics/HAB-VEL-01", "Census Habitation Demographics"),
    ("/api/habitations/carrying-capacity", "Habitations Carrying Capacity"),
    ("/api/shelters", "Evacuation Shelters Persistence")
]

passed = 0
failed = 0

print("=" * 70)
print("SIH26191 BACKEND DATA INTEGRATION & FUSION VERIFICATION")
print("=" * 70)

for path, desc in endpoints:
    url = f"http://localhost:8000{path}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "BackendIntegrationTest/1.0"})
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            status = resp.status
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            if status == 200:
                count_str = f"{len(data)} items" if isinstance(data, (list, dict)) else "valid"
                print(f"[PASS] {status} OK | {desc:45} | {count_str}")
                passed += 1
            else:
                print(f"[FAIL] {status}    | {desc:45} | Unexpected status")
                failed += 1
    except Exception as e:
        print(f"[FAIL] ERR   | {desc:45} | {e}")
        failed += 1

print("-" * 70)
print(f"Results: {passed} PASSED, {failed} FAILED out of {len(endpoints)} checks")
print("=" * 70)

if failed > 0:
    sys.exit(1)
