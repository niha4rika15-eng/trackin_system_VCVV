/* PCNS — Precision Campus Navigation System
 * Pure vanilla JS. Outdoor GPS -> QR location anchor -> Indoor PDR.
 */
(() => {
  "use strict";

  // ---------- Config ----------
  const ADMIN_PASSWORD = "amity2026"; // change in localStorage key 'pcns.adminPass' via admin later
  const ARRIVAL_RADIUS_M = 5;
  const ROUTE_ARRIVAL_RADIUS_M = 3;
  const TURN_PROMPT_DISTANCE_M = 6;
  const STRAIGHT_UPDATE_DISTANCE_M = 15;
  const SPEECH_COOLDOWN = 8000;
  const DEFAULT_STEP_LENGTH_M = 0.7; // ~average
  const STEP_SIGNAL_THRESHOLD = 1.2; // m/s^2 dynamic acceleration
  const STEP_RELEASE_THRESHOLD = 0.5;
  const STEP_MIN_INTERVAL_MS = 280;
  const SNAP_MAX_DISTANCE_M = 15;
  const AMITY_NOIDA_CENTER = [28.5440, 77.3350];
  const DEFAULT_FLOORS = [0, 1, 2, 3];

  const LS = {
    landmarks: "pcns.landmarks",
    adminPass: "pcns.adminPass",      // legacy plain text (back-compat)
    adminHash: "pcns.adminPassHash",  // SHA-256 hex of password
    training: "pcns.training",
    heatmap: "pcns.heatmap",
    calibrationSamples: "pcns.pdrCalibrationSamples.v1",
    calibrationModel: "pcns.pdrCalibrationModel.v1",
  };

  // ---------- State ----------
  const state = {
    mode: "OUTDOOR", // OUTDOOR | INDOOR
    userLatLng: null,
    selectedLandmarkId: null,
    arrivedGateId: null,
    routeActive: false,
    // PDR
    anchor: null,            // { lat, lng, floor, label }
    heading: 0,              // degrees 0..359
    stepCount: 0,
    pdrOffsetMeters: { x: 0, y: 0 }, // accumulated E/N offset from anchor
    lastStepTs: 0,
    stepSignalAbove: false,
    strideLengthM: DEFAULT_STEP_LENGTH_M,
    // Floor plan
    floorGeo: null,
    // Training mode
    training: false,
    // Heatmap mode (dim other floors instead of hiding)
    heatmap: false,
    // Floor awareness
    currentFloor: "ALL",          // "ALL" | integer (0 = Ground)
    availableFloors: [...DEFAULT_FLOORS],
    // Markers
    userMarker: null,
    headingMarker: null,
    landmarkMarkers: new Map(),
    watchId: null,
  };
  let lastSpokenText = "";
  let lastSpokenTime = 0;
  let lastStraightAnnouncementDistance = null;
  let routeClosestDistanceM = null;
  let routeOffRoute = false;
  let routeTurnTriggeredNodeId = null;
  let routeSpeechDestinationId = null;

  // ---------- Storage ----------
  let storageWarningShown = false;
  function reportStorageProblem(message, error) {
    console.error(message, error);
    if (!storageWarningShown) {
      storageWarningShown = true;
      alert(message);
    }
  }

  function isValidLandmark(lm) {
    return !!lm && typeof lm === "object" && !Array.isArray(lm) &&
      typeof lm.id === "string" && /^[\w-]+$/.test(lm.id) &&
      typeof lm.name === "string" && !!lm.name.trim() &&
      Number.isFinite(lm.lat) && Math.abs(lm.lat) <= 90 &&
      Number.isFinite(lm.lng) && Math.abs(lm.lng) <= 180 &&
      (lm.floor == null || Number.isInteger(lm.floor)) &&
      (lm.uid == null || typeof lm.uid === "string") &&
      (lm.anchor == null || typeof lm.anchor === "string") &&
      (lm.offset == null || (
        typeof lm.offset === "object" &&
        Number.isFinite(lm.offset.x) && Number.isFinite(lm.offset.y)
      ));
  }

  function loadLandmarks() {
    let raw;
    try {
      raw = localStorage.getItem(LS.landmarks);
    } catch (error) {
      reportStorageProblem("Browser storage is unavailable. Saved landmarks cannot be loaded.", error);
      return [];
    }
    if (!raw) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      reportStorageProblem("Saved landmark data is damaged and could not be read. The original data was left unchanged.", error);
      return [];
    }
    if (!Array.isArray(parsed)) {
      reportStorageProblem("Saved landmark data has an invalid format. The original data was left unchanged.", new TypeError("Expected a landmark array."));
      return [];
    }

    const ids = new Set();
    const valid = parsed.filter(lm => {
      if (!isValidLandmark(lm) || ids.has(lm.id)) return false;
      ids.add(lm.id);
      return true;
    });
    if (valid.length !== parsed.length) {
      reportStorageProblem("Some saved landmarks are invalid and were skipped. Review or remove the damaged entries from browser storage.", new TypeError("Invalid or duplicate landmark records."));
    }
    return valid;
  }

  function saveLandmarks(arr) {
    try {
      localStorage.setItem(LS.landmarks, JSON.stringify(arr));
      refreshAvailableFloors(arr);
      return true;
    } catch (error) {
      reportStorageProblem("Landmarks could not be saved. Check browser storage permissions and available space.", error);
      return false;
    }
  }

  function readStoredSetting(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      reportStorageProblem("Browser storage is unavailable. App settings cannot be restored.", error);
      return null;
    }
  }

  function writeStoredSetting(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      reportStorageProblem("App settings could not be saved. Check browser storage permissions and available space.", error);
      return false;
    }
  }

  function refreshAvailableFloors(landmarks = loadLandmarks()) {
    const floors = new Set(DEFAULT_FLOORS);
    if (Number.isInteger(state.anchor?.floor)) floors.add(state.anchor.floor);
    landmarks.forEach(lm => {
      if (Number.isInteger(lm.floor)) floors.add(lm.floor);
    });
    state.availableFloors = [...floors].sort((a, b) => a - b);
    if (state.currentFloor !== "ALL" && !floors.has(state.currentFloor)) state.currentFloor = "ALL";
    renderFloorSwitch();
    applyFloorFilterToGeo();
  }

  // ---------- Geo utils ----------
  const R = 6371000; // meters
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const la1 = toRad(a.lat), la2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // offset in meters (eastMeters, northMeters) added to a lat/lng
  function offsetLatLng(lat, lng, eastMeters, northMeters) {
    const dLat = (northMeters / R) * (180 / Math.PI);
    const dLng = (eastMeters / (R * Math.cos(toRad(lat)))) * (180 / Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
  }

  // Parse "lat,lng" or Google Maps URL
  function parseCoords(text) {
    if (!text) return null;
    const s = text.trim();
    // simple "lat, lng"
    let m = s.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    // Google Maps @lat,lng,zoom
    const gm = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    // q=lat,lng
    const qm = s.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    const mm = gm || qm || m;
    if (!mm) return null;
    const lat = parseFloat(mm[1]), lng = parseFloat(mm[2]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
  }

  // ---------- Map ----------
  const map = L.map("map", { zoomControl: true, attributionControl: true })
    .setView(AMITY_NOIDA_CENTER, 17);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "© OpenStreetMap",
  }).addTo(map);

  function setUserPosition(lat, lng, { pan = true } = {}) {
    state.userLatLng = { lat, lng };
    const icon = L.divIcon({
      className: "",
      html: `<div class="user-marker ${state.mode === "INDOOR" ? "indoor" : ""}"></div>`,
      iconSize: [18, 18], iconAnchor: [9, 9],
    });
    if (!state.userMarker) {
      state.userMarker = L.marker([lat, lng], { icon }).addTo(map);
    } else {
      state.userMarker.setLatLng([lat, lng]);
      state.userMarker.setIcon(icon);
    }
    if (pan) map.setView([lat, lng], Math.max(map.getZoom(), state.mode === "INDOOR" ? 20 : 18));
    if (state.routeActive) updateRouteGuidance();
  }

  // ---------- Landmarks ----------
  function landmarkOnCurrentFloor(lm) {
    if (state.currentFloor === "ALL") return true;
    if (lm.floor == null) return true;
    return Number(lm.floor) === Number(state.currentFloor);
  }

  function renderLandmarkMarkers() {
    state.landmarkMarkers.forEach(m => map.removeLayer(m));
    state.landmarkMarkers.clear();
    const all = loadLandmarks();
    // In heatmap mode, render all but dim the off-floor ones; otherwise filter.
    const list = state.heatmap ? all : all.filter(landmarkOnCurrentFloor);
    list.forEach(lm => {
      const isTraining = lm.source === "training";
      const offFloor = state.heatmap && !landmarkOnCurrentFloor(lm);
      const m = L.circleMarker([lm.lat, lm.lng], {
        radius: isTraining ? 6 : 8,
        color: isTraining ? "#f5f2ff" : "#9B30FF",
        fillColor: isTraining ? "#9B30FF" : "#b769ff",
        fillOpacity: offFloor ? 0.18 : 0.9,
        opacity:     offFloor ? 0.20 : 1,
        weight: 2,
      }).bindPopup(
        `<b>${escapeHtml(lm.name)}</b>` +
        (isTraining ? ` <em style="color:#b769ff">[training]</em>` : "") +
        (lm.floor != null ? ` <span style="color:#b769ff">· Floor ${lm.floor}</span>` : "") +
        `<br/>${lm.lat.toFixed(5)}, ${lm.lng.toFixed(5)}` +
        (lm.uid ? `<br/><span style="color:#8a7ea3">UID: ${escapeHtml(lm.uid)}</span>` : "")
      );
      m.addTo(map);
      state.landmarkMarkers.set(lm.id, m);
    });
  }

  // ---------- Floor Switcher ----------
  function floorLabel(f) { return f === 0 ? "G" : String(f); }

  function renderFloorSwitch() {
    const box = $("#floorSwitch");
    const floors = [...state.availableFloors].sort((a, b) => b - a); // top-down: highest first
    const btns = floors.map(f => `
      <button class="floor-btn ${state.currentFloor === f ? "active" : ""}"
              data-floor="${f}" data-testid="floor-btn-${f}" title="Floor ${floorLabel(f)}">
        ${floorLabel(f)}
      </button>`).join("");
    const allBtn = `
      <button class="floor-btn all-btn ${state.currentFloor === "ALL" ? "active" : ""}"
              data-floor="ALL" data-testid="floor-btn-all" title="All floors">ALL</button>`;
    box.innerHTML = btns + allBtn;
    box.querySelectorAll("button[data-floor]").forEach(b =>
      b.addEventListener("click", () => {
        const f = b.dataset.floor;
        setCurrentFloor(f === "ALL" ? "ALL" : Number(f));
      })
    );
  }

  function setCurrentFloor(f) {
    if (Number.isInteger(f) && !state.availableFloors.includes(f)) {
      state.availableFloors.push(f);
      state.availableFloors.sort((a, b) => a - b);
    }
    state.currentFloor = f;
    renderFloorSwitch();
    renderLandmarkMarkers();
    applyFloorFilterToGeo();
    refreshSearch();
  }

  function applyFloorFilterToGeo() {
    if (!floorLayer) return;
    floorLayer.eachLayer(layer => {
      const floor = layer.feature?.properties?.floor;
      const onFloor =
        state.currentFloor === "ALL" || floor == null || Number(floor) === Number(state.currentFloor);
      const el = layer.getElement ? layer.getElement() : null;
      if (!el) return;
      if (state.heatmap) {
        el.style.display = "";
        el.classList.toggle("heatmap-dim", !onFloor);
      } else {
        el.style.display = onFloor ? "" : "none";
        el.classList.remove("heatmap-dim");
      }
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  }

  // ---------- Search ----------
  const $ = sel => document.querySelector(sel);
  const searchInput = $("#searchInput");
  const searchResults = $("#searchResults");

  function refreshSearch() {
    const q = searchInput.value.trim().toLowerCase();
    const here = state.userLatLng;
    const items = loadLandmarks()
      .filter(landmarkOnCurrentFloor)
      .map(lm => ({
        ...lm,
        dist: here ? haversine(here, lm) : null,
      }))
      .filter(lm => !q || lm.name.toLowerCase().includes(q))
      .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity))
      .slice(0, 20);

    searchResults.innerHTML = items.map(lm => `
      <li data-id="${lm.id}" data-testid="search-result-${lm.id}">
        <span class="search-result-name">${escapeHtml(lm.name)}</span>
        <span class="search-result-actions">
          <span class="dist">${lm.dist != null ? Math.round(lm.dist) + " m" : ""}</span>
          <a class="search-result-directions" href="${googleMapsDirectionsUrl(lm)}"
             target="_blank" rel="noopener noreferrer" aria-label="Get directions to ${escapeHtml(lm.name)}">Directions</a>
        </span>
      </li>`).join("");

    searchResults.querySelectorAll("li").forEach(li => {
      li.addEventListener("click", () => selectLandmark(li.dataset.id));
    });
    searchResults.querySelectorAll(".search-result-directions").forEach(link =>
      link.addEventListener("click", event => event.stopPropagation())
    );
  }

  function googleMapsDirectionsUrl(landmark) {
    const destination = encodeURIComponent(`${landmark.lat},${landmark.lng}`);
    return `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
  }

  function selectLandmark(id) {
    const lm = loadLandmarks().find(x => x.id === id);
    if (!lm) return;
    state.selectedLandmarkId = id;
    map.setView([lm.lat, lm.lng], 19);
    const marker = state.landmarkMarkers.get(id);
    if (marker) marker.openPopup();
    searchInput.value = lm.name;
    searchResults.innerHTML = "";
    checkArrival();
    updateDirectionButton();
    if (state.routeActive) updateRouteGuidance();
  }

  searchInput.addEventListener("input", refreshSearch);
  searchInput.addEventListener("focus", refreshSearch);

  // ---------- Arrival check ----------
  function checkArrival() {
    if (state.mode !== "OUTDOOR" || !state.userLatLng || !state.selectedLandmarkId) return;
    const lm = loadLandmarks().find(x => x.id === state.selectedLandmarkId);
    if (!lm) return;
    const d = haversine(state.userLatLng, lm);
    if (d <= ARRIVAL_RADIUS_M && state.arrivedGateId !== lm.id) {
      state.arrivedGateId = lm.id;
      showToast();
    }
  }

  function showToast() {
    const t = $("#arrivalToast");
    t.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (t.hidden = true), 6000);
  }

  function updateDirectionButton() {
    const btn = $("#startDirectionsBtn");
    if (!btn) return;
    btn.textContent = state.routeActive ? "Stop directions" : "Start giving direction";
    btn.classList.toggle("active", state.routeActive);
  }

  function speakText(text, { critical = false, offRoute = false, turnAlert = false } = {}) {
    if (!text || !("speechSynthesis" in window)) return;
    const now = Date.now();
    if (!offRoute && !turnAlert && text === lastSpokenText) return false;
    if (!critical && !turnAlert && now - lastSpokenTime < SPEECH_COOLDOWN) return false;
    const synth = window.speechSynthesis;
    if (typeof synth.cancel === "function") synth.cancel();
    const spoken = new SpeechSynthesisUtterance(text);
    spoken.rate = 1;
    spoken.pitch = 1;
    spoken.lang = "en-US";
    synth.speak(spoken);
    lastSpokenText = text;
    lastSpokenTime = now;
    return true;
  }

  function resetRouteSpeechTracking() {
    lastStraightAnnouncementDistance = null;
    routeClosestDistanceM = null;
    routeOffRoute = false;
    routeTurnTriggeredNodeId = null;
    routeSpeechDestinationId = null;
  }

  function getSelectedDestination() {
    if (!state.selectedLandmarkId) return null;
    return loadLandmarks().find(lm => lm.id === state.selectedLandmarkId) || null;
  }

  function normalizeDelta(deg) {
    return ((deg % 360) + 360) % 360;
  }

  function describeTurn(deltaDegrees) {
    const normalized = normalizeDelta(deltaDegrees);
    if (normalized >= 30 && normalized <= 150) return "Turn right";
    if (normalized >= 210 && normalized <= 330) return "Turn left";
    if (normalized < 30 || normalized > 330) return "Go straight";
    return "Turn around";
  }

  function getTargetBearing(destination) {
    if (!state.userLatLng) return null;
    const lat1 = toRad(state.userLatLng.lat);
    const lat2 = toRad(destination.lat);
    const dLng = toRad(destination.lng - state.userLatLng.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
    return bearing;
  }

  function findHallwayRoute(start, destination, geo, floor) {
    if (!start || !destination || !geo || !Array.isArray(geo.features)) return null;
    const activeFloor = feature =>
      feature?.properties?.floor == null || Number(feature.properties.floor) === Number(floor);
    const hallwayLines = [];
    for (const feature of geo.features) {
      if (feature?.properties?.type !== "hallway" || !activeFloor(feature)) continue;
      const geometry = feature.geometry;
      const lines = geometry?.type === "LineString"
        ? [geometry.coordinates]
        : geometry?.type === "MultiLineString" ? geometry.coordinates : [];
      for (const line of lines) {
        if (!Array.isArray(line)) continue;
        for (let i = 0; i < line.length - 1; i++) {
          if (isCoordinatePair(line[i]) && isCoordinatePair(line[i + 1])) {
            hallwayLines.push([line[i], line[i + 1]]);
          }
        }
      }
    }
    if (!hallwayLines.length) return null;

    const origin = hallwayLines[0][0];
    const localStart = toLocalMeters([start.lng, start.lat], origin);
    const localDestination = toLocalMeters([destination.lng, destination.lat], origin);
    const toLocal = point => toLocalMeters(point, origin);
    const segments = hallwayLines.map(([a, b]) => ({
      a: toLocal(a),
      b: toLocal(b),
      breaks: [0, 1],
    }));

    for (let i = 0; i < segments.length; i++) {
      const a = segments[i];
      const adx = a.b[0] - a.a[0], ady = a.b[1] - a.a[1];
      for (let j = i + 1; j < segments.length; j++) {
        const b = segments[j];
        const bdx = b.b[0] - b.a[0], bdy = b.b[1] - b.a[1];
        const denominator = adx * bdy - ady * bdx;
        if (Math.abs(denominator) < 1e-8) continue;
        const dx = b.a[0] - a.a[0], dy = b.a[1] - a.a[1];
        const t = (dx * bdy - dy * bdx) / denominator;
        const u = (dx * ady - dy * adx) / denominator;
        if (t >= -1e-8 && t <= 1 + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8) {
          a.breaks.push(Math.max(0, Math.min(1, t)));
          b.breaks.push(Math.max(0, Math.min(1, u)));
        }
      }
    }

    const nodes = new Map();
    const edges = [];
    const nodeFor = point => {
      const key = `${Math.round(point[0] * 10)},${Math.round(point[1] * 10)}`;
      if (!nodes.has(key)) nodes.set(key, { id: key, point });
      return nodes.get(key);
    };
    for (const segment of segments) {
      const dx = segment.b[0] - segment.a[0], dy = segment.b[1] - segment.a[1];
      const breaks = [...new Set(segment.breaks.map(value => Math.round(value * 1e8) / 1e8))].sort((a, b) => a - b);
      for (let i = 0; i < breaks.length - 1; i++) {
        const a = nodeFor([segment.a[0] + dx * breaks[i], segment.a[1] + dy * breaks[i]]);
        const b = nodeFor([segment.a[0] + dx * breaks[i + 1], segment.a[1] + dy * breaks[i + 1]]);
        const length = Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1]);
        if (length > 0.01) edges.push({ id: edges.length, a, b, length });
      }
    }

    const nearestPoint = point => {
      let nearest = null;
      for (const edge of edges) {
        const dx = edge.b.point[0] - edge.a.point[0];
        const dy = edge.b.point[1] - edge.a.point[1];
        const lengthSquared = dx * dx + dy * dy;
        const ratio = Math.max(0, Math.min(1,
          ((point[0] - edge.a.point[0]) * dx + (point[1] - edge.a.point[1]) * dy) / lengthSquared
        ));
        const projected = [edge.a.point[0] + ratio * dx, edge.a.point[1] + ratio * dy];
        const distance = Math.hypot(point[0] - projected[0], point[1] - projected[1]);
        if (!nearest || distance < nearest.distance) {
          nearest = { edge, ratio, point: projected, distance };
        }
      }
      return nearest;
    };
    const source = nearestPoint(localStart);
    const target = nearestPoint(localDestination);
    if (!source || !target || source.distance > SNAP_MAX_DISTANCE_M || target.distance > 30) return null;

    const adjacency = new Map();
    const connect = (a, b, length) => {
      if (!adjacency.has(a.id)) adjacency.set(a.id, []);
      if (!adjacency.has(b.id)) adjacency.set(b.id, []);
      adjacency.get(a.id).push({ node: b, length });
      adjacency.get(b.id).push({ node: a, length });
    };
    for (const node of nodes.values()) adjacency.set(node.id, []);
    for (const edge of edges) connect(edge.a, edge.b, edge.length);

    const sourceNode = { id: "__route_source", point: source.point };
    const targetNode = { id: "__route_target", point: target.point };
    adjacency.set(sourceNode.id, []);
    adjacency.set(targetNode.id, []);
    connect(sourceNode, source.edge.a, source.edge.length * source.ratio);
    connect(sourceNode, source.edge.b, source.edge.length * (1 - source.ratio));
    connect(targetNode, target.edge.a, target.edge.length * target.ratio);
    connect(targetNode, target.edge.b, target.edge.length * (1 - target.ratio));
    if (source.edge.id === target.edge.id) {
      connect(sourceNode, targetNode,
        Math.hypot(source.point[0] - target.point[0], source.point[1] - target.point[1]));
    }

    const distances = new Map([[sourceNode.id, 0]]);
    const previous = new Map();
    const pending = new Set(adjacency.keys());
    while (pending.size) {
      let current = null, currentDistance = Infinity;
      for (const id of pending) {
        const distance = distances.get(id) ?? Infinity;
        if (distance < currentDistance) {
          current = id;
          currentDistance = distance;
        }
      }
      if (current == null || current === targetNode.id) break;
      pending.delete(current);
      for (const edge of adjacency.get(current)) {
        const distance = currentDistance + edge.length;
        if (distance < (distances.get(edge.node.id) ?? Infinity)) {
          distances.set(edge.node.id, distance);
          previous.set(edge.node.id, current);
        }
      }
    }
    if (!distances.has(targetNode.id)) return null;
    const pathIds = [];
    for (let id = targetNode.id; id != null; id = previous.get(id)) {
      pathIds.push(id);
      if (id === sourceNode.id) break;
    }
    pathIds.reverse();
    if (pathIds[0] !== sourceNode.id) return null;
    const path = pathIds.map(id => id === sourceNode.id
      ? sourceNode : id === targetNode.id ? targetNode : nodes.get(id));
    const bearingBetween = (a, b) =>
      normalizeDelta(toDeg(Math.atan2(b.point[0] - a.point[0], b.point[1] - a.point[1])));
    let distanceToNode = 0;
    let nextTurn = null;
    for (let i = 1; i < path.length - 1; i++) {
      const incomingDistance = Math.hypot(
        path[i].point[0] - path[i - 1].point[0],
        path[i].point[1] - path[i - 1].point[1]
      );
      const outgoingDistance = Math.hypot(
        path[i + 1].point[0] - path[i].point[0],
        path[i + 1].point[1] - path[i].point[1]
      );
      const incomingBearing = bearingBetween(path[i - 1], path[i]);
      const outgoingBearing = bearingBetween(path[i], path[i + 1]);
      const routeTurn = describeTurn(normalizeDelta(outgoingBearing - incomingBearing));
      distanceToNode += incomingDistance;
      if (routeTurn !== "Go straight" && routeTurn !== "Turn around") {
        nextTurn = {
          nodeId: path[i].id,
          distanceM: distanceToNode,
          bearing: outgoingBearing,
        };
        break;
      }
      if (outgoingDistance <= 0.01) continue;
    }
    return {
      distanceM: distances.get(targetNode.id),
      bearing: path.length > 1 ? bearingBetween(path[0], path[1]) : null,
      nextTurn,
      waypoints: path.map(node => node.point),
    };
  }

  function updateRouteGuidance() {
    if (!state.routeActive) return;
    const destination = getSelectedDestination();
    if (!destination) return;
    if (routeSpeechDestinationId !== destination.id) {
      resetRouteSpeechTracking();
      routeSpeechDestinationId = destination.id;
    }

    let distanceMeters = null;
    let bearing = null;
    let upcomingTurn = null;

    if (state.mode === "OUTDOOR" && state.userLatLng) {
      distanceMeters = haversine(state.userLatLng, destination);
      bearing = getTargetBearing(destination);
    } else if (state.mode === "INDOOR" && state.anchor) {
      const route = state.floorGeo && state.userLatLng
        ? findHallwayRoute(state.userLatLng, destination, state.floorGeo, state.anchor.floor)
        : null;
      if (route) {
        distanceMeters = route.distanceM;
        bearing = route.bearing;
        upcomingTurn = route.nextTurn;
      } else {
        const targetEastMeters = (destination.lng - state.anchor.lng) * 111320 * Math.cos(toRad(state.anchor.lat));
        const targetNorthMeters = (destination.lat - state.anchor.lat) * 111320;
        const dx = targetEastMeters - state.pdrOffsetMeters.x;
        const dy = targetNorthMeters - state.pdrOffsetMeters.y;
        distanceMeters = Math.hypot(dx, dy);
        bearing = (toDeg(Math.atan2(dx, dy)) + 360) % 360;
      }
    }

    if (distanceMeters == null || !Number.isFinite(distanceMeters) || distanceMeters < 0) return;
    if (!upcomingTurn || upcomingTurn.nodeId !== routeTurnTriggeredNodeId) {
      routeTurnTriggeredNodeId = null;
    }
    if (distanceMeters <= ROUTE_ARRIVAL_RADIUS_M) {
      state.routeActive = false;
      updateDirectionButton();
      resetRouteSpeechTracking();
      speakText("You have arrived at your destination.", { critical: true });
      return;
    }

    if (upcomingTurn) {
      const turnDirection = describeTurn(normalizeDelta(upcomingTurn.bearing - state.heading));
      if (turnDirection !== "Go straight" && turnDirection !== "Turn around" &&
          upcomingTurn.distanceM <= TURN_PROMPT_DISTANCE_M) {
        if (routeTurnTriggeredNodeId !== upcomingTurn.nodeId) {
          routeTurnTriggeredNodeId = upcomingTurn.nodeId;
          speakText(`In ${Math.max(0, Math.round(upcomingTurn.distanceM))} meters, ${turnDirection.toLowerCase()}.`, {
            turnAlert: true,
          });
        }
        return;
      }
    }

    if (routeClosestDistanceM == null) {
      routeClosestDistanceM = distanceMeters;
    } else if (distanceMeters < routeClosestDistanceM - 2) {
      routeClosestDistanceM = distanceMeters;
      routeOffRoute = false;
    } else if (!routeOffRoute && distanceMeters > routeClosestDistanceM + STRAIGHT_UPDATE_DISTANCE_M) {
      routeOffRoute = true;
      routeClosestDistanceM = distanceMeters;
      speakText(`You appear to be moving farther from ${destination.name}. Reorient toward it.`, {
        critical: true,
        offRoute: true,
      });
      return;
    }

    const directionText = describeTurn(normalizeDelta((bearing ?? 0) - state.heading));
    const roundedDistance = Math.max(0, Math.round(distanceMeters));
    if (directionText === "Go straight") {
      const distanceChanged = lastStraightAnnouncementDistance == null ||
        Math.abs(distanceMeters - lastStraightAnnouncementDistance) > STRAIGHT_UPDATE_DISTANCE_M;
      if (!distanceChanged) return;
      if (speakText(`Continue straight. ${roundedDistance} meters remaining.`)) {
        lastStraightAnnouncementDistance = distanceMeters;
      }
      return;
    }

    speakText(`Continue toward ${destination.name}.`);
  }

  // ---------- Outdoor: Geolocation ----------
  function startGeoWatch() {
    if (!navigator.geolocation) {
      alert("Geolocation is unavailable in this browser. Use Debug → Jump GPS for a desktop simulation.");
      return;
    }
    if (state.watchId != null) return;
    state.watchId = navigator.geolocation.watchPosition(
      pos => {
        if (state.mode !== "OUTDOOR") return;
        setUserPosition(pos.coords.latitude, pos.coords.longitude, { pan: false });
        checkArrival();
        refreshSearch();
      },
      error => {
        if (state.mode !== "OUTDOOR") return;
        console.error("Geolocation watch failed.", error);
        stopGeoWatch();
        alert("Location could not be read. Allow location access or use Debug → Jump GPS.");
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
  }
  function stopGeoWatch() {
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
  }

  // ---------- QR location handover ----------
  // Web NFC reads NDEF data, not a universally available hardware UID. Stable app links
  // are therefore the preferred cross-platform anchor key; UID matching remains legacy support.
  function normalizeUid(serial) {
    if (!serial) return "";
    return String(serial).toUpperCase().replace(/\s+/g, "").replace(/:/g, "");
  }

  function findLandmarkByUid(uid) {
    if (!uid) return null;
    const norm = normalizeUid(uid);
    return loadLandmarks().find(lm => lm.uid && normalizeUid(lm.uid) === norm) || null;
  }

  function findLandmarkByReference(reference) {
    const ref = String(reference || "").trim();
    if (!ref) return null;
    const norm = normalizeUid(ref);
    return loadLandmarks().find(lm =>
      lm.id === ref ||
      (lm.tagCode && String(lm.tagCode).toLowerCase() === ref.toLowerCase()) ||
      (lm.uid && normalizeUid(lm.uid) === norm)
    ) || null;
  }

  function buildAnchorUrl(landmark) {
    return window.PCNSQR.buildUrl({
      label: landmark.name,
      lat: landmark.lat,
      lng: landmark.lng,
      floor: landmark.floor ?? 0,
    }, window.location.href);
  }

  function showNfcStatus(message, kind = "info", title = "NFC / anchor status") {
    const panel = $("#scanStatus");
    if (!panel) return;
    panel.classList.remove("error", "success");
    if (kind === "error" || kind === "success") panel.classList.add(kind);
    $("#scanStatusTitle").textContent = title.replace(/NFC/gi, "QR");
    $("#scanStatusMessage").textContent = message;
    panel.hidden = false;
  }

  $("#scanStatusClose").addEventListener("click", () => { $("#scanStatus").hidden = true; });

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      console.warn("Clipboard API unavailable; using fallback.", error);
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }

  function anchorFromLandmark(landmark, reason) {
    if (!landmark) return false;
    state.selectedLandmarkId = landmark.id;
    promptAnchorConfirm({
      lat: landmark.lat,
      lng: landmark.lng,
      floor: landmark.floor ?? 1,
      label: landmark.name,
    }, reason || `Matched saved anchor "${landmark.name}"`);
    return true;
  }

  let activeQrScanner = null;
  let qrScannerCallback = null;

  async function stopQrScanner() {
    const scanner = activeQrScanner;
    activeQrScanner = null;
    qrScannerCallback = null;
    $("#qrModal").hidden = true;
    if (!scanner) return;
    try {
      if (scanner.isScanning) await scanner.stop();
      scanner.clear();
    } catch (error) {
      console.warn("QR camera could not be stopped cleanly.", error);
    }
  }

  async function startQrScanner(onRead) {
    if (!window.isSecureContext) {
      showNfcStatus("Camera scanning requires HTTPS or localhost. Open the secure website and try again.", "error", "Secure connection required");
      return;
    }
    if (typeof window.Html5Qrcode !== "function") {
      showNfcStatus("The QR scanner could not load. Check your internet connection and reload the page.", "error", "QR scanner unavailable");
      return;
    }
    await stopQrScanner();
    $("#qrModal").hidden = false;
    $("#qrScannerStatus").textContent = "Allow camera access, then point the rear camera at a PCNS place QR code.";
    const scanner = new window.Html5Qrcode("qrReader");
    activeQrScanner = scanner;
    qrScannerCallback = onRead;
    try {
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        async decodedText => {
          if (activeQrScanner !== scanner) return;
          const callback = qrScannerCallback;
          await stopQrScanner();
          if (callback) callback(decodedText);
        },
        () => {}
      );
    } catch (error) {
      if (activeQrScanner === scanner) {
        await stopQrScanner();
        $("#qrModal").hidden = false;
        $("#qrScannerStatus").textContent = `Camera could not start: ${error?.message || error}. Allow camera permission and use HTTPS.`;
      }
    }
  }

  function handleQrPayload(value) {
    const payload = window.PCNSQR.parsePayload(value);
    if (!payload) {
      showNfcStatus("This QR code is not a valid PCNS place code. Scan a code generated for a saved campus landmark.", "error", "QR code not recognized");
      return false;
    }
    if (payload.reference) {
      const landmark = findLandmarkByReference(payload.reference);
      if (!landmark) {
        showNfcStatus("This QR code points to a landmark that is not saved on this device. Scan a location QR code containing the place coordinates or import the landmark backup.", "error", "Place not available");
        return false;
      }
      state.selectedLandmarkId = landmark.id;
      anchorFromLandmark(landmark, `QR code scanned for "${landmark.name}"`);
      return true;
    }
    promptAnchorConfirm(payload, `QR code scanned for "${payload.label}"`);
    return true;
  }

  function consumeNfcValue(value, reason = "NFC tag read") {
    const text = String(value || "").trim();
    if (!text) return false;

    // URL on an NFC tag or a Shortcuts action may carry ?anchor=<saved-landmark-id>.
    if (/^https?:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        const reference = url.searchParams.get("anchor") || url.searchParams.get("tag") ||
          url.searchParams.get("nfc") || url.searchParams.get("uid") || url.searchParams.get("id");
        if (reference) {
          const landmark = findLandmarkByReference(reference);
          if (landmark) return anchorFromLandmark(landmark, `${reason}: matched URL anchor "${landmark.name}"`);
          showNfcStatus(`The tag link references "${reference}", but this browser has no saved landmark with that ID. Import the same PCNS JSON backup into this browser, then try again.`, "error", "Anchor not found on this device");
          return true;
        }
      } catch (error) {
        console.warn("Invalid URL read from NFC tag.", error);
      }
    }

    try {
      const payload = JSON.parse(text);
      if (payload && typeof payload === "object") {
        const reference = payload.anchor || payload.anchorId || payload.landmarkId || payload.tagCode || payload.id || payload.uid;
        if (reference) {
          const landmark = findLandmarkByReference(reference);
          if (landmark) return anchorFromLandmark(landmark, `${reason}: matched saved anchor "${landmark.name}"`);
        }
        if (validAnchor(payload)) {
          promptAnchorConfirm(payload, reason + " (coordinate payload)");
          return true;
        }
      }
    } catch (_) {
      // Plain text tag may be a saved id/tag code; try direct match next.
    }

    const landmark = findLandmarkByReference(text);
    if (landmark) return anchorFromLandmark(landmark, `${reason}: matched saved anchor "${landmark.name}"`);
    return false;
  }

  function consumeNdefEvent(event) {
    const uid = event && event.serialNumber ? String(event.serialNumber) : "";
    const legacyMatch = findLandmarkByUid(uid);
    if (legacyMatch) return anchorFromLandmark(legacyMatch, `Matched legacy NFC tag UID → "${legacyMatch.name}"`);

    const records = Array.from(event?.message?.records || []);
    for (const record of records) {
      let payload = "";
      if (record.recordType === "url" || record.recordType === "absolute-url") {
        payload = window.PCNSNFC.decodeUri(record.data);
      } else if (record.recordType === "text") {
        payload = window.PCNSNFC.decodeText(record.data);
      } else if (record.recordType === "mime" && /json/i.test(record.mediaType || "")) {
        payload = window.PCNSNFC.decodeText(record.data);
      } else {
        // Some writers store JSON as an untyped text-like payload. A conservative parse is safe.
        payload = window.PCNSNFC.decodeText(record.data);
      }
      if (consumeNfcValue(payload, "NFC NDEF record")) return true;
    }
    showNfcStatus(`A tag was detected${uid ? ` (UID ${uid})` : ""}, but it did not contain a PCNS anchor link or recognized payload. In Admin, select the saved landmark and choose “Write tag”, or write its copied anchor link to the tag.`, "error", "Tag read, anchor missing");
    return false;
  }

  let activeNfcController = null;

  function stopNfcScan() {
    if (activeNfcController) {
      activeNfcController.abort();
      activeNfcController = null;
    }
  }

  function browserNfcAdvice() {
    return "This browser does not expose Web NFC, so the website cannot listen for a tag tap directly. For Android, open the site in Chrome with NFC enabled and use an NDEF-compatible tag. For iPhone, use the NFC Shortcut automation to open that landmark’s copied PCNS link. You can also start from Admin → Saved landmarks → Start here for training.";
  }

  async function startNfcScan() {
    if (!window.isSecureContext) {
      showNfcStatus("NFC scanning requires HTTPS or localhost. Open the deployed HTTPS site, not an insecure local-network URL.", "error", "Secure connection required");
      return;
    }
    if (!("NDEFReader" in window)) {
      showNfcStatus(browserNfcAdvice(), "error", "Direct NFC scan unavailable");
      return;
    }
    stopNfcScan();
    const controller = new AbortController();
    activeNfcController = controller;
    const reader = new window.NDEFReader();
    showNfcStatus("Ready to read an NFC NDEF tag. Keep the phone close to the tag; this listener stops after the first read.", "info", "Scanning for NFC tag");
    reader.onreading = event => {
      if (activeNfcController !== controller) return;
      stopNfcScan();
      const consumed = consumeNdefEvent(event);
      if (consumed && !$("#nfcStatus").hidden && !$("#nfcStatus").classList.contains("error")) {
        showNfcStatus("The tag was read and matched to a saved anchor. Confirm the prompt to enter indoor mode.", "success", "NFC tag matched");
      }
    };
    reader.onreadingerror = () => {
      if (activeNfcController !== controller) return;
      stopNfcScan();
      showNfcStatus("The tag was detected but its NDEF data could not be read. Check that it is NDEF-formatted and not password-locked.", "error", "NFC read failed");
    };
    try {
      await reader.scan({ signal: controller.signal });
    } catch (error) {
      if (activeNfcController === controller) stopNfcScan();
      const name = error?.name || "Error";
      if (name === "NotAllowedError" || name === "SecurityError") {
        showNfcStatus("NFC permission was denied or blocked. Allow NFC access in the browser/site settings, then press NFC SCAN again.", "error", "NFC permission required");
      } else if (name === "NotSupportedError") {
        showNfcStatus("The browser or device does not provide a compatible NFC reader. Use a tag URL / iPhone Shortcut, or open the site in supported Chrome for Android.", "error", "NFC hardware unavailable");
      } else if (name !== "AbortError") {
        showNfcStatus(`Unable to start NFC scanning (${name}): ${error?.message || "Unknown error"}. Check device NFC and browser permissions.`, "error", "NFC scan could not start");
      }
    }
  }

  // Legacy helper: browser APIs do not reliably reveal a physical tag UID. Prefer NDEF URL records.
  async function scanUidOnly() {
    const statusEl = $("#lmUidStatus");
    statusEl.hidden = false;
    if (!("NDEFReader" in window) || !window.isSecureContext) {
      statusEl.textContent = "This browser cannot capture a hardware UID. Use Write tag / Copy NFC link instead; these work without UID lookup.";
      showNfcStatus(browserNfcAdvice(), "error", "UID scanning unavailable");
      return null;
    }
    statusEl.textContent = "Waiting for a tag… UID availability depends on browser and tag; URL records are recommended.";
    stopNfcScan();
    const controller = new AbortController();
    activeNfcController = controller;
    const reader = new window.NDEFReader();
    let timer;
    let finish;
    let completed = false;
    const reading = new Promise(resolve => {
      finish = uid => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        reader.onreading = null;
        reader.onreadingerror = null;
        if (activeNfcController === controller) stopNfcScan();
        resolve(uid);
      };
    });
    reader.onreading = event => finish(event.serialNumber || "");
    reader.onreadingerror = () => finish(null);
    controller.signal.addEventListener("abort", () => finish(null), { once: true });
    timer = setTimeout(() => finish(null), 20000);
    try {
      await reader.scan({ signal: controller.signal });
      return await reading;
    } catch (error) {
      finish(null);
      statusEl.textContent = `UID scan failed: ${error?.message || error}. Use Write tag / Copy NFC link instead.`;
      return null;
    }
  }

  function validAnchor(payload) {
    if (!payload || typeof payload !== "object" ||
        typeof payload.lat !== "number" || !Number.isFinite(payload.lat) ||
        Math.abs(payload.lat) > 90 ||
        typeof payload.lng !== "number" || !Number.isFinite(payload.lng) ||
        Math.abs(payload.lng) > 180 ||
        (payload.floor != null && !Number.isInteger(payload.floor)) ||
        (payload.label != null && typeof payload.label !== "string")) {
      return null;
    }
    return {
      lat: payload.lat,
      lng: payload.lng,
      floor: payload.floor ?? 1,
      label: payload.label?.trim() || "",
    };
  }

  function promptAnchorConfirm(p, reason) {
    const anchor = validAnchor(p);
    if (!anchor) {
      showNfcStatus("The NFC payload is not a valid PCNS anchor. Expected a saved anchor link/ID or a JSON object with numeric lat/lng and optional floor/label.", "error", "Invalid anchor payload");
      return;
    }
    const label = anchor.label || "(unnamed)";
    const ok = confirm(
      `${reason}\n\nAnchor you to:\n  ${label}\n  ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` +
      `  (floor ${anchor.floor})` +
      `\n\nSwitch to Indoor Navigation?`
    );
    if (ok) enterIndoorMode(anchor);
  }

  function handleNfcPayload(p) { promptAnchorConfirm(p, "NFC tag scanned"); }

  async function writeNfcUrl(landmark) {
    if (!("NDEFReader" in window) || !window.isSecureContext) {
      const url = buildAnchorUrl(landmark);
      const copied = await copyText(url);
      showNfcStatus(copied
        ? `This browser cannot write NFC tags. The anchor link for “${landmark.name}” was copied. Paste it into the iPhone Shortcuts “Open URLs” action or a compatible NFC-writing app.`
        : `This browser cannot write NFC tags. Copy this anchor link manually and use it in the iPhone Shortcut or an NFC-writing app: ${url}`,
      "error", "Use the anchor link instead");
      return;
    }
    const url = buildAnchorUrl(landmark);
    try {
      const writer = new window.NDEFReader();
      showNfcStatus(`Hold a writable, NDEF-compatible tag near the phone to write the URL for “${landmark.name}”.`, "info", "Ready to write NFC tag");
      await writer.write({ records: [{ recordType: "url", data: url }] });
      showNfcStatus(`Successfully wrote the anchor URL for “${landmark.name}”. Tap the tag again to verify that the correct landmark opens.`, "success", "NFC tag written");
    } catch (error) {
      const name = error?.name || "Error";
      const msg = name === "NotAllowedError"
        ? "NFC write permission was denied. Allow it in browser/site settings and retry."
        : name === "NotSupportedError"
          ? "This device cannot write NFC NDEF records. Use Copy NFC link with a compatible NFC-writing app."
          : `The tag could not be written (${name}): ${error?.message || "unknown error"}. The tag may be read-only, unsupported, or out of range.`;
      showNfcStatus(msg, "error", "NFC write failed");
    }
  }

  function processAnchorDeepLink() {
    const url = new URL(window.location.href);
    const qrPayload = window.PCNSQR.parsePayload(url.toString());
    if (qrPayload && !qrPayload.reference) {
      for (const key of ["pcns_qr", "name", "lat", "lng", "floor"]) url.searchParams.delete(key);
      try { window.history.replaceState({}, "", url.toString()); } catch (_) {}
      handleQrPayload(JSON.stringify(qrPayload));
      return;
    }
    const reference = qrPayload?.reference || url.searchParams.get("anchor") ||
      url.searchParams.get("tag") || url.searchParams.get("nfc");
    if (!reference) return;
    const landmark = findLandmarkByReference(reference);
    if (!landmark) {
      showNfcStatus(`This link points to “${reference}”, but the landmark is not saved in this browser. Import the matching JSON backup from Admin and reopen the link.`, "error", "Place not available");
      return;
    }
    url.searchParams.delete("anchor");
    url.searchParams.delete("tag");
    url.searchParams.delete("nfc");
    try { window.history.replaceState({}, "", url.toString()); } catch (_) {}
    state.selectedLandmarkId = landmark.id;
    anchorFromLandmark(landmark, `Opened QR place for "${landmark.name}"`);
  }

  // ---------- Indoor / PDR ----------
  function enterIndoorMode(anchor) {
    if (calibrationWizard.state === CALIBRATION_STATES.RECORDING) {
      stopCalibrationRecording("Indoor anchor changed. Enter the measured distance to save this walk.");
    }
    stopGeoWatch();
    stopSensors();
    state.mode = "INDOOR";
    resetRouteSpeechTracking();
    state.anchor = { lat: anchor.lat, lng: anchor.lng, floor: anchor.floor ?? 1, label: anchor.label || "" };
    state.stepCount = 0;
    state.pdrOffsetMeters = { x: 0, y: 0 };
    state.lastStepTs = 0;
    state.stepSignalAbove = false;
    $("#hudMode").textContent = `INDOOR${anchor.label ? " • " + anchor.label : ""}`;
    $("#hudMode").classList.add("indoor");
    $("#arrivalToast").hidden = true;
    setUserPosition(state.anchor.lat, state.anchor.lng, { pan: true });
    // Auto-switch floor to anchor floor + prefill drop-floor input
    setCurrentFloor(Number(state.anchor.floor));
    $("#dropFloor").value = String(state.anchor.floor);
    loadFloorGeo();
    startSensors();
    updateDropMarkerVisibility();
    updateTrainingHud();
  }

  function exitIndoorMode() {
    if (calibrationWizard.state === CALIBRATION_STATES.RECORDING) {
      stopCalibrationRecording("Indoor mode ended. Enter the measured distance to save this walk.");
    }
    state.mode = "OUTDOOR";
    resetRouteSpeechTracking();
    state.anchor = null;
    $("#hudMode").textContent = "OUTDOOR";
    $("#hudMode").classList.remove("indoor");
    clearFloorGeo();
    stopSensors();
    updateDropMarkerVisibility();
    startGeoWatch();
  }

  function updatePdrPosition() {
    if (state.mode !== "INDOOR" || !state.anchor) return;
    const { x, y } = state.pdrOffsetMeters;
    let { lat, lng } = offsetLatLng(state.anchor.lat, state.anchor.lng, x, y);
    // path snapping
    const snapped = snapToHallway(lat, lng);
    if (snapped) ({ lat, lng } = snapped);
    setUserPosition(lat, lng, { pan: false });
    refreshSearch();
  }

  function addStep() {
    state.stepCount += 1;
    const theta = toRad(state.heading); // 0° = North (heading convention)
    // East = sin(theta), North = cos(theta); stride is learned from measured walks when calibrated.
    const strideLength = Number.isFinite(state.strideLengthM) ? state.strideLengthM : DEFAULT_STEP_LENGTH_M;
    const dx = strideLength * Math.sin(theta); // east
    const dy = strideLength * Math.cos(theta); // north
    state.pdrOffsetMeters.x += dx;
    state.pdrOffsetMeters.y += dy;
    $("#hudSteps").textContent = String(state.stepCount);
    updatePdrPosition();
    updateTrainingHud();
    updateCalibrationWizardSteps();
  }

  function updateTrainingHud() {
    if (!state.training) return;
    const fmt = (n) => (n >= 0 ? "+" : "") + n.toFixed(2);
    $("#hudX").textContent = fmt(state.pdrOffsetMeters.x);
    $("#hudY").textContent = fmt(state.pdrOffsetMeters.y);
  }

  function setHeading(deg) {
    state.heading = ((deg % 360) + 360) % 360;
    $("#hudHeading").textContent = Math.round(state.heading) + "°";
    if (state.routeActive) updateRouteGuidance();
  }

  // ---------- Sensors ----------
  let motionHandler = null, orientHandler = null;
  let sensorGeneration = 0;

  async function startSensors() {
    stopSensors();
    const generation = sensorGeneration;
    let motionAllowed = typeof DeviceMotionEvent !== "undefined";
    let orientationAllowed = typeof DeviceOrientationEvent !== "undefined";
    try {
      if (motionAllowed && typeof DeviceMotionEvent.requestPermission === "function") {
        motionAllowed = await DeviceMotionEvent.requestPermission() === "granted";
      }
      if (orientationAllowed && typeof DeviceOrientationEvent.requestPermission === "function") {
        orientationAllowed = await DeviceOrientationEvent.requestPermission() === "granted";
      }
    } catch (error) {
      console.error("Motion sensor permission request failed.", error);
      motionAllowed = false;
      orientationAllowed = false;
    }
    if (generation !== sensorGeneration) return;

    if (!motionAllowed && !orientationAllowed) {
      alert("Motion and heading sensors are unavailable or permission was denied. Use the Debug panel to simulate indoor movement.");
      return;
    }
    if (!motionAllowed) {
      alert("Step detection is unavailable or motion permission was denied. Indoor heading may still work; use Debug to simulate steps.");
    } else if (!orientationAllowed) {
      alert("Heading is unavailable or orientation permission was denied. Indoor step counts may still work; use Debug to set heading.");
    }

    if (motionAllowed) {
      motionHandler = (e) => {
        const usesLinearAcceleration = !!e.acceleration;
        const a = e.acceleration || e.accelerationIncludingGravity;
        if (!a) return;
        const magnitude = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2);
        const signal = usesLinearAcceleration ? magnitude : Math.abs(magnitude - 9.81);
        const now = Date.now();
        if (signal >= STEP_SIGNAL_THRESHOLD && !state.stepSignalAbove) {
          if (now - state.lastStepTs > STEP_MIN_INTERVAL_MS) {
            state.lastStepTs = now;
            addStep();
          }
          state.stepSignalAbove = true;
        } else if (signal <= STEP_RELEASE_THRESHOLD) {
          state.stepSignalAbove = false;
        }
      };
      window.addEventListener("devicemotion", motionHandler);
    }
    if (orientationAllowed) {
      orientHandler = (e) => {
        // webkitCompassHeading is absolute on iOS; alpha may be device-relative.
        const h = (typeof e.webkitCompassHeading === "number")
          ? e.webkitCompassHeading
          : (typeof e.alpha === "number" ? 360 - e.alpha : null);
        if (h != null) setHeading(h);
      };
      window.addEventListener("deviceorientation", orientHandler);
    }
  }

  function stopSensors() {
    sensorGeneration += 1;
    if (motionHandler) window.removeEventListener("devicemotion", motionHandler);
    if (orientHandler) window.removeEventListener("deviceorientation", orientHandler);
    motionHandler = orientHandler = null;
    state.stepSignalAbove = false;
  }

  // ---------- Floor GeoJSON + path snapping ----------
  let floorLayer = null;

  async function loadFloorGeo() {
    const requestedAnchor = state.anchor;
    try {
      const res = await fetch("demo-floor.geojson");
      if (!res.ok) throw new Error(`Floor plan request failed with HTTP ${res.status}.`);
      const geo = await res.json();
      if (geo?.type !== "FeatureCollection" || !Array.isArray(geo.features) ||
          geo.features.some(feature =>
            !feature || feature.type !== "Feature" ||
            !feature.geometry || typeof feature.geometry.type !== "string" ||
            !Array.isArray(feature.geometry.coordinates)
          )) {
        throw new TypeError("Floor plan must be a GeoJSON FeatureCollection with valid feature geometries.");
      }
      if (state.mode !== "INDOOR" || state.anchor !== requestedAnchor) return;
      state.floorGeo = geo;
      if (floorLayer) map.removeLayer(floorLayer);
      floorLayer = L.geoJSON(geo, {
        style: (f) => f.properties?.type === "wall"
          ? { color: "#9B30FF", weight: 1, fillColor: "#241238", fillOpacity: 0.5 }
          : { color: "#f5f2ff", weight: 2, dashArray: "4 4" },
      }).addTo(map);
      applyFloorFilterToGeo();
    } catch (error) {
      if (state.mode === "INDOOR" && state.anchor === requestedAnchor) {
        console.error("Indoor floor plan could not be loaded.", error);
        alert("The indoor floor plan could not be loaded. Position tracking will continue without map matching.");
      }
    }
  }
  function clearFloorGeo() {
    if (floorLayer) { map.removeLayer(floorLayer); floorLayer = null; }
    state.floorGeo = null;
  }

  function toLocalMeters(point, origin) {
    const latitudeScale = Math.cos(toRad(origin[1]));
    return [
      (point[0] - origin[0]) * Math.PI / 180 * R * latitudeScale,
      (point[1] - origin[1]) * Math.PI / 180 * R,
    ];
  }

  function nearestPointOnSegment(p, a, b) {
    const pm = toLocalMeters(p, p);
    const am = toLocalMeters(a, p);
    const bm = toLocalMeters(b, p);
    const dx = bm[0] - am[0], dy = bm[1] - am[1];
    const len2 = dx * dx + dy * dy || 1e-18;
    let t = ((pm[0] - am[0]) * dx + (pm[1] - am[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = am[0] + t * dx;
    const qy = am[1] + t * dy;
    const latitudeScale = Math.cos(toRad(p[1]));
    const q = [
      p[0] + qx / (R * latitudeScale) * 180 / Math.PI,
      p[1] + qy / R * 180 / Math.PI,
    ];
    return { point: q, distance: Math.hypot(pm[0] - qx, pm[1] - qy) };
  }

  function isCoordinatePair(point) {
    return Array.isArray(point) && point.length >= 2 &&
      Number.isFinite(point[0]) && Number.isFinite(point[1]);
  }

  function snapToHallway(lat, lng) {
    const geo = state.floorGeo;
    if (!geo || !Array.isArray(geo.features)) return null;
    const pt = [lng, lat];
    const activeFloor = state.anchor?.floor;
    const onActiveFloor = feature =>
      feature?.properties?.floor == null || Number(feature.properties.floor) === Number(activeFloor);
    const halls = geo.features.filter(f =>
      f?.properties?.type === "hallway" && onActiveFloor(f) && f.geometry
    );
    let best = null, bestDistance = Infinity;
    for (const h of halls) {
      const geometry = h.geometry;
      const lines = geometry.type === "LineString"
        ? [geometry.coordinates]
        : (geometry.type === "MultiLineString" ? geometry.coordinates : []);
      for (const coords of lines) {
        if (!Array.isArray(coords)) continue;
        for (let i = 0; i < coords.length - 1; i++) {
          if (!isCoordinatePair(coords[i]) || !isCoordinatePair(coords[i + 1])) continue;
          const candidate = nearestPointOnSegment(pt, coords[i], coords[i + 1]);
          if (candidate.distance < bestDistance) {
            bestDistance = candidate.distance;
            best = candidate.point;
          }
        }
      }
    }
    if (!best || bestDistance > SNAP_MAX_DISTANCE_M) return null;
    return { lat: best[1], lng: best[0] };
  }

  // ---------- Admin ----------
  function openModal(id) { $("#" + id).hidden = false; }
  function closeModal(id) { $("#" + id).hidden = true; }

  document.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => closeModal(b.dataset.close))
  );

  $("#adminBtn").addEventListener("click", () => {
    openModal("adminModal");
    $("#adminLogin").hidden = false;
    $("#adminPanel").hidden = true;
    $("#adminPass").value = "";
    $("#adminLoginErr").hidden = true;
  });

  // ---------- Password hashing ----------
  async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, "0")).join("");
  }
  async function verifyAdminPass(input) {
    const storedHash = readStoredSetting(LS.adminHash);
    if (storedHash) {
      const h = await sha256Hex(input);
      return h === storedHash;
    }
    // Legacy plain (or factory default fallback)
    const legacy = readStoredSetting(LS.adminPass) || ADMIN_PASSWORD;
    return input === legacy;
  }

  $("#adminLoginBtn").addEventListener("click", async () => {
    const ok = await verifyAdminPass($("#adminPass").value);
    if (ok) {
      $("#adminLogin").hidden = true;
      $("#adminPanel").hidden = false;
      renderLandmarkList();
    } else {
      $("#adminLoginErr").hidden = false;
    }
  });
  $("#adminPass").addEventListener("keydown", e => {
    if (e.key === "Enter") $("#adminLoginBtn").click();
  });
  $("#adminLogoutBtn").addEventListener("click", () => {
    $("#adminLogin").hidden = false;
    $("#adminPanel").hidden = true;
  });

  $("#lmPaste").addEventListener("input", () => {
    const c = parseCoords($("#lmPaste").value);
    if (c) { $("#lmLat").value = c.lat; $("#lmLng").value = c.lng; }
  });

  $("#qrBtn").addEventListener("click", () => {
    startQrScanner(value => handleQrPayload(value));
  });
  $("#qrCloseBtn").addEventListener("click", stopQrScanner);
  $("#qrModal").addEventListener("click", event => {
    if (event.target.id === "qrModal") stopQrScanner();
  });
  $("#lmScanQrBtn").addEventListener("click", () => {
    $("#lmQrStatus").hidden = false;
    $("#lmQrStatus").textContent = "Point the camera at a saved PCNS place QR code.";
    startQrScanner(value => {
      const payload = window.PCNSQR.parsePayload(value);
      if (!payload || payload.reference) {
        $("#lmQrStatus").textContent = "That code does not contain place name and coordinates. Scan a PCNS place QR code.";
        return;
      }
      $("#lmName").value = payload.label;
      $("#lmLat").value = String(payload.lat);
      $("#lmLng").value = String(payload.lng);
      $("#lmFloor").value = String(payload.floor);
      $("#lmQrStatus").textContent = `Filled place details for ${payload.label}. Review them, then choose Add landmark.`;
    });
  });

  $("#lmAddBtn").addEventListener("click", () => {
    const name = $("#lmName").value.trim();
    const lat = parseFloat($("#lmLat").value);
    const lng = parseFloat($("#lmLng").value);
    const floorText = $("#lmFloor").value.trim();
    const floor = floorText ? $("#lmFloor").valueAsNumber : null;
    const err = $("#lmErr");
    err.hidden = true;
    if (!name) { err.textContent = "Name required."; err.hidden = false; return; }
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 ||
        !Number.isFinite(lng) || Math.abs(lng) > 180) {
      err.textContent = "Enter a latitude between -90 and 90 and a longitude between -180 and 180.";
      err.hidden = false;
      return;
    }
    if (floorText && !Number.isInteger(floor)) {
      err.textContent = "Floor must be a whole number.";
      err.hidden = false;
      return;
    }
    const list = loadLandmarks();
    const landmark = { id: "lm_" + Date.now().toString(36), name, lat, lng };
    if (floor != null) landmark.floor = floor;
    list.push(landmark);
    if (!saveLandmarks(list)) return;
    $("#lmName").value = ""; $("#lmPaste").value = "";
    $("#lmLat").value = ""; $("#lmLng").value = "";
    $("#lmFloor").value = "";
    $("#lmQrStatus").hidden = true;
    renderLandmarkMarkers(); renderLandmarkList(); refreshSearch();
  });

  function renderLandmarkList() {
    const ul = $("#lmList");
    const list = loadLandmarks();
    if (list.length === 0) {
      ul.innerHTML = `<li class="meta" style="justify-content:center">No landmarks yet.</li>`;
      return;
    }
    ul.innerHTML = list.map(lm => `
      <li data-testid="lm-item-${lm.id}">
        <div class="lm-details">
          <div>${escapeHtml(lm.name)}${lm.source === "training" ? ' <span class="badge">TRAINING</span>' : ""}${lm.floor != null ? ` <span class="badge">F${lm.floor}</span>` : ""}</div>
          <div class="meta">${lm.lat.toFixed(5)}, ${lm.lng.toFixed(5)}</div>
        </div>
        <div class="lm-actions">
          <button type="button" data-action="start" data-id="${lm.id}" title="Start indoor mode at this saved anchor">Start here</button>
          <button type="button" data-action="copy-link" data-id="${lm.id}" title="Copy this place's QR destination link">Copy QR link</button>
          <button type="button" data-action="delete" data-id="${lm.id}" title="Delete landmark">✕</button>
        </div>
      </li>`).join("");

    ul.querySelectorAll("button[data-action][data-id]").forEach(button => {
      button.addEventListener("click", async () => {
        const action = button.dataset.action;
        const id = button.dataset.id;
        const landmark = loadLandmarks().find(item => item.id === id);
        if (!landmark) return;
        if (action === "delete") {
          if (!confirm(`Delete landmark “${landmark.name}”? This cannot be undone unless you have a JSON backup.`)) return;
          if (!saveLandmarks(loadLandmarks().filter(item => item.id !== id))) return;
          renderLandmarkMarkers(); renderLandmarkList(); refreshSearch();
        } else if (action === "start") {
          state.selectedLandmarkId = landmark.id;
          closeModal("adminModal");
          anchorFromLandmark(landmark, `Selected saved training anchor “${landmark.name}”`);
        } else if (action === "copy-link") {
          const url = buildAnchorUrl(landmark);
          const copied = await copyText(url);
          showNfcStatus(copied
            ? `QR destination link copied for "${landmark.name}".`
            : `Copy this QR destination link for "${landmark.name}": ${url}`,
          copied ? "success" : "info", "QR destination link");
        }
      });
    });
  }

  // ---------- Training Mode ----------
  function setTrainingMode(on) {
    state.training = !!on;
    writeStoredSetting(LS.training, state.training ? "1" : "0");
    document.body.classList.toggle("training-on", state.training);
    $("#trainingBanner").hidden = !state.training;
    $("#hudXY").hidden = !state.training;
    // Drop marker only shows when training AND indoor
    updateDropMarkerVisibility();
    updateTrainingHud();
    const tog = $("#trainingToggle");
    if (tog) tog.checked = state.training;
  }

  function updateDropMarkerVisibility() {
    const show = state.training && state.mode === "INDOOR";
    $("#dropMarkerBtn").hidden = !show;
    $("#dropFloorWrap").hidden = !show;
  }

  $("#trainingToggle").addEventListener("change", (e) => setTrainingMode(e.target.checked));

  // ---------- Floor Heatmap ----------
  function setHeatmapMode(on) {
    state.heatmap = !!on;
    writeStoredSetting(LS.heatmap, state.heatmap ? "1" : "0");
    const tog = $("#heatmapToggle");
    if (tog) tog.checked = state.heatmap;
    renderLandmarkMarkers();
    applyFloorFilterToGeo();
  }
  $("#heatmapToggle").addEventListener("change", (e) => setHeatmapMode(e.target.checked));

  // ---------- CSV Export ----------
  function csvCell(v, isText = false) {
    if (v == null) return "";
    let s = String(v);
    if (isText && /^\s*[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  $("#exportCsvBtn").addEventListener("click", () => {
    const training = loadLandmarks().filter(l => l.source === "training");
    if (training.length === 0) {
      alert("No training markers to export yet.");
      return;
    }
    const header = ["name", "lat", "lng", "floor", "anchor", "x", "y"];
    const rows = training.map(l => [
      l.name, l.lat, l.lng, l.floor ?? "", l.anchor ?? "",
      l.offset?.x ?? "", l.offset?.y ?? "",
    ].map((value, index) => csvCell(value, index === 0 || index === 4)).join(","));
    const csv = header.join(",") + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    a.href = objectUrl;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `pcns-training-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  });

  // ---------- Supervised PDR calibration model ----------
  function loadCalibrationSamples() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS.calibrationSamples) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(s => s && Number.isInteger(s.steps) && s.steps > 0 &&
        Number.isFinite(Number(s.distanceM)) && Number(s.distanceM) > 0)
        .map(s => ({ steps: Number(s.steps), distanceM: Number(s.distanceM), createdAt: s.createdAt || null }));
    } catch (error) {
      console.warn("Calibration samples could not be loaded.", error);
      return [];
    }
  }

  function saveCalibrationSamples(samples) {
    return writeStoredSetting(LS.calibrationSamples, JSON.stringify(samples));
  }

  function loadCalibrationModel() {
    try {
      const model = JSON.parse(localStorage.getItem(LS.calibrationModel) || "null");
      if (!model || model.modelType !== "supervised-linear-stride-regression-v1" ||
          !Number.isFinite(model.strideLengthM) || model.strideLengthM < 0.25 || model.strideLengthM > 1.8) return null;
      return model;
    } catch (error) {
      console.warn("Calibration model could not be loaded.", error);
      return null;
    }
  }

  function setCalibrationStatus(message, kind = "info") {
    const el = $("#calibrationStatus");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("error", "success");
    if (kind === "error" || kind === "success") el.classList.add(kind);
  }

  function updateCalibrationStatus() {
    const samples = loadCalibrationSamples();
    const model = loadCalibrationModel();
    updateCalibrationProgress(samples.length);
    if (model) {
      const rmse = Number.isFinite(model.rmseM) ? `, RMSE ${model.rmseM.toFixed(2)} m` : "";
      setCalibrationStatus(`Trained model active: ${model.strideLengthM.toFixed(3)} m/step · ${model.sampleCount} measured walks${rmse}.`, "success");
    } else {
      setCalibrationStatus(`No trained model active. Using default ${DEFAULT_STEP_LENGTH_M.toFixed(2)} m/step. ${samples.length} calibration sample(s) saved; at least 2 are required to train.`, "info");
    }
  }

  const CALIBRATION_STATES = window.PCNSML.CALIBRATION_STATES;
  const calibrationWizard = window.PCNSML.createCalibrationWizard();

  function updateCalibrationProgress(sampleCount = loadCalibrationSamples().length) {
    const progress = Math.min(sampleCount, 2);
    $("#calibrationProgressText").textContent = `Sample ${progress} of 2`;
    $("#calibrationProgressFill").style.width = `${progress * 50}%`;
    $("#calibrationProgressSuccess").hidden = sampleCount < 2;
    $("#trainCalibrationBtn").disabled = sampleCount < 2;
  }

  function setCalibrationWizardStatus(message, kind = "info") {
    const el = $("#calibrationWizardStatus");
    el.textContent = message;
    el.classList.remove("error", "success");
    if (kind === "error" || kind === "success") el.classList.add(kind);
  }

  function updateCalibrationWizardSteps() {
    $("#calibrationWizardSteps").textContent = String(calibrationWizard.steps(state.stepCount));
  }

  function renderCalibrationState() {
    const isIdle = calibrationWizard.state === CALIBRATION_STATES.IDLE;
    const isRecording = calibrationWizard.state === CALIBRATION_STATES.RECORDING;
    const isInputDistance = calibrationWizard.state === CALIBRATION_STATES.INPUT_DISTANCE;
    $("#startCalibrationWizardBtn").hidden = !isIdle;
    $("#finishCalibrationWizardBtn").hidden = !isRecording;
    $("#calibrationRecordingBadge").hidden = !isRecording;
    $("#calibrationDistancePanel").hidden = !isInputDistance;
    $("#saveCalibrationWalkBtn").hidden = !isInputDistance;
    $("#discardCalibrationWalkBtn").hidden = !isInputDistance;
    $("#calibrationWizardDistance").disabled = !isInputDistance;
    updateCalibrationWizardSteps();
  }

  function playCalibrationSignal(started) {
    if (typeof navigator.vibrate === "function") navigator.vibrate(started ? [100, 60, 100] : 250);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const play = () => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(started ? 880 : 660, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.24);
      oscillator.addEventListener("ended", () => {
        context.close().catch(error => console.warn("Calibration chime audio context could not be closed.", error));
      }, { once: true });
    };
    if (context.state === "suspended") {
      context.resume().then(play).catch(error => {
        console.warn("Calibration chime could not start; vibration feedback was used if available.", error);
        context.close().catch(closeError => console.warn("Calibration chime audio context could not be closed.", closeError));
      });
    } else {
      play();
    }
  }

  function saveCalibrationSample(steps, distanceM) {
    try {
      if (!window.PCNSML || typeof window.PCNSML.createCalibrationSample !== "function") {
        throw new Error("The calibration module did not load. Refresh the page and try again.");
      }
      const sample = window.PCNSML.createCalibrationSample(steps, distanceM);
      const samples = loadCalibrationSamples();
      samples.push({ ...sample, createdAt: new Date().toISOString() });
      if (!saveCalibrationSamples(samples)) return false;
      updateCalibrationStatus();
      return true;
    } catch (error) {
      setCalibrationStatus(error.message || "The calibration sample could not be saved.", "error");
      return false;
    }
  }

  $("#startCalibrationWizardBtn").addEventListener("click", () => {
    if (state.mode !== "INDOOR" || !state.anchor) {
      setCalibrationWizardStatus("Scan an indoor QR anchor before starting a measured walk.", "error");
      return;
    }
    calibrationWizard.start(state.stepCount);
    renderCalibrationState();
    playCalibrationSignal(true);
    setCalibrationWizardStatus("Walk at your normal pace. Step recording is active.");
  });

  function stopCalibrationRecording(message = "Recording stopped. Enter the measured distance to save this walk.") {
    if (calibrationWizard.state !== CALIBRATION_STATES.RECORDING) return;
    calibrationWizard.stop(state.stepCount);
    renderCalibrationState();
    playCalibrationSignal(false);
    setCalibrationWizardStatus(message);
    $("#calibrationWizardDistance").focus();
  }

  $("#finishCalibrationWizardBtn").addEventListener("click", () => {
    stopCalibrationRecording();
  });

  $("#discardCalibrationWalkBtn").addEventListener("click", () => {
    calibrationWizard.reset();
    renderCalibrationState();
    $("#calibrationWizardDistance").value = "";
    setCalibrationWizardStatus("Walk discarded; no calibration sample was saved.");
  });

  $("#saveCalibrationWalkBtn").addEventListener("click", () => {
    const distanceM = $("#calibrationWizardDistance").valueAsNumber;
    if (!Number.isFinite(distanceM) || distanceM <= 0 || distanceM > 5000) {
      setCalibrationWizardStatus("Enter a measured distance greater than 0 and no more than 5,000 metres.", "error");
      $("#calibrationWizardDistance").focus();
      return;
    }
    const savedSteps = calibrationWizard.recordedSteps;
    if (!saveCalibrationSample(savedSteps, distanceM)) {
      setCalibrationWizardStatus($("#calibrationStatus").textContent, "error");
      return;
    }
    calibrationWizard.reset();
    renderCalibrationState();
    $("#calibrationWizardDistance").value = "";
    setCalibrationWizardStatus(
      `Saved ${savedSteps} detected steps over ${distanceM} m.`,
      "success"
    );
  });

  $("#trainCalibrationBtn").addEventListener("click", () => {
    const samples = loadCalibrationSamples();
    try {
      if (!window.PCNSML || typeof window.PCNSML.fitStrideModel !== "function") {
        throw new Error("The ML module did not load. Refresh the page and try again.");
      }
      const model = window.PCNSML.fitStrideModel(samples);
      if (!writeStoredSetting(LS.calibrationModel, JSON.stringify(model))) return;
      state.strideLengthM = model.strideLengthM;
      setCalibrationStatus(`Model trained successfully: ${model.strideLengthM.toFixed(3)} m/step · ${model.sampleCount} samples · MAE ${model.maeM.toFixed(2)} m · RMSE ${model.rmseM.toFixed(2)} m. New steps will use this calibration.`, "success");
    } catch (error) {
      setCalibrationStatus(error.message || "The model could not be trained.", "error");
    }
  });

  $("#resetCalibrationBtn").addEventListener("click", () => {
    if (!confirm("Reset the trained step-length model and remove all calibration samples?")) return;
    try {
      localStorage.removeItem(LS.calibrationSamples);
      localStorage.removeItem(LS.calibrationModel);
    } catch (error) {
      reportStorageProblem("The calibration data could not be removed from browser storage.", error);
      return;
    }
    state.strideLengthM = DEFAULT_STEP_LENGTH_M;
    updateCalibrationStatus();
  });

  // ---------- Portable map data ----------
  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $("#exportDataBtn").addEventListener("click", () => {
    const bundle = {
      format: "pcns-campus-map",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      note: "Local browser data backup. Import this file on each device that must resolve the same anchor IDs.",
      landmarks: loadLandmarks(),
      calibrationSamples: loadCalibrationSamples(),
      calibrationModel: loadCalibrationModel(),
      trainingMode: readStoredSetting(LS.training) === "1",
      heatmapMode: readStoredSetting(LS.heatmap) === "1",
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadJson(`pcns-backup-${stamp}.json`, bundle);
    $("#dataStatus").hidden = false;
    $("#dataStatus").textContent = "JSON backup created. Keep it private if it contains internal campus locations; import it on other devices that need the same anchors.";
  });

  $("#importDataBtn").addEventListener("click", () => $("#importDataFile").click());
  $("#importDataFile").addEventListener("change", async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const status = $("#dataStatus");
    status.hidden = false;
    try {
      const bundle = JSON.parse(await file.text());
      const imported = Array.isArray(bundle) ? bundle : bundle.landmarks;
      if (!Array.isArray(imported)) throw new Error("This file does not contain a landmarks array.");
      if (imported.length > 20000) throw new Error("The file contains too many landmarks to import safely.");
      const valid = imported.filter(isValidLandmark);
      if (valid.length !== imported.length) {
        throw new Error(`Import stopped: ${imported.length - valid.length} landmark record(s) are invalid. No data was changed.`);
      }
      const merged = new Map(loadLandmarks().map(lm => [lm.id, lm]));
      for (const lm of valid) merged.set(lm.id, lm);
      const all = [...merged.values()];
      const uids = new Map();
      for (const lm of all) {
        if (!lm.uid) continue;
        const normalized = normalizeUid(lm.uid);
        if (uids.has(normalized) && uids.get(normalized) !== lm.id) {
          throw new Error(`Import stopped: duplicate NFC UID on “${lm.name}” and “${uids.get(normalized)}”. Resolve duplicate UIDs and retry. No data was changed.`);
        }
        uids.set(normalized, lm.id);
      }
      if (!saveLandmarks(all)) throw new Error("Could not save imported landmarks to this browser.");
      renderLandmarkMarkers();
      renderLandmarkList();
      refreshSearch();

      if (!Array.isArray(bundle) && Array.isArray(bundle.calibrationSamples)) {
        const importedSamples = bundle.calibrationSamples.filter(sample =>
          sample && Number.isInteger(sample.steps) && sample.steps > 0 &&
          Number.isFinite(Number(sample.distanceM)) && Number(sample.distanceM) > 0
        ).map(sample => ({ steps: Number(sample.steps), distanceM: Number(sample.distanceM), createdAt: sample.createdAt || null }));
        const existingSamples = loadCalibrationSamples();
        const deduped = new Map([...existingSamples, ...importedSamples].map(sample => [`${sample.createdAt || ""}|${sample.steps}|${sample.distanceM}`, sample]));
        saveCalibrationSamples([...deduped.values()]);
        if (deduped.size >= 2 && window.PCNSML) {
          try {
            const model = window.PCNSML.fitStrideModel([...deduped.values()]);
            writeStoredSetting(LS.calibrationModel, JSON.stringify(model));
            state.strideLengthM = model.strideLengthM;
          } catch (modelError) {
            console.warn("Imported calibration samples did not produce a valid model.", modelError);
          }
        }
      }
      updateCalibrationStatus();
      status.classList.remove("error");
      status.textContent = `Imported ${valid.length} landmark(s). This device now has the anchor IDs required for the tag links.`;
      processAnchorDeepLink();
    } catch (error) {
      status.classList.add("error");
      status.textContent = error.message || "The JSON backup could not be imported.";
    } finally {
      event.target.value = "";
    }
  });

  // ---------- Change Admin Password ----------
  $("#changePassBtn").addEventListener("click", async () => {
    const status = $("#passStatus");
    const a = $("#newPass").value;
    const b = $("#newPass2").value;
    status.hidden = false;
    if (!a || a.length < 4) { status.textContent = "Password must be at least 4 characters."; return; }
    if (a !== b) { status.textContent = "Passwords do not match."; return; }
    const hash = await sha256Hex(a);
    if (!writeStoredSetting(LS.adminHash, hash)) {
      status.textContent = "Password could not be saved. Check browser storage permissions.";
      return;
    }
    try {
      localStorage.removeItem(LS.adminPass);
    } catch (error) {
      reportStorageProblem("The new password was saved, but the legacy password could not be removed.", error);
    }
    $("#newPass").value = ""; $("#newPass2").value = "";
    status.textContent = "Password updated. Hash stored locally.";
  });

  $("#dropMarkerBtn").addEventListener("click", () => {
    if (state.mode !== "INDOOR" || !state.anchor) {
      alert("Enter Indoor mode (tap an NFC anchor) before dropping markers.");
      return;
    }
    const floorInput = $("#dropFloor").valueAsNumber;
    if (!Number.isInteger(floorInput)) {
      alert("Enter a whole-number floor before dropping a marker.");
      return;
    }
    const floor = floorInput;
    const suggested = `Marker @ F${floor} (${state.pdrOffsetMeters.x.toFixed(1)}, ${state.pdrOffsetMeters.y.toFixed(1)})`;
    const name = prompt("Name this indoor marker:", suggested);
    if (!name || !name.trim()) return;
    const { x, y } = state.pdrOffsetMeters;
    const p = state.userLatLng || offsetLatLng(state.anchor.lat, state.anchor.lng, x, y);
    const list = loadLandmarks();
    list.push({
      id: "lm_" + Date.now().toString(36),
      name: name.trim(),
      lat: p.lat, lng: p.lng,
      floor,
      source: "training",
      anchor: state.anchor.label || null,
      offset: { x: +x.toFixed(3), y: +y.toFixed(3) },
    });
    if (!saveLandmarks(list)) return;
    renderLandmarkMarkers(); renderLandmarkList(); refreshSearch();
  });

  // Restore persisted training mode on boot (applied after boot section below)

  // ---------- Debug ----------
  $("#debugBtn").addEventListener("click", () => openModal("debugModal"));
  $("#simQrBtn").addEventListener("click", () => {
    handleQrPayload(window.PCNSQR.buildUrl({
      label: "E1 Main Gate, Amity University, Noida",
      lat: 28.543380,
      lng: 77.331890,
      floor: 0,
    }, window.location.href));
    closeModal("debugModal");
  });
  $("#simStepBtn").addEventListener("click", () => { if (ensureIndoor()) addStep(); });
  $("#simStep10Btn").addEventListener("click", () => {
    if (!ensureIndoor()) return;
    for (let i = 0; i < 10; i++) addStep();
  });
  $("#simHeading").addEventListener("input", (e) => setHeading(parseInt(e.target.value, 10)));
  $("#simTurnLBtn").addEventListener("click", () => { setHeading(state.heading - 15); $("#simHeading").value = Math.round(state.heading); });
  $("#simTurnRBtn").addEventListener("click", () => { setHeading(state.heading + 15); $("#simHeading").value = Math.round(state.heading); });
  $("#simGpsBtn").addEventListener("click", () => {
    const lm = loadLandmarks().find(x => x.id === state.selectedLandmarkId) || loadLandmarks()[0];
    if (!lm) { alert("Add a landmark first (Admin)."); return; }
    // place user ~3m west of the gate
    const p = offsetLatLng(lm.lat, lm.lng, -3, 0);
    setUserPosition(p.lat, p.lng, { pan: true });
    state.selectedLandmarkId = lm.id;
    searchInput.value = lm.name;
    checkArrival();
    closeModal("debugModal");
  });
  $("#simResetBtn").addEventListener("click", () => {
    exitIndoorMode();
    $("#hudSteps").textContent = "0";
    state.pdrOffsetMeters = { x: 0, y: 0 };
    updateTrainingHud();
    closeModal("debugModal");
  });

  function ensureIndoor() {
    if (state.mode !== "INDOOR") {
      alert("Enter Indoor mode first: scan a place QR code or use Debug → Simulate QR Scan.");
      return false;
    }
    return true;
  }

  // ---------- QR scanner + Resync ----------
  $("#resyncBtn").addEventListener("click", () => {
    if (state.mode === "INDOOR" && state.anchor) {
      const landmark = loadLandmarks().find(lm => lm.id === state.selectedLandmarkId);
      if (!landmark || !Number.isInteger(landmark.floor)) {
        alert("Select a saved indoor landmark with a floor number before re-syncing.");
        return;
      }
      if (Number(landmark.floor) !== Number(state.anchor.floor)) {
        alert("Select a landmark on the current floor before re-syncing.");
        return;
      }
      state.anchor = {
        lat: landmark.lat,
        lng: landmark.lng,
        floor: landmark.floor,
        label: landmark.name,
      };
      state.pdrOffsetMeters = { x: 0, y: 0 };
      state.stepCount = 0;
      state.lastStepTs = 0;
      state.stepSignalAbove = false;
      $("#hudSteps").textContent = "0";
      $("#hudMode").textContent = `INDOOR • ${state.anchor.label}`;
      setUserPosition(state.anchor.lat, state.anchor.lng, { pan: true });
      updateTrainingHud();
      refreshSearch();
    } else if (state.userLatLng) {
      map.setView([state.userLatLng.lat, state.userLatLng.lng], 19);
    } else {
      alert("No position yet. Allow location or use Debug → Jump GPS.");
    }
  });

  $("#startDirectionsBtn").addEventListener("click", () => {
    const destination = getSelectedDestination();
    if (!destination) {
      showNfcStatus("Select a landmark or scan a QR code before starting directions.", "info", "Choose destination");
      return;
    }

    state.routeActive = !state.routeActive;
    updateDirectionButton();

    if (!state.routeActive) {
      resetRouteSpeechTracking();
      speakText("Directions stopped.", { critical: true });
      return;
    }

    resetRouteSpeechTracking();
    const intro = `Start giving direction to ${destination.name}.`;
    speakText(intro, { critical: true });
    updateRouteGuidance();
  });

  // ---------- Boot ----------
  updateDirectionButton();
  renderCalibrationState();
  refreshAvailableFloors();
  renderLandmarkMarkers();
  renderFloorSwitch();
  refreshSearch();
  startGeoWatch();
  // Restore training mode persistence and the learned stride coefficient.
  const savedCalibrationModel = loadCalibrationModel();
  if (savedCalibrationModel) state.strideLengthM = savedCalibrationModel.strideLengthM;
  setTrainingMode(readStoredSetting(LS.training) === "1");
  setHeatmapMode(readStoredSetting(LS.heatmap) === "1");
  updateCalibrationStatus();

  // Direct URL anchors support NFC URL tags and iPhone Shortcuts, even without Web NFC.
  processAnchorDeepLink();

  // Expose small debug hook
  window.PCNS = {
    state,
    loadLandmarks,
    saveLandmarks,
    handleNfcPayload,
    handleQrPayload,
    addStep,
    setHeading,
    setTrainingMode,
    setCurrentFloor,
    setHeatmapMode,
    buildAnchorUrl,
    processAnchorDeepLink,
    describeTurn,
    findHallwayRoute,
    updateRouteGuidance,
  };
})();
