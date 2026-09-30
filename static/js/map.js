function parseCoordinates(loc) {
    if (!loc) return null;
    if (typeof loc.lat === 'number' && typeof loc.lng === 'number' && !isNaN(loc.lat) && !isNaN(loc.lng)) {
        return { lat: loc.lat, lng: loc.lng };
    }
    if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number' && !isNaN(loc.latitude) && !isNaN(loc.longitude)) {
        return { lat: loc.latitude, lng: loc.longitude };
    }
    if (Array.isArray(loc) && loc.length >= 2) {
        const lat = Number(loc[0]);
        const lng = Number(loc[1]);
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }
    if (typeof loc === 'string') {
        const match = loc.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
        if (match) {
            const lat = parseFloat(match[1]);
            const lng = parseFloat(match[2]);
            if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
        }
    }
    return null;
}

function calcDistanceKm(lat1, lon1, lat2, lon2) {
    if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return 9999;
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

window.parseCoordinates = parseCoordinates;
window.calcDistanceKm = calcDistanceKm;


class CADMapManager {
    constructor(containerId = "tactical-map") {
        this.containerId = containerId;
        this.map = null;
        this.incidentMarkers = {};
        this.unitMarkers = {};
        this.stationMarkers = {};
        this.poiMarkers = [];
        this.routeLines = [];
        this.activeDispatchRoute = null;
        this.hazardCircles = [];
        this.activeFilterType = "ALL";
        this.activeFilterSeverity = "ALL";
        this.showStations = false;
        this.hasFittedBounds = false;
        this.nearestStationHighlight = null;
        this.redZoneLayers = [];
        this.habitationMarkers = {};
        this.shelterMarkers = {};
        this.relocationRouteLines = [];
        this.activeMapMode = "RED_ZONES";
        this.censusBoundaryLayers = [];
        this.showCensusBoundaries = true;
        this.geologicalLayers = [];
        this.showGeologicalLayers = false;
        this.hazardHeatLayer = null;
        this.showHazardHeatmap = true;
        this.cachedRedZones = [];
        this.cachedHabitations = [];
    }

    init() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        if (this.map) {
            try {
                this.map.invalidateSize();
            } catch (e) {}
            return;
        }

        // Prevent Leaflet "Map container is already initialized" error
        if (container._leaflet_id) {
            try {
                container._leaflet_id = null;
            } catch (e) {}
        }

        try {
            // Initialize map centered cleanly over Tamil Nadu district grids ([10.8505, 78.7047], zoom 7)
            this.map = L.map(this.containerId, {
                zoomControl: false,
                preferCanvas: true
            }).setView([10.8505, 78.7047], 7);

            // Layer panes with strict z-indexing to prevent boundary overlays from blocking polygon hover
            if (!this.map.getPane('censusPane')) {
                const cp = this.map.createPane('censusPane');
                cp.style.zIndex = '320';
                cp.style.pointerEvents = 'none'; // Outlines will never swallow mouse hover or click!
            }
            if (!this.map.getPane('geologyPane')) {
                const gp = this.map.createPane('geologyPane');
                gp.style.zIndex = '360';
            }
            if (!this.map.getPane('hazardPane')) {
                const hp = this.map.createPane('hazardPane');
                hp.style.zIndex = '400';
            }

            // 1. OpenStreetMap Dark Tactical (100% Free & Open, Zero API Key Required)
            const osmDarkTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                className: 'map-tiles-dark-theme',
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            });

            // 2. ESRI Dark Gray Canvas (100% Free Public GIS Layer, Zero API Key Required)
            const esriDarkTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 16,
                attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
            });

            // 3. OpenStreetMap Standard (100% Free, Zero API Key Required)
            const osmTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            });

            // 4. ESRI Satellite Imagery (100% Free, Zero API Key Required)
            const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 19,
                attribution: 'Tiles &copy; Esri'
            });

            // Set default active base layer to Open Dark Tactical
            osmDarkTiles.addTo(this.map);

            // Layer Switcher Control (Top Right)
            const baseMaps = {
                "🌑 Dark Tactical (OSM)": osmDarkTiles,
                "🌌 Dark Canvas (ESRI)": esriDarkTiles,
                "🗺️ OpenStreetMap": osmTiles,
                "🛰️ Satellite Imagery": satelliteTiles
            };
            L.control.layers(baseMaps, null, { position: 'topright' }).addTo(this.map);

            // Zoom controls bottom right
            L.control.zoom({ position: 'bottomright' }).addTo(this.map);

            // Handle initial dimension invalidations
            [50, 200, 500, 1000, 2000].forEach(delay => {
                setTimeout(() => {
                    if (this.map) {
                        try { this.map.invalidateSize(); } catch(e) {}
                    }
                }, delay);
            });

            window.addEventListener("resize", () => {
                if (this.map) {
                    try { this.map.invalidateSize(); } catch(e) {}
                }
            });

            // Deferred defensive sweep: ensure no legacy CAD tactical markers survive
            // past the initial data load race condition in strategic mode
            [800, 2500, 5000].forEach(delay => {
                setTimeout(() => {
                    if (this.map && this.activeMapMode !== "CAD_DISPATCH") {
                        try { this.clearCADMarkers(); } catch(e) {}
                    }
                }, delay);
            });

        } catch (err) {
            console.error("CAD Leaflet Map Initialization Error:", err);
        }
    }

    renderIncidents(incidents, onIncidentClick) {
        if (!this.map) this.init();
        if (!this.map) return;

        // HARD GATE: In ALL strategic MHA modes, completely suppress every legacy CAD incident pin.
        // Only CAD_DISPATCH mode is permitted to render incident markers.
        if (this.activeMapMode !== "CAD_DISPATCH") {
            // Remove every existing incident marker immediately
            Object.values(this.incidentMarkers).forEach(m => { try { this.map.removeLayer(m); } catch(e){} });
            this.incidentMarkers = {};
            this.hazardCircles.forEach(c => { try { this.map.removeLayer(c); } catch(e){} });
            this.hazardCircles = [];
            return;
        }

        const currentIds = new Set(incidents.map(i => i.id));
        for (const [id, marker] of Object.entries(this.incidentMarkers)) {
            if (!currentIds.has(id)) {
                this.map.removeLayer(marker);
                delete this.incidentMarkers[id];
            }
        }

        this.hazardCircles.forEach(c => this.map.removeLayer(c));
        this.hazardCircles = [];

        const latLngList = [];

        incidents.forEach(inc => {
            if (this.activeFilterType !== "ALL" && inc.type !== this.activeFilterType) return;
            if (this.activeFilterSeverity !== "ALL" && inc.severity !== this.activeFilterSeverity) return;
            
            const coords = parseCoordinates(inc) || parseCoordinates({ lat: inc.latitude, lng: inc.longitude });
            if (!coords) return;
            const { lat, lng: lon } = coords;

            latLngList.push([lat, lon]);

            let color = "#ef4444"; // CRITICAL
            let bgGlow = "rgba(239, 68, 68, 0.4)";
            if (inc.severity === "HIGH") {
                color = "#f97316";
                bgGlow = "rgba(249, 115, 22, 0.4)";
            } else if (inc.severity === "MODERATE") {
                color = "#06b6d4";
                bgGlow = "rgba(6, 182, 212, 0.4)";
            } else if (inc.severity === "LOW") {
                color = "#10b981";
                bgGlow = "rgba(16, 185, 129, 0.4)";
            }

            const isCritical = (inc.urgency_score >= 80 || inc.severity === "CRITICAL");
            const markerHtml = `
                <div class="cad-pulse-marker ${isCritical ? 'critical-active' : ''}" style="--marker-color: ${color}; cursor: pointer;">
                    <div class="cad-pulse-ring" style="background: ${bgGlow}; border: 1px solid ${color};"></div>
                    <div class="marker-icon-inner" style="background: ${color}; border: 2px solid #fff;">
                        ${this._getTypeIcon(inc.type)}
                    </div>
                </div>
            `;

            const customIcon = L.divIcon({
                html: markerHtml,
                className: 'custom-cad-pin',
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });

            if (this.incidentMarkers[inc.id]) {
                this.incidentMarkers[inc.id].setLatLng([lat, lon]);
                this.incidentMarkers[inc.id].setIcon(customIcon);
            } else {
                const marker = L.marker([lat, lon], { icon: customIcon }).addTo(this.map);
                
                marker.bindTooltip(`
                    <div style="background: #111827; color: #fff; padding: 6px 10px; border-radius: 6px; border: 1px solid ${color}; font-family: sans-serif; font-size: 11px;">
                        <strong style="color: ${color};">[${inc.severity}] ${inc.type}</strong><br/>
                        <span>${inc.title}</span><br/>
                        <span style="color: #9ca3af;">📍 ${inc.location_name || inc.locationName || 'Unknown Location'}</span><br/>
                        <span style="color: #fbbf24;">⚡ Urgency: ${inc.urgency_score !== undefined ? inc.urgency_score : inc.urgencyScore}/100</span>
                    </div>
                `, { direction: 'top', offset: [0, -10], opacity: 0.95 });

                marker.on('click', () => {
                    if (onIncidentClick) onIncidentClick(inc);
                });
                this.incidentMarkers[inc.id] = marker;
            }

            // Hazard circle
            if (inc.severity === "CRITICAL" || inc.severity === "HIGH") {
                const radiusMeters = inc.type === "INDUSTRIAL" ? 800 : (inc.type === "FLOOD" ? 1200 : 500);
                const circle = L.circle([lat, lon], {
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.12,
                    weight: 1,
                    dashArray: "4, 6",
                    radius: radiusMeters
                }).addTo(this.map);
                this.hazardCircles.push(circle);
            }
        });

        // Auto fit bounds on first load
        if (!this.hasFittedBounds && latLngList.length > 0) {
            try {
                this.map.fitBounds(latLngList, { padding: [50, 50], maxZoom: 13 });
                this.hasFittedBounds = true;
            } catch (e) {}
        }
    }

    renderUnits(units) {
        if (!this.map) return;

        this.routeLines.forEach(l => { try { this.map.removeLayer(l); } catch(e){} });
        this.routeLines = [];

        // HARD GATE: Only CAD_DISPATCH mode may render responder unit pins
        if (this.activeMapMode !== "CAD_DISPATCH") {
            Object.values(this.unitMarkers).forEach(m => { try { this.map.removeLayer(m); } catch(e){} });
            this.unitMarkers = {};
            return;
        }

        units.forEach(u => {
            const coords = parseCoordinates(u);
            if (!coords) return;
            const { lat, lng: lon } = coords;

            const isDispatched = u.status === "DISPATCHED";
            const unitColor = isDispatched ? "#f59e0b" : "#3b82f6";
            
            const unitHtml = `
                <div style="background: #111827; border: 2px solid ${unitColor}; border-radius: 6px; padding: 3px 6px; display: flex; align-items: center; gap: 4px; box-shadow: 0 0 10px rgba(0,0,0,0.8); font-family: monospace; font-size: 10px; color: #fff; white-space: nowrap; cursor: pointer;">
                    <span style="width: 6px; height: 6px; border-radius: 50%; background: ${unitColor}; display: inline-block;"></span>
                    <span>${u.id}</span>
                </div>
            `;

            const icon = L.divIcon({
                html: unitHtml,
                className: 'custom-unit-pin',
                iconSize: [80, 24],
                iconAnchor: [40, 12]
            });

            if (this.unitMarkers[u.id]) {
                this.unitMarkers[u.id].setLatLng([lat, lon]);
                this.unitMarkers[u.id].setIcon(icon);
            } else {
                const marker = L.marker([lat, lon], { icon: icon }).addTo(this.map);
                marker.bindTooltip(`
                    <div style="background: #111827; color: #fff; padding: 4px 8px; border-radius: 4px; font-family: sans-serif; font-size: 11px;">
                        <strong>${u.name || u.call_sign || u.id}</strong> (${u.type || u.unit_type})<br/>
                        <span>Station: ${u.station_name || u.station_id || 'Command Center'}</span><br/>
                        <span>Status: <strong style="color: ${unitColor};">${u.status}</strong></span>
                    </div>
                `, { direction: 'top', offset: [0, -10] });
                this.unitMarkers[u.id] = marker;
            }

            // Route line to active incident
            if (isDispatched && u.assigned_incident_id && this.incidentMarkers[u.assigned_incident_id]) {
                const targetLatLng = this.incidentMarkers[u.assigned_incident_id].getLatLng();
                const route = L.polyline([[lat, lon], targetLatLng], {
                    color: "#f59e0b",
                    weight: 2,
                    dashArray: "6, 8",
                    opacity: 0.85
                }).addTo(this.map);
                this.routeLines.push(route);
            }
        });
    }

    renderStations(stations, incidents = [], selectedIncident = null, units = []) {
        if (!this.map || !stations) return;

        // In strategic MHA mode, do not clutter map with CAD police/fire stations unless in CAD_DISPATCH mode
        if (this.activeMapMode !== "CAD_DISPATCH") {
            Object.values(this.stationMarkers).forEach(m => this.map.removeLayer(m));
            this.stationMarkers = {};
            return;
        }

        // Gather assigned station IDs from active dispatched units
        const assignedStationIds = new Set();
        if (units && units.length > 0) {
            units.forEach(u => {
                if (u.assigned_incident_id && (u.station_id || u.station_name)) {
                    if (u.station_id) assignedStationIds.add(u.station_id);
                }
            });
        }

        // Selected incident coordinates (if any)
        const selectedCoords = selectedIncident ? parseCoordinates(selectedIncident) : null;

        // Active incident coordinates
        const activeIncidentCoords = (incidents || [])
            .filter(inc => inc.status !== "RESOLVED" && inc.status !== "CLOSED")
            .map(inc => parseCoordinates(inc))
            .filter(Boolean);

        // FILTER: Only map stations when:
        // 1. A unit from that station is assigned/dispatched, OR
        // 2. Station is within 15 km of an active disaster in the queue, OR
        // 3. Station is within 25 km of the currently selected incident
        const relevantStations = stations.filter(s => {
            const coords = parseCoordinates(s);
            if (!coords) return false;

            // 1. Is an assigned response station?
            if (assignedStationIds.has(s.id)) return true;

            // 2. Is near selected incident?
            if (selectedCoords) {
                const distToSelected = calcDistanceKm(coords.lat, coords.lng, selectedCoords.lat, selectedCoords.lng);
                if (distToSelected <= 25.0) return true;
            }

            // 3. Is near any active disaster in Tamil Nadu queue?
            if (activeIncidentCoords.length > 0) {
                const isNearDisaster = activeIncidentCoords.some(incPt => {
                    return calcDistanceKm(coords.lat, coords.lng, incPt.lat, incPt.lng) <= 15.0;
                });
                if (isNearDisaster) return true;
            }

            return false;
        });

        // Remove unneeded distant station markers from map
        const relevantIds = new Set(relevantStations.map(s => s.id));
        for (const [id, marker] of Object.entries(this.stationMarkers)) {
            if (!relevantIds.has(id)) {
                this.map.removeLayer(marker);
                delete this.stationMarkers[id];
            }
        }

        // Render relevant stations with clean, non-flashing tactical styling
        relevantStations.forEach(s => {
            const coords = parseCoordinates(s);
            if (!coords) return;
            const { lat, lng: lon } = coords;

            let iconSymbol = "🏢";
            let borderColor = "#38bdf8";
            let bgColor = "rgba(15, 23, 42, 0.88)";
            let typeLabel = "STATION";

            if (s.type === "POLICE") {
                iconSymbol = "🚓";
                borderColor = "#3b82f6";
                bgColor = "rgba(15, 23, 42, 0.88)";
                typeLabel = "POLICE STATION";
            } else if (s.type === "FIRE") {
                iconSymbol = "🚒";
                borderColor = "#ef4444";
                bgColor = "rgba(15, 23, 42, 0.88)";
                typeLabel = "FIRE BASE";
            } else if (s.type === "HOSPITAL") {
                iconSymbol = "🏥";
                borderColor = "#10b981";
                bgColor = "rgba(15, 23, 42, 0.88)";
                typeLabel = "HOSPITAL / TRAUMA";
            } else if (s.type === "DISASTER_MGMT") {
                iconSymbol = "🏛️";
                borderColor = "#8b5cf6";
                bgColor = "rgba(15, 23, 42, 0.88)";
                typeLabel = "SDRF / NDRF HQ";
            }

            const stationHtml = `
                <div class="station-map-badge" style="background: ${bgColor}; border: 1px solid ${borderColor}; border-radius: 6px; padding: 2px 6px; display: flex; align-items: center; gap: 4px; cursor: pointer; color: #f8fafc; font-size: 10px; font-weight: 700; box-shadow: 0 2px 6px rgba(0,0,0,0.5);">
                    <span>${iconSymbol}</span>
                    <span style="font-size: 9.5px; font-family: monospace; color: #cbd5e1;">${s.id}</span>
                </div>
            `;

            const icon = L.divIcon({
                html: stationHtml,
                className: 'custom-station-pin',
                iconSize: [80, 22],
                iconAnchor: [40, 11]
            });

            if (this.stationMarkers[s.id]) {
                this.stationMarkers[s.id].setLatLng([lat, lon]);
                this.stationMarkers[s.id].setIcon(icon);
            } else {
                const marker = L.marker([lat, lon], { icon: icon }).addTo(this.map);
                marker.bindTooltip(`
                    <div style="background: #0f172a; color: #fff; padding: 6px 10px; border-radius: 6px; border: 1px solid ${borderColor}; font-family: sans-serif; font-size: 11px;">
                        <span style="color: ${borderColor}; font-weight: 700; text-transform: uppercase;">${iconSymbol} ${typeLabel}</span><br/>
                        <strong style="font-size: 12px;">${s.name}</strong><br/>
                        <span style="color: #94a3b8; font-size: 10px;">📍 ${s.address || 'Tamil Nadu Command Sector'}</span>
                    </div>
                `, { direction: 'top', offset: [0, -10] });
                this.stationMarkers[s.id] = marker;
            }
        });
    }

    renderPOIs(pois, onPoiClick) {
        if (!this.map) return;
        this.clearPOIs();

        pois.forEach(poi => {
            const coords = parseCoordinates(poi);
            if (!coords) return;
            const { lat, lng: lon } = coords;

            let symbol = "📍";
            let color = "#38bdf8";

            if (poi.type === "hospital") {
                symbol = "🏥";
                color = "#34d399";
            } else if (poi.type === "fire_station") {
                symbol = "🚒";
                color = "#f87171";
            } else if (poi.type === "police") {
                symbol = "🚓";
                color = "#60a5fa";
            }

            const html = `
                <div class="poi-pin-bubble" style="background: rgba(15, 23, 42, 0.92); border: 1px solid ${color}; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.5); cursor: pointer;">
                    ${symbol}
                </div>
            `;

            const icon = L.divIcon({
                html: html,
                className: 'custom-poi-pin',
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            });

            const marker = L.marker([lat, lon], { icon: icon }).addTo(this.map);
            marker.bindTooltip(`
                <div style="background: #0f172a; color: #fff; padding: 4px 8px; border-radius: 4px; border: 1px solid ${color}; font-size: 11px;">
                    <strong>${symbol} ${poi.name}</strong><br/>
                    <span style="color: #94a3b8;">${poi.vicinity || ''}</span><br/>
                    <span style="color: #fbbf24; font-weight: 600;">Distance: ${poi.distance_km} km</span>
                </div>
            `, { direction: 'top', offset: [0, -8] });

            if (onPoiClick) {
                marker.on('click', () => onPoiClick(poi));
            }

            this.poiMarkers.push(marker);
        });
    }

    clearPOIs() {
        this.poiMarkers.forEach(m => this.map.removeLayer(m));
        this.poiMarkers = [];
    }

    highlightNearestStation(station, incidentCoord) {
        if (!this.map || !station) return;
        this.clearStationHighlight();

        const stnCoords = parseCoordinates(station);
        if (!stnCoords) return;

        // Steady, clean tactical perimeter circle (no flashing/pulsing)
        const steadyRing = L.circle([stnCoords.lat, stnCoords.lng], {
            radius: 100,
            color: "#38bdf8",
            weight: 1.5,
            dashArray: "4, 4",
            fillColor: "#0284c7",
            fillOpacity: 0.15,
            className: "steady-tactical-halo"
        }).addTo(this.map);

        const iconHtml = `
            <div style="background: rgba(15, 23, 42, 0.95); border: 1.5px solid #38bdf8; box-shadow: 0 4px 12px rgba(0,0,0,0.6); border-radius: 6px; padding: 3px 8px; color: #fff; font-size: 10.5px; font-weight: 700; white-space: nowrap; display: flex; align-items: center; gap: 5px;">
                <span style="background: #0284c7; color: #fff; padding: 1px 5px; border-radius: 3px; font-size: 9.5px; font-weight: 800;">⚡ NEAREST</span>
                <span>${station.name ? station.name.substring(0, 24) : 'Emergency Station'}</span>
            </div>
        `;

        const badgeMarker = L.marker([stnCoords.lat, stnCoords.lng], {
            icon: L.divIcon({
                html: iconHtml,
                className: "nearest-station-label-pin",
                iconSize: [180, 24],
                iconAnchor: [90, 30]
            })
        }).addTo(this.map);

        this.nearestStationHighlight = L.layerGroup([steadyRing, badgeMarker]).addTo(this.map);
    }

    clearStationHighlight() {
        if (this.nearestStationHighlight) {
            this.map.removeLayer(this.nearestStationHighlight);
            this.nearestStationHighlight = null;
        }
    }


    renderUnitRoute(routeData, originCoord, destCoord, unitInfo) {
        if (!this.map) return;
        this.clearUnitRoute();

        const startPt = parseCoordinates(originCoord);
        const endPt = parseCoordinates(destCoord);

        let latLngs = [];
        if (routeData && routeData.polyline) {
            latLngs = this._decodePolyline(routeData.polyline);
        } else if (routeData && routeData.coordinates && routeData.coordinates.length > 0) {
            latLngs = routeData.coordinates.map(pt => {
                const parsed = parseCoordinates(pt);
                return parsed ? [parsed.lat, parsed.lng] : pt;
            });
        } else if (startPt && endPt) {
            latLngs = [[startPt.lat, startPt.lng], [endPt.lat, endPt.lng]];
        }

        if (latLngs.length === 0) return;

        // Draw animated glowing vector polyline with neon cyan / amber dash
        const glowLine = L.polyline(latLngs, {
            color: "#0284c7",
            weight: 8,
            opacity: 0.45,
            lineCap: 'round',
            lineJoin: 'round'
        }).addTo(this.map);

        const routeLine = L.polyline(latLngs, {
            color: "#38bdf8",
            weight: 3.5,
            opacity: 0.98,
            dashArray: "6, 10",
            lineCap: 'round',
            className: 'tactical-dispatch-vector'
        }).addTo(this.map);

        this.activeDispatchRoute = L.layerGroup([glowLine, routeLine]).addTo(this.map);

        // Fit map bounds to show route with smooth transition
        try {
            this.map.fitBounds(latLngs, { padding: [60, 60], maxZoom: 15 });
        } catch (e) {}
    }

    clearUnitRoute() {
        if (this.activeDispatchRoute) {
            this.map.removeLayer(this.activeDispatchRoute);
            this.activeDispatchRoute = null;
        }
        this.clearStationHighlight();
    }



    _decodePolyline(encoded) {
        if (!encoded) return [];
        let points = [];
        let index = 0, len = encoded.length;
        let lat = 0, lng = 0;
        while (index < len) {
            let b, shift = 0, result = 0;
            do {
                b = encoded.charCodeAt(index++) - 63;
                result |= (b & 0x1f) << shift;
                shift += 5;
            } while (b >= 0x20);
            let dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lat += dlat;
            shift = 0;
            result = 0;
            do {
                b = encoded.charCodeAt(index++) - 63;
                result |= (b & 0x1f) << shift;
                shift += 5;
            } while (b >= 0x20);
            let dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
            lng += dlng;
            points.push([lat / 1e5, lng / 1e5]);
        }
        return points;
    }

    renderRedZones(redZones) {
        if (!this.map) return;

        // STRATEGIC CLEAN SLATE: Always purge all legacy CAD tactical markers before
        // rendering any strategic hazard layer. This is the definitive suppression point.
        this.clearCADMarkers();

        this.redZoneLayers.forEach(l => this.map.removeLayer(l));
        this.redZoneLayers = [];

        this.cachedRedZones = Array.isArray(redZones) ? redZones : [];

        if (!Array.isArray(redZones)) return;

        redZones.forEach((rz, idx) => {
            // Color Coding: Red (Critical Risk / Immediate Relocation), Amber (High Risk / Prepare for Relocation), Green (Safe Habitation)
            const sev = rz.severity_index || 0;
            let color = "#ef4444";
            let riskTier = "CRITICAL RISK / IMMEDIATE RELOCATION";
            let polyClass = "risk-poly-critical";

            if (rz.risk_level === "CRITICAL_RED" || sev >= 65) {
                color = "#ef4444";
                riskTier = "CRITICAL RISK / IMMEDIATE RELOCATION";
                polyClass = "risk-poly-critical";
            } else if (rz.risk_level === "HIGH_ORANGE" || rz.risk_level === "MODERATE_YELLOW" || sev >= 30) {
                color = "#f59e0b";
                riskTier = "HIGH RISK / PREPARE FOR RELOCATION";
                polyClass = "risk-poly-high";
            } else {
                color = "#10b981";
                riskTier = "SAFE HABITATION / MONITORING";
                polyClass = "risk-poly-safe";
            }

            // Extract coordinates from boundary_geojson or construct polygonal perimeter
            let latLngs = [];
            if (rz.boundary_geojson && rz.boundary_geojson.geometry && rz.boundary_geojson.geometry.coordinates) {
                const ring = rz.boundary_geojson.geometry.coordinates[0];
                if (Array.isArray(ring) && ring.length > 0) {
                    latLngs = ring.map(pt => [pt[1], pt[0]]); // GeoJSON [lng, lat] -> Leaflet [lat, lng]
                }
            }

            if (!latLngs || latLngs.length < 3) {
                // Generate smooth polygon vertices if geojson coordinates missing
                const numPts = 16;
                const r_lat = (rz.radius_meters || 1800) / 111320.0;
                const r_lng = (rz.radius_meters || 1800) / (111320.0 * Math.cos(rz.center_lat * Math.PI / 180));
                for (let i = 0; i < numPts; i++) {
                    const angle = (2 * Math.PI * i) / numPts;
                    const wobble = 0.92 + (Math.sin(i * 2 + idx) * 0.12);
                    latLngs.push([
                        rz.center_lat + (r_lat * Math.sin(angle) * wobble),
                        rz.center_lng + (r_lng * Math.cos(angle) * wobble)
                    ]);
                }
            }

            // Clean, semi-transparent tactical overlay polygon
            const polygon = L.polygon(latLngs, {
                color: color,
                weight: 1.5,
                dashArray: "4, 4",
                fillColor: color,
                fillOpacity: 0.18,
                pane: 'hazardPane',
                className: polyClass
            }).addTo(this.map);

            const selectZoneHandler = () => {
                if (window.cadApp && typeof window.cadApp.selectHazardZone === 'function') {
                    window.cadApp.selectHazardZone(rz.id);
                }
            };

            // Clean click: updates right-hand side panel exclusively (zero popups/modals)
            polygon.on('click', selectZoneHandler);

            // Pure GIS polygon brightening on hover — no floating labels or callout numbers
            polygon.on('mouseover', () => {
                polygon.setStyle({ fillOpacity: 0.38, weight: 2.5, color: '#ffffff' });
                polygon.bringToFront();
            });
            polygon.on('mouseout', () => {
                polygon.setStyle({ fillOpacity: 0.18, weight: 1.5, color: color });
            });

            // Track polygon for cleanup
            this.redZoneLayers.push(polygon);
        });

        this.updateHazardHeatmap();
    }

    renderCensusBoundaries(habitations) {
        if (!this.map) return;
        this.censusBoundaryLayers.forEach(l => this.map.removeLayer(l));
        this.censusBoundaryLayers = [];

        if (!Array.isArray(habitations)) return;

        habitations.forEach((hab, idx) => {
            // Generate village boundary polygon from census administrative unit
            const numPts = 8;
            const r_lat = 0.012 + (idx % 3) * 0.003;
            const r_lng = 0.014 + (idx % 2) * 0.003;
            const polygonCoords = [];
            for (let i = 0; i < numPts; i++) {
                const angle = (2 * Math.PI * i) / numPts;
                const wobble = 0.85 + (Math.sin(i * 3 + idx) * 0.25);
                const lat = hab.latitude + (r_lat * Math.sin(angle) * wobble);
                const lng = hab.longitude + (r_lng * Math.cos(angle) * wobble);
                polygonCoords.push([lat, lng]);
            }

            // Using dedicated censusPane with pointerEvents: none so it never blocks mouse hover
            const boundaryPoly = L.polygon(polygonCoords, {
                color: "#06b6d4",
                weight: 1.5,
                dashArray: "5, 5",
                fillColor: "#06b6d4",
                fillOpacity: 0.06,
                pane: 'censusPane',
                className: "census-village-boundary"
            });

            if (this.showCensusBoundaries) {
                boundaryPoly.addTo(this.map);
            }

            this.censusBoundaryLayers.push(boundaryPoly);
        });
    }

    toggleCensusBoundaries(show) {
        this.showCensusBoundaries = show;
        this.censusBoundaryLayers.forEach(l => {
            if (show) {
                if (!this.map.hasLayer(l)) l.addTo(this.map);
            } else {
                if (this.map.hasLayer(l)) this.map.removeLayer(l);
            }
        });
    }

    renderGeologicalLayers(geoJsonData) {
        if (!this.map) return;
        this.geologicalLayers.forEach(l => this.map.removeLayer(l));
        this.geologicalLayers = [];

        if (!geoJsonData || !geoJsonData.features) return;

        geoJsonData.features.forEach(feat => {
            const color = (feat.properties && feat.properties.color) ? feat.properties.color : '#ef4444';
            const name = feat.properties ? feat.properties.name : 'Fault Line';
            const shearRisk = feat.properties ? feat.properties.shear_risk : 'HIGH';
            const slipRate = feat.properties ? feat.properties.slip_rate_mm_yr : 1.5;

            const coords = feat.geometry.coordinates.map(pt => [pt[1], pt[0]]);
            const polyline = L.polyline(coords, {
                color: color,
                weight: 3.5,
                dashArray: '8, 6',
                pane: 'geologyPane',
                className: 'fault-line-gis'
            });

            // No hover tooltip on geological fault lines — keep map clean
            if (this.showGeologicalLayers) {
                polyline.addTo(this.map);
            }

            this.geologicalLayers.push(polyline);
        });
    }

    toggleGeologicalLayers(show) {
        this.showGeologicalLayers = show;
        this.geologicalLayers.forEach(l => {
            if (show) {
                if (!this.map.hasLayer(l)) l.addTo(this.map);
            } else {
                if (this.map.hasLayer(l)) this.map.removeLayer(l);
            }
        });
    }

    renderHabitations(habitations) {
        if (!this.map) return;
        Object.values(this.habitationMarkers).forEach(m => this.map.removeLayer(m));
        this.habitationMarkers = {};

        this.cachedHabitations = Array.isArray(habitations) ? habitations : [];

        if (!Array.isArray(habitations)) return;

        // Render Census boundaries overlay alongside habitations
        this.renderCensusBoundaries(habitations);

        habitations.forEach((hab, idx) => {
            const isCritical = hab.status === "CRITICAL_EVACUATION" || hab.status === "AT_RISK";
            const color = isCritical ? '#ef4444' : '#06b6d4';

            // Clean GIS census habitation point cluster — subtle circleMarker, zero pins, zero emojis, zero tooltips
            const clusterDot = L.circleMarker([hab.latitude, hab.longitude], {
                radius: 4.5,
                color: color,
                weight: 1.5,
                fillColor: color,
                fillOpacity: 0.8,
                pane: 'censusPane',
                className: 'census-habitation-point'
            }).addTo(this.map);

            // Clicking routes to right-hand insight panel without opening any popup or tooltip
            clusterDot.on('click', () => {
                if (window.cadApp && typeof window.cadApp.selectHazardZone === 'function') {
                    window.cadApp.selectHazardZone(hab.id);
                }
            });
            this.habitationMarkers[hab.id] = clusterDot;
        });

        this.updateHazardHeatmap();
    }

    renderShelters(shelters) {
        if (!this.map) return;
        Object.values(this.shelterMarkers).forEach(m => this.map.removeLayer(m));
        this.shelterMarkers = {};

        // In pure strategic RED_ZONES mode, shelters are displayed exclusively in the bottom-right embedded relocation map
        if (this.activeMapMode === "RED_ZONES") return;

        if (!Array.isArray(shelters)) return;

        shelters.forEach(shl => {
            const occRatio = shl.current_occupancy / Math.max(1, shl.max_capacity);
            const color = occRatio > 0.85 ? "#ef4444" : (occRatio > 0.5 ? "#f59e0b" : "#10b981");

            const marker = L.circleMarker([shl.latitude, shl.longitude], {
                radius: 5,
                color: color,
                weight: 1.5,
                fillColor: '#0f172a',
                fillOpacity: 0.9,
                pane: 'censusPane'
            }).addTo(this.map);

            // No popup on shelter marker — all detail flows to right panel
            this.shelterMarkers[shl.id] = marker;
        });
    }


    renderRelocationRoutes(allocations) {
        if (!this.map) return;
        this.relocationRouteLines.forEach(l => this.map.removeLayer(l));
        this.relocationRouteLines = [];

        if (!Array.isArray(allocations)) return;

        allocations.forEach(alloc => {
            if (!alloc.route_waypoints || alloc.route_waypoints.length < 2) return;
            const polyline = L.polyline(alloc.route_waypoints, {
                color: "#38bdf8",
                weight: 4,
                opacity: 0.85,
                dashArray: "8, 8"
            }).addTo(this.map);

            // Pure GIS route line without disruptive popup or tooltip
            this.relocationRouteLines.push(polyline);
        });
    }

    setMapMode(mode) {
        this.activeMapMode = mode;
        const showRedZones = mode === "ALL" || mode === "RED_ZONES";
        const showHabitations = mode === "ALL" || mode === "RED_ZONES" || mode === "HABITATIONS";
        const showShelters = mode === "ALL" || mode === "SHELTERS" || mode === "CONVOYS";
        const showConvoys = mode === "ALL" || mode === "CONVOYS";
        const showIncidents = mode === "INCIDENTS" || mode === "CAD_DISPATCH";

        // In strategic hazard modes, clear legacy CAD pins
        if (!showIncidents) {
            this.clearCADMarkers();
        }

        this.redZoneLayers.forEach(l => {
            if (this.map.hasLayer(l) && !showRedZones) this.map.removeLayer(l);
            else if (!this.map.hasLayer(l) && showRedZones) l.addTo(this.map);
        });

        Object.values(this.habitationMarkers).forEach(m => {
            if (this.map.hasLayer(m) && !showHabitations) this.map.removeLayer(m);
            else if (!this.map.hasLayer(m) && showHabitations) m.addTo(this.map);
        });

        Object.values(this.shelterMarkers).forEach(m => {
            if (this.map.hasLayer(m) && !showShelters) this.map.removeLayer(m);
            else if (!this.map.hasLayer(m) && showShelters) m.addTo(this.map);
        });

        this.relocationRouteLines.forEach(l => {
            if (this.map.hasLayer(l) && !showConvoys) this.map.removeLayer(l);
            else if (!this.map.hasLayer(l) && showConvoys) l.addTo(this.map);
        });

        Object.values(this.incidentMarkers).forEach(m => {
            if (this.map.hasLayer(m) && !showIncidents) this.map.removeLayer(m);
            else if (!this.map.hasLayer(m) && showIncidents) m.addTo(this.map);
        });

        // Sync heatmap layer visibility
        if (showRedZones && this.showHazardHeatmap) {
            this.updateHazardHeatmap();
        } else if (!showRedZones && this.hazardHeatLayer) {
            this.map.removeLayer(this.hazardHeatLayer);
            this.hazardHeatLayer = null;
        }
    }

    clearCADMarkers() {
        if (!this.map) return;
        Object.values(this.unitMarkers).forEach(m => this.map.removeLayer(m));
        this.unitMarkers = {};
        Object.values(this.incidentMarkers).forEach(m => this.map.removeLayer(m));
        this.incidentMarkers = {};
        Object.values(this.stationMarkers).forEach(m => this.map.removeLayer(m));
        this.stationMarkers = {};
        this.hazardCircles.forEach(c => this.map.removeLayer(c));
        this.hazardCircles = [];
        this.routeLines.forEach(l => this.map.removeLayer(l));
        this.routeLines = [];
        this.clearUnitRoute();
        this.clearPOIs();
    }

    updateHazardHeatmap() {
        if (!this.map) return;

        if (this.hazardHeatLayer) {
            this.map.removeLayer(this.hazardHeatLayer);
            this.hazardHeatLayer = null;
        }

        if (!this.showHazardHeatmap) return;

        const heatPoints = [];

        // 1. Ingest Red Zones (weighted by severity_index from 0 to 100)
        const redZones = this.cachedRedZones || [];
        redZones.forEach(rz => {
            if (!rz.center_lat || !rz.center_lng) return;
            const sev = (rz.severity_index !== undefined ? rz.severity_index : 75) / 100.0;
            const intensity = Math.min(1.0, Math.max(0.4, sev));

            // Core center point
            heatPoints.push([rz.center_lat, rz.center_lng, intensity]);

            // Concentric interpolated rings around zone center for smooth natural heat diffusion
            const spreadRadius = (rz.radius_meters || 2200) / 111320.0;
            const ringCount = 8;
            for (let i = 0; i < ringCount; i++) {
                const angle = (2 * Math.PI * i) / ringCount;
                const r = spreadRadius * 0.55;
                heatPoints.push([
                    rz.center_lat + r * Math.sin(angle),
                    rz.center_lng + (r / Math.cos(rz.center_lat * Math.PI / 180)) * Math.cos(angle),
                    intensity * 0.72
                ]);
            }
        });

        // 2. Ingest Habitations (weighted by vulnerability and population pressure)
        const habitations = this.cachedHabitations || [];
        habitations.forEach(hab => {
            if (!hab.latitude || !hab.longitude) return;
            const pressure = (hab.total_population || 1000) / Math.max(1, hab.carrying_capacity_threshold || 1000);
            let habIntensity = 0.20; // safe green zone default
            if (hab.status === "CRITICAL_EVACUATION" || pressure > 2.2) {
                habIntensity = 0.94; // deep red critical risk
            } else if (hab.status === "AT_RISK" || pressure > 1.2) {
                habIntensity = 0.68; // amber high risk
            } else {
                habIntensity = 0.20; // safe green
            }
            heatPoints.push([hab.latitude, hab.longitude, habIntensity]);
        });

        if (heatPoints.length === 0) return;

        // Smooth Multi-color gradient: Green (safe) -> Cyan (moderate) -> Amber (high risk) -> Deep Red (critical red zones)
        const heatGradient = {
            0.10: '#10b981', // safe zone (emerald green)
            0.30: '#34d399', // low risk (light green)
            0.50: '#06b6d4', // moderate (cyan)
            0.68: '#f59e0b', // high risk (amber)
            0.85: '#f97316', // elevated warning (orange)
            0.96: '#ef4444'  // critical red zone (deep red)
        };

        if (typeof L.heatLayer === 'function') {
            try {
                this.hazardHeatLayer = L.heatLayer(heatPoints, {
                    radius: 46,
                    blur: 30,
                    maxZoom: 13,
                    max: 1.0,
                    minOpacity: 0.25,
                    gradient: heatGradient
                }).addTo(this.map);
                return;
            } catch (err) {
                console.warn("L.heatLayer initialization fallback:", err);
            }
        }

        // Programmatic Radial Gradient Fallback using Leaflet circles
        const fallbackGroup = L.layerGroup();
        heatPoints.forEach(([lat, lng, val]) => {
            let color = "#10b981";
            if (val >= 0.85) color = "#ef4444";
            else if (val >= 0.55) color = "#f59e0b";
            else color = "#10b981";

            const outerHalo = L.circle([lat, lng], {
                radius: 4200 * val,
                color: color,
                weight: 0,
                fillColor: color,
                fillOpacity: 0.10,
                pane: 'censusPane',
                interactive: false
            });
            const innerCore = L.circle([lat, lng], {
                radius: 2000 * val,
                color: color,
                weight: 0,
                fillColor: color,
                fillOpacity: 0.22,
                pane: 'censusPane',
                interactive: false
            });
            fallbackGroup.addLayer(outerHalo);
            fallbackGroup.addLayer(innerCore);
        });
        fallbackGroup.addTo(this.map);
        this.hazardHeatLayer = fallbackGroup;
    }

    toggleHazardHeatmap(show) {
        this.showHazardHeatmap = show;
        this.updateHazardHeatmap();
    }

    focusLocation(lat, lon, zoom = 14) {
        if (this.map) {
            this.map.flyTo([lat, lon], zoom, { duration: 1.0 });
        }
    }

    _getTypeIcon(type) {
        switch (type) {
            case "FIRE": return "🔥";
            case "FLOOD": return "🌊";
            case "INDUSTRIAL": return "☣️";
            case "EARTHQUAKE": return "🌋";
            case "CYCLONE": return "🌀";
            case "STRUCTURAL_COLLAPSE": return "🏚️";
            default: return "⚠️";
        }
    }
}

window.cadMapManager = new CADMapManager();
