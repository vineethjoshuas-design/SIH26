from typing import Optional, List, Literal
from pydantic import BaseModel, Field
from datetime import datetime, timezone
import uuid

DisasterType = Literal[
    "INDUSTRIAL",
    "FIRE",
    "FLOOD",
    "EARTHQUAKE",
    "CYCLONE",
    "STRUCTURAL_COLLAPSE",
    "OTHER"
]

SeverityLevel = Literal["CRITICAL", "HIGH", "MODERATE", "LOW"]

IncidentStatus = Literal[
    "PENDING",
    "TRIAGED",
    "DISPATCHED",
    "ACCEPTED",
    "EN_ROUTE",
    "ON_SCENE",
    "ASSISTANCE_REQUIRED",
    "SITUATION_UNDER_CONTROL",
    "RESOLVED"
]

class VictimProfile(BaseModel):
    id: str = Field(default_factory=lambda: f"VIC-{uuid.uuid4().hex[:6].upper()}")
    name: str = "Unknown Individual"
    category: Literal["RED", "YELLOW", "GREEN", "BLACK"] = "RED"
    notes: Optional[str] = ""
    rescued: bool = False
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class VictimSubmitRequest(BaseModel):
    name: str = "Unknown Individual"
    category: Literal["RED", "YELLOW", "GREEN", "BLACK"] = "RED"
    notes: Optional[str] = ""
    rescued: bool = False

UnitType = Literal[
    "NDRF_RESCUE",
    "FIRE_ENGINE",
    "AMBULANCE_ALS",
    "POLICE_PATROL",
    "BOAT_RESCUE",
    "DRONE_RECON",
    "SDRF_QUICK_RESPONSE"
]

UnitStatus = Literal["AVAILABLE", "DISPATCHED", "ON_SCENE", "MAINTENANCE"]

class AffectedPeople(BaseModel):
    injured: int = Field(default=0, ge=0)
    trapped: int = Field(default=0, ge=0)
    evacuated: int = Field(default=0, ge=0)
    totalEstimated: int = Field(default=0, ge=0)

class CADIncidentData(BaseModel):
    title: str
    type: DisasterType
    severity: SeverityLevel
    urgencyScore: int = Field(..., ge=0, le=100)
    locationName: str
    affectedPeople: AffectedPeople
    casualtySummary: str
    actionableNotes: str

class TriageResult(BaseModel):
    is_relevant: bool
    confidence_score: float = Field(..., ge=0.0, le=1.0)
    incident: Optional[CADIncidentData] = None
    rejection_reason: Optional[str] = None
    is_out_of_jurisdiction: bool = False
    jurisdiction_warning: Optional[str] = None

class IncidentRecord(BaseModel):
    id: str = Field(default_factory=lambda: f"INC-{uuid.uuid4().hex[:8].upper()}")
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    raw_text: str = ""
    channel: str = "WEB_CAD"
    metadata_info: Optional[str] = None
    is_relevant: bool = True
    confidence_score: float = 0.95
    rejection_reason: Optional[str] = None
    is_out_of_jurisdiction: bool = False
    jurisdiction_warning: Optional[str] = None
    source_url: Optional[str] = None
    author_handle: Optional[str] = None
    channel_icon: Optional[str] = None
    
    # Parsed CAD Fields matching exact schema
    title: str = "Unnamed Disaster Incident"
    type: DisasterType = "OTHER"
    severity: SeverityLevel = "MODERATE"
    currentStatus: str = "REPORTED"
    status: IncidentStatus = "PENDING"
    locationName: str = "Unknown Location"
    location_name: str = "Unknown Location"
    latitude: float = 13.0827
    longitude: float = 80.2707
    coordinates: dict = Field(default_factory=lambda: {"lat": 13.0827, "lng": 80.2707})
    urgencyScore: int = 50
    urgency_score: int = 50
    sosAlertsCount: int = 1
    sos_alerts_count: int = 1
    affectedPeople: AffectedPeople = Field(default_factory=AffectedPeople)
    affected_injured: int = 0
    affected_trapped: int = 0
    affected_evacuated: int = 0
    affected_total: int = 0
    casualty_summary: str = "None reported"
    actionable_notes: str = "Immediate reconnaissance recommended"
    accessRoutes: str = "Primary evacuation corridor cleared. Heavy vehicle access via Main Arterial Road."
    emergencyInstructions: str = "Establish cordon 150m. Deploy breathing apparatus and thermal imaging."
    victims: List[dict] = Field(default_factory=list)
    
    # CAD Operational State
    dispatched_units: List[str] = Field(default_factory=list)
    timeline: List[dict] = Field(default_factory=list)

    def model_post_init(self, __context):
        if not self.locationName or self.locationName == "Unknown Location":
            self.locationName = self.location_name
        if not self.location_name or self.location_name == "Unknown Location":
            self.location_name = self.locationName
            
        if self.urgencyScore != 50 and self.urgency_score == 50:
            self.urgency_score = self.urgencyScore
        elif self.urgency_score != 50 and self.urgencyScore == 50:
            self.urgencyScore = self.urgency_score

        if not self.coordinates or self.coordinates == {"lat": 13.0827, "lng": 80.2707}:
            self.coordinates = {"lat": self.latitude, "lng": self.longitude}
        else:
            self.latitude = self.coordinates.get("lat", self.latitude)
            self.longitude = self.coordinates.get("lng", self.longitude)
            
        if self.affectedPeople.totalEstimated == 0 and self.affected_total > 0:
            self.affectedPeople = AffectedPeople(
                injured=self.affected_injured,
                trapped=self.affected_trapped,
                evacuated=self.affected_evacuated,
                totalEstimated=self.affected_total
            )
        elif self.affectedPeople.totalEstimated > 0 and self.affected_total == 0:
            self.affected_injured = self.affectedPeople.injured
            self.affected_trapped = self.affectedPeople.trapped
            self.affected_evacuated = self.affectedPeople.evacuated
            self.affected_total = self.affectedPeople.totalEstimated

        if self.status != "PENDING" and self.currentStatus == "REPORTED":
            self.currentStatus = self.status
        elif self.currentStatus != "REPORTED" and self.status == "PENDING":
            self.status = "REPORTED" if self.currentStatus == "REPORTED" else self.currentStatus

class EmergencyUnit(BaseModel):
    id: str
    name: str
    type: UnitType
    status: UnitStatus = "AVAILABLE"
    station_name: str
    latitude: float
    longitude: float
    assigned_incident_id: Optional[str] = None
    contact_callsign: str
    personnel_count: int = 4

class IngestRequest(BaseModel):
    raw_message: str
    metadata_or_coordinates: Optional[str] = None
    channel: Optional[str] = "SOCIAL_FEED"

class DispatchRequest(BaseModel):
    unit_ids: List[str]
    notes: Optional[str] = None

class StatusUpdateRequest(BaseModel):
    status: IncidentStatus
    notes: Optional[str] = None

class SystemStats(BaseModel):
    total_incidents: int
    active_critical: int
    active_high: int
    trapped_count: int
    injured_count: int
    available_units: int
    dispatched_units: int
    average_urgency: float
    triaged_today: int

class EmergencyStation(BaseModel):
    id: str
    name: str
    type: Literal["POLICE", "FIRE", "HOSPITAL", "DISASTER_MGMT", "OTHER"] = "POLICE"
    latitude: float
    longitude: float
    address: str = ""

class ResponseUnit(BaseModel):
    id: str
    call_sign: str
    unit_type: str
    station_id: Optional[str] = None
    latitude: float
    longitude: float
    status: Literal["AVAILABLE", "DISPATCHED", "ON_SCENE", "MAINTENANCE"] = "AVAILABLE"
    assigned_incident_id: Optional[str] = None
    personnel_count: int = 4
    equipment: Optional[str] = None

class NearestDispatchRequest(BaseModel):
    unit_type: Optional[str] = None
    notes: Optional[str] = None

class POIItem(BaseModel):
    place_id: Optional[str] = None
    name: str
    type: str
    latitude: float
    longitude: float
    vicinity: Optional[str] = None
    distance_km: Optional[float] = None

class ImageAnalysisResult(BaseModel):
    is_disaster_related: bool
    disaster_category: Literal['FLOOD', 'FIRE', 'STRUCTURAL_COLLAPSE', 'INDUSTRIAL', 'ROAD_ACCIDENT', 'NONE']
    damage_severity: Literal['CRITICAL', 'HIGH', 'MODERATE', 'LOW']
    visual_evidence: List[str] = Field(default_factory=list)
    estimated_casualty_risk: Literal['EXTREME', 'HIGH', 'MODERATE', 'LOW']
    confidence_score: float = 0.0
    suggested_urgency_adjustment: int = 0
    synopsis: Optional[str] = ""

class ImageIngestRequest(BaseModel):
    image_base64: Optional[str] = None
    image_url: Optional[str] = None
    caption: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_name: Optional[str] = None
    channel: Optional[str] = "IMAGE_INGEST"


class SocialStreamItem(BaseModel):
    id: str = Field(default_factory=lambda: f"POST-{uuid.uuid4().hex[:8]}")
    platform: Literal["TWITTER_X", "REDDIT", "TELEGRAM", "CITIZEN_PORTAL", "DISPATCH_112"] = "TWITTER_X"
    author: str = "@citizen_alert"
    author_avatar: Optional[str] = None
    text: str
    media_url: Optional[str] = None
    location_hint: Optional[str] = None
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    source_url: Optional[str] = None


class SocialStreamEvent(BaseModel):
    id: str = Field(default_factory=lambda: f"EVT-{uuid.uuid4().hex[:8]}")
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    item: SocialStreamItem
    action_taken: Literal["TICKET_GENERATED", "MERGED", "SPAM_DISCARDED", "OUT_OF_JURISDICTION"]
    incident_id: Optional[str] = None
    incident_title: Optional[str] = None
    distance_meters: Optional[float] = None
    triage_result: Optional[dict] = None
    summary: str = ""


# ==============================================================================
# SIH26191: RED ZONE, CARRYING CAPACITY & VULNERABLE HABITATION MODELS
# ==============================================================================

class VulnerableDemographics(BaseModel):
    elderly: int = 0
    children: int = 0
    differently_abled: int = 0
    critical_medical: int = 0
    pregnant_women: int = 0
    total_vulnerable: int = 0

class Habitation(BaseModel):
    id: str
    name: str
    district: str
    latitude: float
    longitude: float
    area_sq_km: float = 1.0
    total_population: int
    demographics: VulnerableDemographics = Field(default_factory=VulnerableDemographics)
    terrain_type: Literal[
        "COASTAL_LOWLAND", "RIVER_BASIN", "HILL_SLOPE", "URBAN_SLUM", "INDUSTRIAL_PERIMETER", "DELTA_INLAND"
    ] = "COASTAL_LOWLAND"
    elevation_m: float = 5.0
    flood_risk_factor: float = 0.5  # 0.0 to 1.0
    landslide_risk_factor: float = 0.0  # 0.0 to 1.0
    carrying_capacity_threshold: int = 500  # Max safe sustainable population during crisis
    current_density_score: float = 1.0  # Normalized density / capacity ratio
    status: Literal["NORMAL", "MONITORING", "AT_RISK", "CRITICAL_EVACUATION", "RELOCATED"] = "NORMAL"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class EvacuationShelter(BaseModel):
    id: str
    name: str
    district: str
    latitude: float
    longitude: float
    elevation_m: float = 15.0
    max_capacity: int = 1000
    current_occupancy: int = 0
    available_capacity: int = 1000
    amenities: List[str] = Field(default_factory=lambda: [
        "MEDICAL_POST", "CLEAN_WATER", "GENERATOR_BACKUP", "COMMUNITY_KITCHEN", "BEDDING_SETS"
    ])
    status: Literal["OPERATIONAL", "NEAR_CAPACITY", "FULL", "INACTIVE"] = "OPERATIONAL"
    contact_officer: str = "Tahsildar / Camp Commander"
    contact_phone: str = "+91 94440 00001"
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class RedZonePolygon(BaseModel):
    id: str
    name: str
    district: str
    hazard_type: Literal["FLASH_FLOOD", "INUNDATION", "COASTAL_SURGE", "LANDSLIDE", "CHEMICAL_PLUME", "MULTI_HAZARD"]
    risk_level: Literal["CRITICAL_RED", "HIGH_ORANGE", "MODERATE_YELLOW", "LOW_GREEN"]
    severity_index: float = Field(..., ge=0.0, le=100.0)
    center_lat: float
    center_lng: float
    radius_meters: float = 1500.0
    boundary_geojson: Optional[dict] = None
    contributing_factors: dict = Field(default_factory=dict)
    affected_habitation_ids: List[str] = Field(default_factory=list)
    total_people_at_risk: int = 0
    recommended_action: str = ""
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class HabitationCapacityReport(BaseModel):
    habitation_id: str
    habitation_name: str
    district: str
    total_population: int
    vulnerable_population: int
    capacity_threshold: int
    current_population_pressure: float
    terrain_hazard_index: float
    composite_vulnerability_score: float
    risk_classification: Literal["CRITICAL_RED", "HIGH_ORANGE", "MODERATE_YELLOW", "LOW_GREEN"]
    status: str
    nearest_shelter_id: Optional[str] = None
    nearest_shelter_name: Optional[str] = None
    nearest_shelter_distance_km: Optional[float] = None
    shelter_deficit: int = 0
    immediate_relocation_needed: bool = False

class RelocationPlanItem(BaseModel):
    plan_id: str
    habitation_id: str
    habitation_name: str
    target_shelter_id: str
    target_shelter_name: str
    priority_rank: int
    evacuees_count: int
    vulnerable_count: int
    distance_km: float
    estimated_transit_time_min: int
    convoy_vehicles_needed: dict = Field(default_factory=dict)
    route_waypoints: List[List[float]] = Field(default_factory=list)
    status: Literal["PENDING", "MOBILIZING", "IN_TRANSIT", "COMPLETED"] = "PENDING"
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class RelocationPlanResponse(BaseModel):
    total_habitations_evaluated: int
    total_at_risk_population: int
    total_evacuation_needed: int
    total_available_shelter_capacity: int
    statewide_shelter_deficit: int
    allocations: List[RelocationPlanItem]
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

class RelocationExecuteRequest(BaseModel):
    plan_id: Optional[str] = None
    habitation_id: str
    shelter_id: str
    evacuees_count: Optional[int] = None
    notes: Optional[str] = "Immediate tactical evacuation initiated."



