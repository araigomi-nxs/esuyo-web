/* ═══════════════════════════════════════════════
   E-Suyo — Interactive Map Logic
   ═══════════════════════════════════════════════ */

// ── Auth ──────────────────────────────────────────
const _ADMIN_PW = 'admin123';
let _userRole = null;

function isAdmin() { return _userRole === 'admin'; }

function _applyRole(role) {
  _userRole = role;
  document.body.classList.toggle('viewer-mode', role === 'viewer');
  document.body.classList.toggle('admin-mode', role === 'admin');
  const badge = document.getElementById('role-badge');
  if (badge) badge.textContent = role === 'admin' ? 'ADMIN' : 'VIEWER';
  const saveBtn = document.getElementById('ps-save');
  if (saveBtn) saveBtn.textContent = role === 'admin' ? 'Save to Map' : 'Submit';
  const saveRouteBtn = document.getElementById('btn-save-route');
  if (saveRouteBtn) saveRouteBtn.textContent = role === 'admin' ? 'Save Route' : 'Submit';
}

function initAuth() {
  return new Promise(resolve => {
    const overlay = document.getElementById('auth-overlay');
    const pwInput = document.getElementById('auth-password');
    const errMsg = document.getElementById('auth-error');
    const btnLogin = document.getElementById('auth-btn-login');
    const btnView = document.getElementById('auth-btn-viewer');

    function tryLogin() {
      if (pwInput.value === _ADMIN_PW) {
        sessionStorage.setItem('esuyo_role', 'admin');
        _applyRole('admin');
        overlay.classList.add('hidden');
        resolve();
      } else {
        errMsg.classList.remove('hidden');
        pwInput.value = '';
        pwInput.focus();
      }
    }

    btnLogin.addEventListener('click', tryLogin);
    pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
    pwInput.addEventListener('input', () => errMsg.classList.add('hidden'));

    btnView.addEventListener('click', () => {
      sessionStorage.setItem('esuyo_role', 'viewer');
      _applyRole('viewer');
      overlay.classList.add('hidden');
      resolve();
    });

    // Default to viewer on load without showing the login screen
    const stored = sessionStorage.getItem('esuyo_role') || 'viewer';
    _applyRole(stored);
    overlay.classList.add('hidden');
    resolve();
  });
}

const MAP_CENTER = [123.7438, 13.1391];
const INITIAL_ZOOM = 13.2;
const INITIAL_PITCH = 55;
const INITIAL_BEARING = -15;

const OSRM = 'https://routing.openstreetmap.de/routed-car';

// ── LTFRB Fare Matrix ─────────────────────────────
// premarch26 = rates before March 2026 (Oct 2023 provisional)
// march2026 = rates from March 2026 onwards
const FARE_MATRIX = {
  'puj': {
    label: 'PUJ', fullLabel: 'Traditional Jeepney', emoji: '🚐',
    premarch26: { base: 13.00, baseKm: 4, perKm: 1.80 },
    march2026: { base: 14.00, baseKm: 4, perKm: 2.00 }
  },
  'mpuj': {
    label: 'MPUJ', fullLabel: 'Modern Jeepney', emoji: '🚌',
    premarch26: { base: 15.00, baseKm: 4, perKm: 2.20 },
    march2026: { base: 17.00, baseKm: 4, perKm: 2.30 }
  },
  'pub-city': {
    label: 'PUB City', fullLabel: 'City Bus (Ordinary)', emoji: '🚍',
    premarch26: { base: 13.00, baseKm: 5, perKm: 2.25 },
    march2026: { base: 15.00, baseKm: 5, perKm: 2.49 }
  },
  'pub-city-ac': {
    label: 'PUBw/AC', fullLabel: 'City Bus (Aircon)', emoji: '🚍',
    premarch26: { base: 15.00, baseKm: 5, perKm: 2.65 },
    march2026: { base: 18.00, baseKm: 5, perKm: 2.98 }
  },
  'uv-express': {
    label: 'UV Express', fullLabel: 'UV Express', emoji: '🚙',
    premarch26: { base: 25.00, baseKm: 5, perKm: 2.00 },
    march2026: { base: 25.00, baseKm: 5, perKm: 2.50 }
  },
};

let fareEra = 'march2026'; // toggled by header button

function getFareRates(vehicleType) {
  return (FARE_MATRIX[vehicleType] || FARE_MATRIX['puj'])[fareEra];
}

function calcFare(km, vehicleType = 'puj') {
  const r = getFareRates(vehicleType);
  if (km <= r.baseKm) return r.base;
  return Math.round((r.base + (km - r.baseKm) * r.perKm) * 100) / 100;
}

function vehicleTag(type) {
  const v = FARE_MATRIX[type];
  if (!v) return '';
  return `<span class="vehicle-tag vehicle-tag--${type}">${v.emoji} ${v.label}</span>`;
}

let _fareMatrixCache = null; // cleared on page load — rebuilt on first hover

function initFareMatrixTooltip() {
  const el = document.getElementById('fare-matrix-tooltip');
  if (!el || _fareMatrixCache) return; // Skip if already cached

  const rows = Object.entries(FARE_MATRIX).map(([, v]) => `
    <tr>
      <td class="fmt-vehicle">${v.emoji} ${v.label}</td>
      <td class="fmt-rate">₱${v.premarch26.base.toFixed(2)}<span class="fmt-km"> / ${v.premarch26.baseKm}km</span><span class="fmt-extra"> +₱${v.premarch26.perKm.toFixed(2)}/km</span></td>
      <td class="fmt-rate">₱${v.march2026.base.toFixed(2)}<span class="fmt-km"> / ${v.march2026.baseKm}km</span><span class="fmt-extra"> +₱${v.march2026.perKm.toFixed(2)}/km</span></td>
    </tr>`).join('');

  _fareMatrixCache = `
    <table class="fmt-table">
      <thead>
        <tr>
          <th>Vehicle</th>
          <th>Pre-March 26</th>
          <th>March 2026</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  el.innerHTML = _fareMatrixCache;
}

// ── State ────────────────────────────────────────
let map = null;
let routes = [];
let _mapReady = false;
let _dataReady = false;
let activeRouteId = null;
let filterTown = '';
let _selectedPlaceKey = null; // "lat,lng" of currently selected landmark
let _walkPathRouteId = null;
let _walkMarkers = [];
let filterBarangay = '';
let filterVehicle = '';
let _areaIndex = {};
let builderOpen = false;
let _dropPinMode = false;
let editingRouteId = null;
let isSnapping = false; // still used to block map clicks during async stop placement
let activePopup = null;
let routeLayers = {};
let routeSources = {};

// Each stop: { name, lat, lng, address, roadDistFromPrev, roadPathFromPrev[] }
let draftStops = [];
let _draftMarkers = [];
let _draftDelBtns = [];   // [{ idx, delBtn }] for hover-show delete buttons
let _draftDragIdx = -1;  // index of stop currently being dragged (-1 = none)
let _draftOnMove = null;
let _draftOnUp = null;
let _draftOnEnter = null;
let _draftOnLeave = null;
let _draftOnDown = null;

let _flowLayerIds = [];
let _glowLayerIds = [];
let _flowAnimFrame = null;
let _flowStep = 0;

// Ride mode
let rideModeActive = false;
let _rideStep = 0; // 0=await pickup, 1=await dropoff, 2=done
let _ridePickupMarker = null;
let _rideDropoffMarker = null;
let _ridePickupCoords = null;
let _rideDropoffCoords = null;
let _rideClickHandler = null;
let _lastRideDistKm = null;

// ── Live Pasada ───────────────────────────────────
let _livePasadaCounts = {};   // route_id → active session count
let _livePasadaChannel = null;

async function fetchLivePasadaCounts() {
  if (!_supabase) return;
  try {
    const { data, error } = await _supabase
      .from('pasada_sessions')
      .select('route_id')
      .eq('status', 'active');
    if (error) { console.warn('Live pasada fetch:', error); return; }
    _livePasadaCounts = {};
    (data || []).forEach(s => {
      if (s.route_id)
        _livePasadaCounts[s.route_id] = (_livePasadaCounts[s.route_id] || 0) + 1;
    });
    _applyLivePasadaUI();
  } catch (e) { console.warn('fetchLivePasadaCounts:', e); }
}

function subscribeLivePasada() {
  if (!_supabase || _livePasadaChannel) return;
  _livePasadaChannel = _supabase
    .channel('live-pasada-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pasada_sessions' },
      () => fetchLivePasadaCounts())
    .subscribe();
}

function _applyLivePasadaUI() {
  // Update badges on all visible route cards
  document.querySelectorAll('#route-list .route-item').forEach(el => {
    const rid = el.dataset.id;
    if (!rid) return;
    const count = _livePasadaCounts[rid] || 0;
    const badge = el.querySelector('.live-pasada-badge');
    if (count > 0) {
      if (!badge) {
        const meta = el.querySelector('.route-item-meta');
        if (meta) {
          const b = document.createElement('span');
          b.className = 'live-pasada-badge';
          b.innerHTML = `<span class="live-dot"></span><span class="live-badge-count">${count}</span> live`;
          meta.appendChild(b);
        }
      } else {
        const countEl = badge.querySelector('.live-badge-count');
        if (countEl) countEl.textContent = count;
      }
    } else if (badge) {
      badge.remove();
    }
  });
  // Update detail panel if a route is currently open
  if (activeRouteId) _updateDetailLiveBanner(activeRouteId);
}

function _updateDetailLiveBanner(routeId) {
  const el = document.getElementById('detail-live-pasada');
  if (!el) return;
  const count = _livePasadaCounts[routeId] || 0;
  if (count > 0) {
    el.innerHTML = `<span class="live-dot"></span><strong>${count} jeepney${count !== 1 ? 's' : ''}</strong>&nbsp;currently running this route`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ── Geocoding (Nominatim + CORS Proxy) ──────────
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const NOMINATIM_OPTS = {};
let _geocodeQueue = Promise.resolve();
let _lastGeocodeTime = 0;
const GEOCODE_MIN_DELAY = 1000; // Rate limit: 1 req/sec
const _geocodeCache = {}; // Cache coords by place name

async function getCoordsFromPlace(placeName) {
  // Check cache first
  if (_geocodeCache[placeName]) {
    return _geocodeCache[placeName];
  }

  // Queue requests to enforce rate limit
  return _geocodeQueue = _geocodeQueue.then(async () => {
    const now = Date.now();
    const timeSinceLastRequest = now - _lastGeocodeTime;
    if (timeSinceLastRequest < GEOCODE_MIN_DELAY) {
      await new Promise(r => setTimeout(r, GEOCODE_MIN_DELAY - timeSinceLastRequest));
    }
    _lastGeocodeTime = Date.now();

    try {
      const url = `${NOMINATIM}/search?format=json&q=${encodeURIComponent(placeName + ', Legazpi Albay')}&limit=1`;
      const res = await fetch(url, NOMINATIM_OPTS);
      const data = await res.json();
      if (data && data[0]) {
        const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        _geocodeCache[placeName] = result; // Cache the result
        return result;
      }
    } catch (e) { console.warn('Geocode fail:', placeName, e); }
    return null;
  });
}

// ── Local barangay polygon lookup ────────────────
let legazpiBarangays = null;

async function loadBarangays() {
  try {
    const res = await fetch('legazpi-barangays.json');
    legazpiBarangays = await res.json();
    // If the map finished loading before the fetch returned, add the layers now
    if (map && map.isStyleLoaded()) addBarangayLayers();
  } catch (e) { console.warn('Barangay data load failed:', e); }
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function getBrgyFromCoords(lng, lat) {
  if (!legazpiBarangays) return null;
  const f = legazpiBarangays.features.find(feat => {
    const g = feat.geometry;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    return polys.some(poly => pointInRing(lng, lat, poly[0]));
  });
  return f?.properties?.name || null;
}

function getBrgyFeatureFromCoords(lng, lat) {
  if (!legazpiBarangays) return null;
  return legazpiBarangays.features.find(feat => {
    const g = feat.geometry;
    const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    return polys.some(poly => pointInRing(lng, lat, poly[0]));
  }) || null;
}

function buildAreaIndex() {
  if (!legazpiBarangays) return;
  _areaIndex = {};
  for (const feat of legazpiBarangays.features) {
    const city = feat.properties.city;
    const name = feat.properties.name;
    if (!_areaIndex[city]) _areaIndex[city] = [];
    _areaIndex[city].push(name);
  }
  for (const city in _areaIndex) _areaIndex[city].sort();
}

async function getAddressFromCoords(lat, lng) {
  try {
    const [photonResult, localBrgy] = await Promise.all([
      fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&limit=1`)
        .then(r => r.json()).catch(() => null),
      Promise.resolve(getBrgyFromCoords(lng, lat))
    ]);

    const parts = [];
    const props = photonResult?.features?.[0]?.properties;
    const street = props?.street;
    if (street && !street.toLowerCase().includes('unnamed')) {
      parts.push(props.housenumber ? `${props.housenumber} ${street}` : street);
    }

    if (localBrgy) parts.push(`Brgy. ${localBrgy}`);

    return parts.join(', ');
  } catch {
    return '';
  }
}

function _mswSetToggle(id, on) {
  const el = document.getElementById(id);
  if (el) el.checked = on;
}

function _onBothReady() {
  try { addBarangayLayers(); } catch { }
  renderAllRoutesOnMap();
  renderRouteList();
  updateRouteCount();
  fetchLivePasadaCounts();
  subscribeLivePasada();
}

function showWelcome() {
  if (localStorage.getItem('esuyo_welcome_skip')) return;
  const overlay = document.getElementById('welcome-overlay');
  overlay.classList.remove('hidden');
  const close = () => overlay.classList.add('hidden');
  document.getElementById('welcome-ok').addEventListener('click', close, { once: true });
  document.getElementById('welcome-skip').addEventListener('click', () => {
    close();
    localStorage.setItem('esuyo_welcome_skip', '1');
  }, { once: true });
}

document.addEventListener('DOMContentLoaded', async () => {
  await initDeviceOptimizations();
  await initAuth();
  showWelcome();
  initSupabase();

  // Start the map immediately — don't block on network data
  initMap();
  initAreaFilter();
  initVehicleFilter();
  initFindTabs();
  bindEvents();
  initFareMatrixTooltip();
  initMobileSidebarCollapse();
  trackPageView();

  // Load data in parallel in the background
  await Promise.all([
    loadBarangays().catch(() => console.warn('Barangay load failed')),
    loadRoutes().catch(() => console.warn('Routes load failed'))
  ]);

  buildAreaIndex();
  _dataReady = true;
  if (_mapReady) _onBothReady();
});

// ── Persistence ──────────────────────────────────
async function loadRoutes() {
  try {
    const { data, error } = await _supabase.from('routes').select('*').or('status.eq.approved,status.is.null').order('created_at', { ascending: true });
    if (error) throw error;
    routes = data;
    localStorage.setItem('esuyo_routes', JSON.stringify(routes)); // cache
  } catch (error) {
    console.error('Failed to load routes from DB:', error);
    // Try to load from cache if available
    const cached = localStorage.getItem('esuyo_routes');
    routes = cached ? JSON.parse(cached) : [];
  }
}
function saveRoutes() {
  localStorage.setItem('esuyo_routes', JSON.stringify(routes));
}

// ── Map Init ──────────────────────────────────────
function initMap() {
  // Reduce max tile cache on mobile to save memory
  const maxTileCache = DEVICE_CONFIG.isMobile() ? 100 : 200;

  map = new maplibregl.Map({
    container: 'map',
    style: currentMapStyle,
    center: MAP_CENTER, zoom: INITIAL_ZOOM,
    pitch: 0, bearing: INITIAL_BEARING,
    minPitch: 0, maxPitch: 60,
    maxZoom: 18, minZoom: 10, antialias: !DEVICE_CONFIG.isMobile(), // Disable antialiasing on mobile
    renderWorldCopies: false,
    // Lock camera to the Philippines boundaries only
    // Prevents users from panning outside PH and restricts tile loading
    maxBounds: [[116.4, 4.6], [126.8, 20.9]],
    fadeDuration: DEVICE_CONFIG.isReducedMotion() ? 0 : 100,
    maxTileCacheSize: maxTileCache,
  });

  map.on('load', () => {
    try {
      addTerrain();
      add3DBuildings();
      addGreenery();
      if (currentMapStyle === STYLE_CARTO) applyCartoGreen();
      addLandmarks();
      initLandmarkFilter();
      fetchLandmarksFromDB(); // async — updates layer when Supabase responds
    } catch (e) {
      console.error('Map load error:', e);
    } finally {
      setTimeout(() => document.getElementById('loading-screen').classList.add('hidden'), 700);
    }
    _mapReady = true;
    if (_dataReady) _onBothReady();

    // Click outside route/landmark to close detail and popups
    map.on('click', (e) => {
      if (builderOpen) return;
      if (rideModeActive) return;
      if (_dropPinMode) {
        _dropPinMode = false;
        map.getCanvas().style.cursor = '';
        const { lat, lng } = e.lngLat;
        previewPlace = { name: '', lat, lng, address: 'Custom pin', google_place_id: null };
        showPlacePreview(previewPlace, true);
        document.getElementById('ps-name').value = '';
        document.getElementById('ps-name').focus();
        return;
      }
      const routeLayerIds = routes.flatMap(r => [
        `line-${r.id}`, `glow-${r.id}`,
        `stops-${r.id}`, `terminal-${r.id}`, `terminal-click-${r.id}`
      ]).filter(id => {
        try { return !!map.getLayer(id); } catch { return false; }
      });
      const popupLayerIds = [...routeLayerIds, 'landmarks-circle', 'stops-src', 'brgy-fill'].filter(id => {
        try { return !!map.getLayer(id); } catch { return false; }
      });
      const routeFeatures = routeLayerIds.length ? map.queryRenderedFeatures(e.point, { layers: routeLayerIds }) : [];
      const popupFeatures = popupLayerIds.length ? map.queryRenderedFeatures(e.point, { layers: popupLayerIds }) : [];
      if (routeFeatures.length === 0 && activeRouteId) hideRouteDetail();
      if (popupFeatures.length === 0 && activePopup) { activePopup.remove(); activePopup = null; }
      const brgyFeatures = barangaysVisible && map.getLayer('brgy-fill')
        ? map.queryRenderedFeatures(e.point, { layers: ['brgy-fill'] }) : [];
      if (brgyFeatures.length === 0 && _selectedBarangay) clearBarangaySelection();
    });
  });

  // Safety net: always hide loading after 8 seconds regardless
  map.on('error', () => {
    document.getElementById('loading-screen').classList.add('hidden');
  });
  setTimeout(() => document.getElementById('loading-screen').classList.add('hidden'), 8000);
}

let _demProtocolRegistered = false;

function addTerrain() {
  try {
    if (map.getSource('terrain-dem')) return;

    // Skip terrain on low-bandwidth connections
    if (DEVICE_CONFIG.isLowBandwidth()) {
      console.warn('Skipping terrain on low-bandwidth connection');
      return;
    }

    // Custom protocol: fetches AWS terrarium tiles, then clamps every pixel
    // below MIN_ELEV_M to sea level before MapLibre decodes the DEM.
    // Result: towns + coastline = flat; hills/mountains = full detail.
    if (!_demProtocolRegistered) {
      _demProtocolRegistered = true;
      // Smoothstep ramp: 0 m and below → flat; 0–EASE_TO_M → eased curve; above → full.
      // No hard cliff — the transition from town to hill is a smooth S-curve.
      const EASE_TO_M = 120;
      maplibregl.addProtocol('dem-filtered', async (params, abortController) => {
        const tileUrl = params.url.replace(
          'dem-filtered://',
          'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/'
        );
        let blob;
        try {
          const response = await fetch(tileUrl, { signal: abortController.signal });
          if (!response.ok) throw new Error(`DEM tile ${response.status}`);
          blob = await response.blob();
        } catch {
          // Ocean / missing tile — return a flat sea-level tile so the mesh doesn't stretch
          const flat = document.createElement('canvas'); flat.width = 256; flat.height = 256;
          const fc = flat.getContext('2d');
          // Terrarium sea-level encoding: R=128, G=0, B=0 → (128*256+0+0)-32768 = 0 m
          fc.fillStyle = 'rgb(128,0,0)'; fc.fillRect(0, 0, 256, 256);
          const flatBlob = await new Promise(res => flat.toBlob(res, 'image/png'));
          return { data: await flatBlob.arrayBuffer() };
        }

        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const px = imageData.data;
        const W = canvas.width, H = canvas.height;

        // Pass 1: smoothstep — flatten coastal zone (0–EASE_TO_M) toward sea level
        const elevs = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) {
          const b = i * 4;
          const elev = (px[b] * 256 + px[b + 1] + px[b + 2] / 256) - 32768;
          const t = Math.max(0, Math.min(1, elev / EASE_TO_M));
          const smoothed = t * t * (3 - 2 * t) * elev;
          // Boost: ramps from 1× at 30 m to 1.9× at 200 m+ so hills climb
          // dramatically while the coastal flat zone stays smooth.
          const boostT = Math.max(0, Math.min(1, (smoothed - 30) / 170));
          elevs[i] = smoothed * (1 + 0.9 * boostT);
        }

        // Pass 2: 3×3 box blur — smooths hard coastline/seam transitions
        const blurred = new Float32Array(W * H);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            let sum = 0, cnt = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && nx < W && ny >= 0 && ny < H) { sum += elevs[ny * W + nx]; cnt++; }
              }
            }
            blurred[y * W + x] = sum / cnt;
          }
        }

        // Re-encode blurred elevations back to terrarium RGB
        for (let i = 0; i < W * H; i++) {
          const enc = Math.round(Math.max(0, blurred[i])) + 32768;
          const b = i * 4;
          px[b] = (enc >> 8) & 0xff; px[b + 1] = enc & 0xff; px[b + 2] = 0; px[b + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);

        const outBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        return { data: await outBlob.arrayBuffer() };
      });
    }

    const demSourceSpec = {
      type: 'raster-dem',
      tiles: ['dem-filtered://{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 14,
      attribution: 'Terrain: Mapzen/AWS'
    };

    map.addSource('terrain-dem', demSourceSpec);

    map.addLayer({
      id: 'sky-layer',
      type: 'sky',
      paint: {
        'sky-type': 'atmosphere',
        'sky-atmosphere-sun': [0.0, 90.0],
        'sky-atmosphere-sun-intensity': 15,
        'sky-atmosphere-color': 'rgba(135, 196, 235, 1.0)',
        'sky-atmosphere-halo-color': 'rgba(255, 255, 255, 0.5)',
      }
    });
  } catch (e) { console.error('Terrain error:', e); }
}

let _building3DLayerIds = [];

function add3DBuildings() {
  try {
    const styleLayers = map.getStyle().layers;

    // Liberty style already ships fill-extrusion building layers — use them directly
    _building3DLayerIds = styleLayers
      .filter(l => l.type === 'fill-extrusion')
      .map(l => l.id);

    // Carto/flat styles have no fill-extrusion — add our own on top of the existing building fill layer
    if (_building3DLayerIds.length === 0) {
      const bldFill = styleLayers.find(
        l => l.type === 'fill' && (l['source-layer'] === 'building' || l.id.toLowerCase().includes('building'))
      );
      if (bldFill && !map.getLayer('bld-3d')) {
        map.addLayer({
          id: 'bld-3d',
          type: 'fill-extrusion',
          source: bldFill.source,
          'source-layer': bldFill['source-layer'] || 'building',
          paint: {
            'fill-extrusion-color': '#d6d0c8',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 6],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
            'fill-extrusion-opacity': 0.8
          }
        });
      }
      if (map.getLayer('bld-3d')) _building3DLayerIds = ['bld-3d'];
    }

    if (!is3D) {
      _building3DLayerIds.forEach(id => {
        try { map.setLayoutProperty(id, 'visibility', 'none'); } catch { }
      });
    }
  } catch (e) {
    console.warn('add3DBuildings:', e);
  }
}


function addGreenery() {
  try {
    if (map.getLayer('green-cover')) return;

    // Add greenery source from Stadia Maps (CORS-enabled, free tier)
    // This provides landcover and landuse data for parks, forests, grass, etc.
    if (!map.getSource('greenery-src')) {
      map.addSource('greenery-src', {
        type: 'vector',
        tiles: ['https://tiles.stadiamaps.com/data/landcover_z13/{z}/{x}/{y}.pbf'],
        minzoom: 0,
        maxzoom: 13
      });
    }

    const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol');

    // Landcover layer (grass, forest, scrub)
    map.addLayer({
      id: 'green-cover',
      type: 'fill',
      source: 'greenery-src',
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood', 'scrub', 'wetland']]],
      paint: {
        'fill-color': '#68C47A',
        'fill-opacity': 0.9,
        'fill-antialias': true
      }
    }, firstSymbol?.id);

    // Landuse layer (parks, forests, gardens)
    map.addLayer({
      id: 'green-use',
      type: 'fill',
      source: 'greenery-src',
      'source-layer': 'landuse',
      filter: ['in', ['get', 'class'], ['literal', ['park', 'grass', 'forest', 'meadow', 'garden', 'farmland']]],
      paint: {
        'fill-color': '#1B5E20',
        'fill-opacity': 0.95,
        'fill-antialias': true
      }
    }, firstSymbol?.id);

  } catch (e) { console.warn('Greenery error:', e); }
}

// ── Supabase ──────────────────────────────────────
// Replace these with your project values from supabase.com → Settings → API
// SQL to run once in Supabase SQL Editor:
//   create table landmarks (
//     id uuid primary key default gen_random_uuid(),
//     name text not null,
//     lat float8 not null,
//     lng float8 not null,
//     category text not null default 'landmark',
//     address text,
//     google_place_id text unique,
//     created_at timestamptz default now()
//   );
//   alter table landmarks enable row level security;
//   create policy "public read"   on landmarks for select using (true);
//   create policy "public insert" on landmarks for insert with check (true);
//   create policy "public delete" on landmarks for delete using (true);
const SUPABASE_URL = window.ESUYO_CONFIG?.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.ESUYO_CONFIG?.SUPABASE_ANON_KEY || '';
let _supabase = null;

function initSupabase() {
  if (typeof window.supabase === 'undefined') { console.warn('Supabase SDK not loaded'); return; }
  if (!SUPABASE_URL || SUPABASE_URL.includes('your-project-id')) { console.info('Supabase not configured — landmarks will use hardcoded data only.'); return; }
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// ── Dynamic Landmark Store ─────────────────────────
let dbLandmarks = [];

const LANDMARK_CACHE_KEY = 'esuyo_landmarks_v1';
const LANDMARK_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function _readLandmarkCache() {
  try {
    const raw = localStorage.getItem(LANDMARK_CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > LANDMARK_CACHE_TTL) return null; // expired
    return data;
  } catch { return null; }
}

function _writeLandmarkCache(data) {
  try {
    localStorage.setItem(LANDMARK_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch { }
}

function _clearLandmarkCache() {
  localStorage.removeItem(LANDMARK_CACHE_KEY);
}

async function fetchLandmarksFromDB(forceFresh = false) {
  if (!_supabase) return;

  if (!forceFresh) {
    const cached = _readLandmarkCache();
    if (cached) {
      dbLandmarks = cached;
      refreshLandmarksLayer();
      return;
    }
  }

  const { data, error } = await _supabase
    .from('landmarks')
    .select('*')
    .or('status.eq.approved,status.is.null')
    .order('created_at', { ascending: true });
  if (error) { console.error('Landmark fetch error:', error); return; }
  dbLandmarks = data || [];
  _writeLandmarkCache(dbLandmarks);
  refreshLandmarksLayer();
}

async function saveLandmarkToDB(landmark) {
  if (!_supabase) { alert('Supabase not configured — add your URL and anon key.'); return false; }
  const payload = {
    name: landmark.name,
    lat: landmark.lat,
    lng: landmark.lng,
    category: landmark.category,
    address: landmark.address || null,
    google_place_id: landmark.google_place_id || null,
    status: isAdmin() ? 'approved' : 'pending',
  };
  const { error } = landmark.google_place_id
    ? await _supabase.from('landmarks').upsert(payload, { onConflict: 'google_place_id' })
    : await _supabase.from('landmarks').insert(payload);
  if (error) { console.error('Save error:', error); return false; }
  _clearLandmarkCache();
  await fetchLandmarksFromDB(true);
  return true;
}


function saveLocalPin(landmark) {
  _customPins.push({ ...landmark, id: null, _local: true, category: landmark.category || 'landmark' });
  refreshLandmarksLayer();
  renderBrandMarkers();
  return true;
}

async function deleteLandmarkFromDB(id) {
  if (!_supabase) return;
  await _supabase.from('landmarks').delete().eq('id', id);
  dbLandmarks = dbLandmarks.filter(l => l.id !== id);
  _writeLandmarkCache(dbLandmarks);
  refreshLandmarksLayer();
}

let _customPins = [];

function getAllLandmarks() {
  return [...dbLandmarks, ..._customPins];
}


function _landmarkMatchesAreaFilter(l) {
  if (!filterTown && !filterBarangay) return true;
  const feat = getBrgyFeatureFromCoords(l.lng, l.lat);
  if (!feat) return false;
  if (filterBarangay) return feat.properties.name === filterBarangay;
  return feat.properties.city === filterTown;
}

function getBoundsForArea(town, barangay) {
  if (!legazpiBarangays) return null;
  const features = legazpiBarangays.features.filter(f =>
    barangay ? f.properties.name === barangay : f.properties.city === town
  );
  if (!features.length) return null;
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  features.forEach(feat => {
    const polys = feat.geometry.type === 'MultiPolygon' ? feat.geometry.coordinates : [feat.geometry.coordinates];
    polys.forEach(poly => poly.forEach(ring => ring.forEach(([lng, lat]) => {
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    })));
  });
  return [[minLng, minLat], [maxLng, maxLat]];
}

function flyToAreaFilter() {
  if (!filterTown && !filterBarangay) return;
  const bounds = getBoundsForArea(filterTown, filterBarangay);
  if (bounds) map.fitBounds(bounds, { padding: 40, maxZoom: 15, duration: 700 });
}

function refreshLandmarksLayer() {
  const src = map?.getSource('landmarks');
  if (!src) return;
  const visible = getAllLandmarks().filter(l =>
    !hiddenLandmarkCategories.has(l.category || 'landmark') && _landmarkMatchesAreaFilter(l)
  );
  src.setData({
    type: 'FeatureCollection',
    features: visible.map(l => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
      properties: {
        name: l.name, category: l.category || 'landmark',
        lat: l.lat, lng: l.lng, dbId: l.id || null,
        brand: getBrand(l.name)
      }
    }))
  });
  renderBrandMarkers();
}

// ── Reposition existing landmark ──────────────────
let _repositionMarker = null;
let _repositionId = null;
let _currentOrbScale = null;
let _repositionMapListeners = null;

function startReposition(id, name, lat, lng, category) {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  if (_repositionMarker) _repositionMarker.remove();

  _repositionId = id;

  const cat = (category || 'landmark').toLowerCase();
  const brand = getBrand(name);
  const symbol = brand === 'jollibee' ? 'J'
    : brand === 'mcdonalds' ? 'M'
      : (LANDMARK_ICONS[cat] || '📍');
  const color = brand === 'jollibee' ? '#E31837'
    : brand === 'mcdonalds' ? '#FFC72C'
      : (LANDMARK_COLORS[cat] || '#673AB7');

  const el = document.createElement('div');
  el.className = 'reposition-marker';
  el.innerHTML = `<span style="font-size:10px;line-height:1;text-shadow:0 0 1px rgba(0,0,0,0.4)">${symbol}</span>`;
  el.style.cssText = `
    width: 20px;
    height: 20px;
    background: ${color};
    border: 2px solid #fff;
    border-radius: 50%;
    cursor: move;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 6px rgba(0,0,0,0.35);
  `;

  // Hide existing landmark temporarily
  try { map.setLayoutProperty('landmarks-circle', 'visibility', 'none'); } catch { }
  try { map.setLayoutProperty('landmarks-icon', 'visibility', 'none'); } catch { }
  try { map.setLayoutProperty('landmarks-label', 'visibility', 'none'); } catch { }
  _brandMarkers.forEach(m => { m.getElement().style.display = 'none'; });

  _repositionMarker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([lng, lat])
    .addTo(map);

  _currentOrbScale = function () {
    const zoom = map.getZoom();
    const scale = Math.max(0.7, Math.min(1, (zoom - 8) / 8));
    el.style.transform = `scale(${scale})`;
    el.style.transformOrigin = 'center';
  };

  map.on('move', _currentOrbScale);
  _currentOrbScale();

  const canvas = map.getCanvas();
  const onMapEnter = () => el.classList.add('map-active');
  const onMapLeave = () => el.classList.remove('map-active');
  canvas.addEventListener('mouseenter', onMapEnter);
  canvas.addEventListener('mouseleave', onMapLeave);
  _repositionMapListeners = { canvas, onMapEnter, onMapLeave };

  const updateCoords = () => {
    const ll = _repositionMarker.getLngLat();
    document.getElementById('rp-bar-coords').textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
  };

  _repositionMarker.on('drag', updateCoords);
  _repositionMarker.on('dragend', saveReposition);

  document.getElementById('reposition-bar').classList.add('hidden');
  map.flyTo({ center: [lng, lat], zoom: 17, pitch: 0, duration: 700 });
};

async function saveReposition() {
  if (!_repositionId || !_repositionMarker) return;
  const ll = _repositionMarker.getLngLat();
  const lat = ll.lat;
  const lng = ll.lng;

  // Delete and re-insert with new coords
  const { data: oldData } = await _supabase
    .from('landmarks')
    .select('*')
    .eq('id', _repositionId)
    .single();

  if (!oldData) { alert('Could not find landmark'); return; }

  await _supabase.from('landmarks').delete().eq('id', _repositionId);

  await _supabase.from('landmarks').insert({
    ...oldData,
    lat,
    lng,
    id: _repositionId
  });

  // Update local data
  const landmark = dbLandmarks.find(l => l.id === _repositionId);
  if (landmark) { landmark.lat = lat; landmark.lng = lng; }

  // Refresh
  dbLandmarks = [];
  _clearLandmarkCache();
  await fetchLandmarksFromDB(true);
  cancelReposition();
}

function cancelReposition() {
  if (_repositionMarker) {
    if (_currentOrbScale) map.off('move', _currentOrbScale);
    if (_repositionMapListeners) {
      const { canvas, onMapEnter, onMapLeave } = _repositionMapListeners;
      canvas.removeEventListener('mouseenter', onMapEnter);
      canvas.removeEventListener('mouseleave', onMapLeave);
      _repositionMapListeners = null;
    }
    _repositionMarker.remove(); _repositionMarker = null;
    _currentOrbScale = null;
  }
  _repositionId = null;
  document.getElementById('reposition-bar').classList.add('hidden');

  // Restore landmark visibility
  const vis = landmarksVisible ? 'visible' : 'none';
  try { map.setLayoutProperty('landmarks-circle', 'visibility', vis); } catch { }
  try { map.setLayoutProperty('landmarks-icon', 'visibility', vis); } catch { }
  try { map.setLayoutProperty('landmarks-label', 'visibility', vis); } catch { }
  _updateBrandMarkerScale();
}

window.startReposition = startReposition;
window.saveReposition = saveReposition;
window.cancelReposition = cancelReposition;

// ── Barangay Boundaries ───────────────────────────
let barangaysVisible = false;
let _brgyGlowFrame = null;
let _selectedBarangay = null;
let _brgyPopup = null;

function _polygonCentroid(geometry) {
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates[0]
    : geometry.coordinates[0][0]; // first ring of first polygon
  let x = 0, y = 0;
  for (const [lng, lat] of ring) { x += lng; y += lat; }
  return [x / ring.length, y / ring.length];
}

function addBarangayLayers() {
  if (!legazpiBarangays || map.getSource('barangays')) return;
  map.addSource('barangays', { type: 'geojson', data: legazpiBarangays });

  // Subtle fill for all barangays (clickable hit area)
  map.addLayer({
    id: 'brgy-fill', type: 'fill', source: 'barangays',
    layout: { visibility: 'none' },
    paint: { 'fill-color': '#00E5FF', 'fill-opacity': 0.06 }
  });

  // Highlighted fill for selected barangay
  map.addLayer({
    id: 'brgy-fill-selected', type: 'fill', source: 'barangays',
    filter: ['==', ['get', 'name'], ''],
    layout: { visibility: 'none' },
    paint: { 'fill-color': '#00E5FF', 'fill-opacity': 0.38 }
  });

  // Bright crisp border for selected barangay only
  map.addLayer({
    id: 'brgy-line-selected', type: 'line', source: 'barangays',
    filter: ['==', ['get', 'name'], ''],
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: { 'line-color': '#00E5FF', 'line-width': 3, 'line-opacity': 1 }
  });

  // Outer glow — wide, heavily blurred, pulsed by animation
  map.addLayer({
    id: 'brgy-glow-outer', type: 'line', source: 'barangays',
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: { 'line-color': '#00E5FF', 'line-width': 14, 'line-opacity': 0.18, 'line-blur': 10 }
  });

  // Inner glow — tighter halo
  map.addLayer({
    id: 'brgy-glow-inner', type: 'line', source: 'barangays',
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: { 'line-color': '#40FFFF', 'line-width': 4, 'line-opacity': 0.55, 'line-blur': 2 }
  });

  // Crisp edge
  map.addLayer({
    id: 'brgy-line', type: 'line', source: 'barangays',
    layout: { visibility: 'none', 'line-join': 'round' },
    paint: { 'line-color': '#B2FFFF', 'line-width': 1, 'line-opacity': 0.9 }
  });

  // Name labels (visible at street zoom)
  map.addLayer({
    id: 'brgy-label', type: 'symbol', source: 'barangays',
    minzoom: 13,
    layout: {
      visibility: 'none',
      'text-field': ['get', 'name'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 11,
      'text-anchor': 'center',
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: { 'text-color': '#80FFFF', 'text-halo-color': 'rgba(0,10,30,0.85)', 'text-halo-width': 2 }
  });

  // Click to select barangay
  map.on('click', 'brgy-fill', (e) => {
    if (!barangaysVisible) return;
    const feat = e.features[0];
    selectBarangay(feat.properties.name, feat.properties.city, feat.geometry);
  });

  map.on('mouseenter', 'brgy-fill', () => {
    if (barangaysVisible) map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'brgy-fill', () => {
    map.getCanvas().style.cursor = '';
  });
}

// Get all routes passing through a barangay
function getRoutesInBarangay(brgyName) {
  return routes.filter(route => {
    return route.stops && route.stops.some(stop => {
      const brgy = getBrgyFromCoords(stop.lng, stop.lat);
      return brgy === brgyName;
    });
  });
}

// Get all landmarks in a barangay
function getLandmarksInBarangay(brgyName) {
  return getAllLandmarks().filter(landmark => {
    const brgy = getBrgyFromCoords(landmark.lng, landmark.lat);
    return brgy === brgyName;
  });
}

function selectBarangay(name, city, geometry) {
  // Clear previous selection first (before removing popup)
  try { map.setFilter('brgy-fill-selected', ['==', ['get', 'name'], null]); } catch { }
  try { map.setFilter('brgy-line-selected', ['==', ['get', 'name'], null]); } catch { }

  // Remove old popup if it exists
  if (_brgyPopup) {
    _brgyPopup.remove();
    _brgyPopup = null;
  }

  // Now set the new selection
  _selectedBarangay = name;
  try { map.setFilter('brgy-fill-selected', ['==', ['get', 'name'], name]); } catch { }
  try { map.setFilter('brgy-line-selected', ['==', ['get', 'name'], name]); } catch { }
  const center = _polygonCentroid(geometry);

  // Get routes and landmarks in this barangay
  const brgyRoutes = getRoutesInBarangay(name);
  const brgyLandmarks = getLandmarksInBarangay(name);

  const routesHTML = brgyRoutes.length > 0
    ? `<div class="brgy-section">
        <div class="brgy-section-title">Routes (${brgyRoutes.length})</div>
        <div class="brgy-routes-list">
          ${brgyRoutes.map(r => `<div class="brgy-route-item" style="border-left: 3px solid ${escHtml(r.color || '#0046C7')}; padding-left: 8px;">${escHtml(r.name || 'Unnamed Route')}</div>`).join('')}
        </div>
      </div>`
    : '';

  const landmarksHTML = brgyLandmarks.length > 0
    ? `<div class="brgy-section">
        <div class="brgy-section-title">Landmarks (${brgyLandmarks.length})</div>
        <div class="brgy-landmarks-list">
          ${brgyLandmarks.map(l => `<div class="brgy-landmark-item">📍 ${escHtml(l.name || 'Unnamed')}</div>`).join('')}
        </div>
      </div>`
    : '';

  _brgyPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 0 })
    .setLngLat(center)
    .setHTML(`<div class="brgy-popup">
      <div class="brgy-card-header">
        <div class="brgy-card-badge">Barangay</div>
        <button class="brgy-card-close" onclick="clearBarangaySelection()">✕</button>
      </div>
      <div class="brgy-card-name">${escHtml(name)}</div>
      <div class="brgy-card-city">${escHtml(city || 'Legazpi City')}</div>
      ${routesHTML}
      ${landmarksHTML}
    </div>`)
    .addTo(map);
  _brgyPopup.on('close', clearBarangaySelection);
}

function clearBarangaySelection() {
  _selectedBarangay = null;
  try { map.setFilter('brgy-fill-selected', ['==', ['get', 'name'], null]); } catch { }
  try { map.setFilter('brgy-line-selected', ['==', ['get', 'name'], null]); } catch { }
  if (_brgyPopup) { _brgyPopup.remove(); _brgyPopup = null; }
}

function toggleBarangays() {
  barangaysVisible = !barangaysVisible;
  const vis = barangaysVisible ? 'visible' : 'none';
  ['brgy-fill', 'brgy-fill-selected', 'brgy-line-selected', 'brgy-glow-outer', 'brgy-glow-inner', 'brgy-line', 'brgy-label'].forEach(id => {
    try { map.setLayoutProperty(id, 'visibility', vis); } catch { }
  });
  _mswSetToggle('toggle-barangays', barangaysVisible);

  if (!barangaysVisible) {
    clearBarangaySelection();
    if (_brgyGlowFrame) { cancelAnimationFrame(_brgyGlowFrame); _brgyGlowFrame = null; }
    return;
  }

  let _brgyTick = 0;
  _brgyGlowFrame = requestAnimationFrame(function tick(ts) {
    if (ts - _brgyTick > 50) {
      _brgyTick = ts;
      const op = 0.14 + 0.10 * Math.sin(ts / 1100);
      try { if (map.getLayer('brgy-glow-outer')) map.setPaintProperty('brgy-glow-outer', 'line-opacity', op); } catch { }
    }
    _brgyGlowFrame = requestAnimationFrame(tick);
  });
}

// ── Edit Landmark Style ───────────────────────────

let _editStyleId = null;

window.editLandmarkStyle = (id, name, color, icon) => {
  if (activePopup) { activePopup.remove(); activePopup = null; }
  _editStyleId = id;
  document.getElementById('es-bar-name').textContent = name;
  document.getElementById('es-color-input').value = color || '#673AB7';
  document.getElementById('es-icon-input').value = icon || '';
  document.getElementById('edit-style-bar').classList.remove('hidden');
};

async function saveEditStyle() {
  if (!_editStyleId) return;
  const color = document.getElementById('es-color-input').value;
  const icon = document.getElementById('es-icon-input').value.trim();
  const btn = document.getElementById('es-bar-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  const { error } = await _supabase.from('landmarks').update({ color, icon: icon || null }).eq('id', _editStyleId);
  btn.disabled = false; btn.textContent = 'Save Style';
  if (error) { console.error(error); return; }
  _clearLandmarkCache();
  await fetchLandmarksFromDB(true);
  cancelEditStyle();
}

function cancelEditStyle() {
  _editStyleId = null;
  document.getElementById('edit-style-bar').classList.add('hidden');
}

// exposed for inline popup onclick
window.deleteLandmark = (id, name) => {
  _openDeleteModal(
    'Remove Landmark?',
    `"${name || 'This pin'}" will be permanently removed from the map.`,
    async () => {
      await deleteLandmarkFromDB(id);
      if (activePopup) { activePopup.remove(); activePopup = null; }
      _closeDeleteModal();
    }
  );
};

const LANDMARK_COLORS = {
  mall: '#E91E63', hospital: '#F44336', school: '#42A5F5', church: '#BA68C8',
  gov: '#90A4AE', terminal: '#FF9800', airport: '#00BCD4', port: '#A1887F',
  bank: '#66BB6A', market: '#FF7043', park: '#8BC34A', landmark: '#9575CD',
  '711': '#00703c', '7eleven': '#00703c',
  factory: '#78909C', gasstation: '#FFC107',
  fastfood: '#FF7043', restaurant: '#FF9800',
  cafe: '#FF8F00', accommodation: '#0288D1', viewpoint: '#F06292'
};

const LANDMARK_ICONS = {
  mall: '🛍️', hospital: '🏥', school: '🏫', church: '⛪',
  gov: '🏛️', terminal: '🚌', airport: '✈️', port: '⚓',
  bank: '🏦', market: '🛒', park: '🌳', landmark: '📍',
  '711': '🏪', '7eleven': '🏪',
  factory: '🏭', gasstation: '⛽',
  fastfood: '🍔', restaurant: '🍽️',
  cafe: '☕', accommodation: '🛏️', viewpoint: '📸'
};

let landmarksVisible = true;
let hiddenLandmarkCategories = new Set();

function toggleLandmarks() {
  landmarksVisible = !landmarksVisible;
  const vis = landmarksVisible ? 'visible' : 'none';
  try { map.setLayoutProperty('landmarks-circle', 'visibility', vis); } catch { }
  try { map.setLayoutProperty('landmarks-icon', 'visibility', vis); } catch { }
  try { map.setLayoutProperty('landmarks-label', 'visibility', vis); } catch { }
  _updateBrandMarkerScale();
  document.getElementById('btn-landmarks').classList.toggle('active', landmarksVisible);
}

window.toggleLandmarks = toggleLandmarks;

// ── Landmark Category Filter ──────────────────────
const LF_LABELS = {
  mall: 'Mall', hospital: 'Hospital', school: 'School', church: 'Church',
  gov: 'Government', terminal: 'Terminal', airport: 'Airport', port: 'Port',
  bank: 'Bank', market: 'Market', park: 'Park', landmark: 'Landmark',
  '7eleven': '7-Eleven', factory: 'Factory', gasstation: 'Gas Station',
  fastfood: 'Fast Food', restaurant: 'Restaurant',
  cafe: 'Cafe', accommodation: 'Accommodation', viewpoint: 'Viewpoint'
};

function _updateFilterBadge() {
  const badge = document.getElementById('lf-filter-badge');
  if (!badge) return;
  const activeHidden = [...hiddenLandmarkCategories].filter(c => c !== '711').length;
  if (activeHidden > 0) {
    badge.textContent = activeHidden;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

let _filterSnapshot = null;

function openLandmarkFilterModal() {
  _filterSnapshot = new Set(hiddenLandmarkCategories);
  document.getElementById('lf-modal-overlay').classList.remove('hidden');
}

function closeLandmarkFilterModal(apply) {
  if (!apply && _filterSnapshot !== null) {
    hiddenLandmarkCategories = _filterSnapshot;
    document.querySelectorAll('.lf-chip').forEach(c => {
      c.classList.toggle('active', !hiddenLandmarkCategories.has(c.dataset.cat));
    });
    refreshLandmarksLayer();
    renderBrandMarkers();
    renderPlacesResults();
  }
  _filterSnapshot = null;
  document.getElementById('lf-modal-overlay').classList.add('hidden');
  _updateFilterBadge();
}

function initLandmarkFilter() {
  const container = document.getElementById('lf-chips');
  if (!container) return;
  container.innerHTML = '';
  Object.entries(LANDMARK_COLORS).forEach(([cat, color]) => {
    if (cat === '711') return;
    const label = LF_LABELS[cat] || cat;
    const icon = LANDMARK_ICONS[cat] || '📍';
    const chip = document.createElement('button');
    chip.className = 'lf-chip active';
    chip.dataset.cat = cat;
    chip.style.setProperty('--chip-color', color);
    chip.innerHTML = `<span class="lf-chip-dot"></span>${icon} ${label}`;
    chip.addEventListener('click', () => {
      if (hiddenLandmarkCategories.has(cat)) {
        hiddenLandmarkCategories.delete(cat);
        if (cat === '7eleven') hiddenLandmarkCategories.delete('711');
        chip.classList.add('active');
      } else {
        hiddenLandmarkCategories.add(cat);
        if (cat === '7eleven') hiddenLandmarkCategories.add('711');
        chip.classList.remove('active');
      }
      refreshLandmarksLayer();
      renderBrandMarkers();
      _updateFilterBadge();
    });
    container.appendChild(chip);
  });

  const filterBtn = document.getElementById('lf-filter-btn');
  if (filterBtn) filterBtn.addEventListener('click', openLandmarkFilterModal);

  const closeBtn = document.getElementById('lf-modal-close');
  const cancelBtn = document.getElementById('lf-modal-cancel');
  const applyBtn = document.getElementById('lf-modal-apply');
  const overlay = document.getElementById('lf-modal-overlay');

  if (closeBtn) closeBtn.addEventListener('click', () => closeLandmarkFilterModal(false));
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeLandmarkFilterModal(false));
  if (applyBtn) applyBtn.addEventListener('click', () => {
    document.getElementById('nearby-panel').classList.add('hidden');
    document.getElementById('places-results-list').classList.remove('hidden');
    renderPlacesResults();
    closeLandmarkFilterModal(true);
  });
  if (overlay) overlay.addEventListener('click', e => {
    if (e.target === overlay) closeLandmarkFilterModal(false);
  });
}

function setAllLandmarkCategories(show) {
  hiddenLandmarkCategories.clear();
  if (!show) Object.keys(LANDMARK_COLORS).forEach(c => hiddenLandmarkCategories.add(c));
  document.querySelectorAll('.lf-chip').forEach(c => c.classList.toggle('active', show));
  refreshLandmarksLayer();
  renderBrandMarkers();
  _updateFilterBadge();
}

let landmarkFilterOpen = false;
function toggleLandmarkFilter() {
  landmarkFilterOpen = !landmarkFilterOpen;
  document.getElementById('landmark-filter-panel').classList.toggle('hidden', !landmarkFilterOpen);
  document.getElementById('btn-landmark-filter').classList.toggle('active', landmarkFilterOpen);
}

function _lmCategoryColor() {
  const cat = ['get', 'category'];
  return ['match', cat,
    'mall', '#E91E63',
    'hospital', '#F44336',
    'school', '#2196F3',
    'church', '#9C27B0',
    'gov', '#607D8B',
    'terminal', '#FF9800',
    'airport', '#00BCD4',
    'port', '#795548',
    'park', '#8BC34A',
    'bank', '#4CAF50',
    'market', '#FF5722',
    'landmark', '#673AB7',
    '7eleven', '#00703c',
    '711', '#00703c',
    'factory', '#546E7A',
    'gasstation', '#F57F17',
    'fastfood', '#E65100',
    'restaurant', '#6D4C41',
    '#888'
  ];
}

function _lmCategoryIcon() {
  const cat = ['get', 'category'];
  return ['match', cat,
    'mall', '🛍️',
    'hospital', '🏥',
    'school', '🏫',
    'church', '⛪',
    'gov', '🏛️',
    'terminal', '🚌',
    'airport', '✈️',
    'port', '⚓',
    'bank', '🏦',
    'market', '🛒',
    'park', '🌳',
    'landmark', '📍',
    '7eleven', '🏪',
    '711', '🏪',
    'factory', '🏭',
    'gasstation', '⛽',
    'fastfood', '🍔',
    'restaurant', '🍽️',
    '📍'
  ];
}

// ── Route Flow Animation ──────────────────────────
const _FLOW_DASH_SEQ = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5],
  [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5],
  [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
];

function _startRouteAnimation() {
  if (_flowAnimFrame) return;
  let lastTick = 0;
  function tick(ts) {
    if (ts - lastTick > 80) {
      lastTick = ts;
      _flowStep = (_flowStep + 1) % _FLOW_DASH_SEQ.length;
      const dash = _FLOW_DASH_SEQ[_flowStep];
      _flowLayerIds.forEach(id => {
        try {
          if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none')
            map.setPaintProperty(id, 'line-dasharray', dash);
        } catch { }
      });
      const glowOpacity = 0.13 + 0.07 * Math.sin(ts / 900);
      _glowLayerIds.forEach(id => {
        try {
          if (map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none')
            map.setPaintProperty(id, 'line-opacity', glowOpacity);
        } catch { }
      });
    }
    _flowAnimFrame = requestAnimationFrame(tick);
  }
  _flowAnimFrame = requestAnimationFrame(tick);
}

function _stopRouteAnimation() {
  if (_flowAnimFrame) { cancelAnimationFrame(_flowAnimFrame); _flowAnimFrame = null; }
}

function getBrand(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('jollibee')) return 'jollibee';
  if (n.includes('mcdonald') || n.includes('mcdo')) return 'mcdonalds';
  return '';
}

const JOLLIBEE_LOGO_URL = 'https://play-lh.googleusercontent.com/eolrJkDuZ2_msCv3a0oh3nqf107oNFXudzUlsN9L8T79C7UwWigYNaArKZgiQpiuqOs';
const MCDO_LOGO_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/McDonald%27s_Golden_Arches.svg/3840px-McDonald%27s_Golden_Arches.svg.png';

let _brandMarkers = [];
let _brandZoomListenerAdded = false;

function _updateBrandMarkerScale() {
  const zoom = map.getZoom();
  _brandMarkers.forEach(m => {
    const el = m.getElement();
    if (!landmarksVisible || zoom < 13) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const t = Math.min(1, (zoom - 13) / 3);
    el.style.opacity = Math.min(1, (zoom - 13) / 1.5).toFixed(3);
    el.style.transform = `scale(${(0.4 + t * 0.6).toFixed(3)})`;
    el.style.transformOrigin = 'bottom center';
  });
}

function makeBrandMarkerEl(l, brand) {
  const uid = (l.id || `${l.lat}${l.lng}`).toString().replace(/[^a-z0-9]/gi, '');
  const el = document.createElement('div');
  el.style.cssText = 'width:20px;height:20px;cursor:pointer';
  if (brand === 'jollibee') {
    el.innerHTML = `<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="bs${uid}" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.38)"/>
        </filter>
      </defs>
      <circle cx="10" cy="10" r="8" fill="#E31837" stroke="#E31837" stroke-width="1.5" filter="url(#bs${uid})"/>
      <text x="10" y="10" text-anchor="middle" dominant-baseline="central"
        font-size="11" font-weight="bold" font-family="Arial,sans-serif" fill="#fff">J</text>
    </svg>`;
  } else {
    const pad = 4;
    el.innerHTML = `<svg width="20" height="20" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <clipPath id="bc${uid}"><circle cx="10" cy="10" r="8"/></clipPath>
        <filter id="bs${uid}" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.38)"/>
        </filter>
      </defs>
      <circle cx="10" cy="10" r="8" fill="#fff" stroke="#dddddd" stroke-width="1.5" filter="url(#bs${uid})"/>
      <image href="${MCDO_LOGO_URL}" x="${1 + pad}" y="${1 + pad}" width="${18 - pad * 2}" height="${18 - pad * 2}"
        clip-path="url(#bc${uid})" preserveAspectRatio="xMidYMid meet"/>
    </svg>`;
  }
  return el;
}

function renderBrandMarkers() {
  _brandMarkers.forEach(m => m.remove());
  _brandMarkers = [];
  getAllLandmarks().forEach(l => {
    const brand = getBrand(l.name);
    if (!brand) return;
    if (hiddenLandmarkCategories.has(l.category || 'fastfood')) return;
    if (!_landmarkMatchesAreaFilter(l)) return;
    const el = makeBrandMarkerEl(l, brand);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const pinIcon = brand === 'jollibee' ? '🐝' : '🍔';
      const category = l.category || 'fastfood';
      const dbBtns = l.id && isAdmin() ? `
        <div class="lm-db-actions">
          <button class="lm-reposition-btn" onclick="startReposition('${escHtml(l.id)}','${escHtml(l.name)}',${l.lat},${l.lng},'${escHtml(category)}')">Move Pin</button>
          <button class="lm-delete-btn" onclick="deleteLandmark('${escHtml(l.id)}','${escHtml(l.name)}')">Remove</button>
        </div>` : '';
      if (activePopup) { activePopup.remove(); activePopup = null; }
      activePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: [0, -14] })
        .setLngLat([l.lng, l.lat])
        .setHTML(`<div class="landmark-popup">
          <strong>${escHtml(l.name)}</strong>
          <span class="category">${pinIcon} ${escHtml(LF_LABELS[category] || category)}</span>
          <span class="coords">${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}</span>
          <button class="lm-walk-btn" onclick="walkToLandmark(${l.lat},${l.lng},this)">🚶 Walk</button>
          ${dbBtns}
        </div>`)
        .addTo(map);
      activePopup.on('close', () => { activePopup = null; });
    });
    const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([l.lng, l.lat])
      .addTo(map);
    _brandMarkers.push(marker);
  });
  _updateBrandMarkerScale();
  if (!_brandZoomListenerAdded) {
    map.on('zoom', _updateBrandMarkerScale);
    _brandZoomListenerAdded = true;
  }
}

const LANDMARK_ICON_DATA = {
  mall: { color: '#E91E63', emoji: '🛍' },
  hospital: { color: '#F44336', emoji: '✚' },
  school: { color: '#42A5F5', emoji: '🏫' },
  church: { color: '#BA68C8', emoji: '⛪' },
  gov: { color: '#90A4AE', emoji: '🏛' },
  terminal: { color: '#FF9800', emoji: '🚌' },
  airport: { color: '#00BCD4', emoji: '✈' },
  port: { color: '#A1887F', emoji: '⚓' },
  park: { color: '#8BC34A', emoji: '🌳' },
  bank: { color: '#66BB6A', emoji: '🏦' },
  market: { color: '#FF7043', emoji: '🛒' },
  landmark: { color: '#9575CD', emoji: '📍' },
  '7eleven': { color: '#00703c', emoji: '7' },
  '711': { color: '#00703c', emoji: '7' },
  factory: { color: '#78909C', emoji: '🏭' },
  gasstation: { color: '#FFC107', emoji: '⛽' },
  fastfood: { color: '#FF7043', emoji: '🍔' },
  restaurant: { color: '#FF9800', emoji: '🍽' },
  cafe: { color: '#FF8F00', emoji: '☕' },
  accommodation: { color: '#0288D1', emoji: '🛏' },
  viewpoint: { color: '#F06292', emoji: '📸' },
  _default: { color: '#888888', emoji: '📍' },
};

function makeLandmarkCanvasImage(emoji, color) {
  const SIZE = 48, DPR = 2;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * DPR;
  canvas.height = SIZE * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  const r = SIZE / 2;

  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;
  ctx.beginPath();
  ctx.arc(r, r, r - 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowColor = 'transparent';

  const fontSize = Math.round(SIZE * 0.44);
  ctx.font = `${fontSize}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(emoji, r, r);

  const raw = ctx.getImageData(0, 0, SIZE * DPR, SIZE * DPR);
  return { width: SIZE * DPR, height: SIZE * DPR, data: new Uint8Array(raw.data.buffer) };
}

function registerLandmarkImages() {
  Object.entries(LANDMARK_ICON_DATA).forEach(([cat, { color, emoji }]) => {
    const id = `lm-${cat}`;
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, makeLandmarkCanvasImage(emoji, color), { pixelRatio: 2 });
  });
}

function addLandmarks() {
  if (map.getSource('landmarks')) return;

  try { renderBrandMarkers(); } catch (e) { console.warn('renderBrandMarkers failed:', e); }
  try { registerLandmarkImages(); } catch (e) { console.warn('registerLandmarkImages failed:', e); }

  const features = getAllLandmarks().map(l => {
    const cat = (l.category || 'landmark').trim().toLowerCase();
    const brand = getBrand(l.name);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [l.lng, l.lat] },
      properties: {
        name: l.name, category: cat,
        lat: l.lat, lng: l.lng, dbId: l.id || null,
        brand
      }
    };
  });

  try {
    map.addSource('landmarks', { type: 'geojson', data: { type: 'FeatureCollection', features } });
  } catch (e) { console.error('landmarks addSource failed:', e); return; }

  // Small colored dots — visible from afar, fade out as emoji orbs take over.
  try {
    map.addLayer({
      id: 'landmarks-circle',
      type: 'circle',
      source: 'landmarks',
      filter: ['==', ['get', 'brand'], ''],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 13, 2.5, 15, 3.5],
        'circle-color': ['match', ['get', 'category'],
          'mall', '#E91E63', 'hospital', '#F44336', 'school', '#42A5F5',
          'church', '#BA68C8', 'gov', '#90A4AE', 'terminal', '#FF9800',
          'airport', '#00BCD4', 'port', '#A1887F', 'park', '#8BC34A',
          'bank', '#66BB6A', 'market', '#FF7043', 'landmark', '#9575CD',
          '7eleven', '#00703c', '711', '#00703c', 'factory', '#78909C',
          'gasstation', '#FFC107', 'fastfood', '#FF7043', 'restaurant', '#FF9800',
          'cafe', '#FF8F00', 'accommodation', '#0288D1', 'viewpoint', '#F06292',
          '#888'
        ],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 13, 1, 15, 0],
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#fff',
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 15, 0],
      }
    });
  } catch (e) { console.error('landmarks-circle addLayer failed:', e); }

  // Canvas-drawn emoji orbs — fade in when zoomed close.
  try {
    map.addLayer({
      id: 'landmarks-icon',
      type: 'symbol',
      source: 'landmarks',
      filter: ['==', ['get', 'brand'], ''],
      minzoom: 13,
      layout: {
        'icon-image': ['match', ['get', 'category'],
          'mall', 'lm-mall', 'hospital', 'lm-hospital', 'school', 'lm-school',
          'church', 'lm-church', 'gov', 'lm-gov', 'terminal', 'lm-terminal',
          'airport', 'lm-airport', 'port', 'lm-port', 'park', 'lm-park',
          'bank', 'lm-bank', 'market', 'lm-market', 'landmark', 'lm-landmark',
          '7eleven', 'lm-7eleven', '711', 'lm-711', 'factory', 'lm-factory',
          'gasstation', 'lm-gasstation', 'fastfood', 'lm-fastfood',
          'restaurant', 'lm-restaurant', 'cafe', 'lm-cafe',
          'accommodation', 'lm-accommodation', 'viewpoint', 'lm-viewpoint',
          'lm-_default'
        ],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.22, 15, 0.38, 17, 0.52, 20, 0.7],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-anchor': 'center',
      },
      paint: {
        'icon-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 0.95]
      }
    });
  } catch (e) { console.error('landmarks-icon addLayer failed:', e); }

  const labelFont = currentMapStyle === STYLE_LIBERTY
    ? ['Noto Sans Regular']
    : ['Open Sans Regular', 'Arial Unicode MS Regular'];

  try {
    map.addLayer({
      id: 'landmarks-label',
      type: 'symbol',
      source: 'landmarks',
      filter: ['==', ['get', 'brand'], ''],
      minzoom: 14,
      layout: {
        'visibility': landmarksVisible ? 'visible' : 'none',
        'text-field': ['get', 'name'],
        'text-size': 12,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-ignore-placement': false,
        'text-font': labelFont,
      },
      paint: {
        'text-color': '#222',
        'text-halo-color': '#fff',
        'text-halo-width': 3
      }
    });
  } catch (e) { console.warn('landmarks-label addLayer failed:', e); }

  initLandmarkEvents();
}

function getTopNearbyRoutes(lat, lng, max = 4, thresholdKm = 1.5) {
  return routes
    .filter(r => Array.isArray(r.stops) && r.stops.length > 0)
    .map(r => ({
      r,
      dist: Math.min(...r.stops.map(s => haversine(lat, lng, s.lat, s.lng)))
    }))
    .filter(({ dist }) => dist <= thresholdKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, max);
}

// ── Init Landmark Event Listeners ─────────────────
// Re-attach event listeners when layers are recreated (e.g., on style change)
function initLandmarkEvents() {
  function handleLandmarkClick(e) {
    if (!e.features || !e.features[0]) return;
    const props = e.features[0].properties;
    const lat = parseFloat(props.lat);
    const lng = parseFloat(props.lng);
    const pinIcon = LANDMARK_ICONS[props.category] || '📍';
    const category = props.category || 'landmark';
    const dbBtns = props.dbId && isAdmin() ? `
      <div class="lm-db-actions">
        <button class="lm-reposition-btn" onclick="startReposition('${escHtml(props.dbId)}','${escHtml(props.name)}',${lat},${lng},'${escHtml(category)}')">Move Pin</button>
        <button class="lm-delete-btn" onclick="deleteLandmark('${escHtml(props.dbId)}','${escHtml(props.name)}')">Remove</button>
      </div>` : '';

    const nearby = getTopNearbyRoutes(lat, lng);
    const nearbyHtml = nearby.length
      ? `<div class="lm-nearby">
          <div class="lm-nearby-title">Nearby Routes</div>
          ${nearby.map(({ r, dist }) => {
        const distStr = dist < 1 ? `${Math.round(dist * 1000)} m` : `${dist.toFixed(1)} km`;
        return `<div class="lm-nearby-item" data-rid="${escHtml(r.id)}">
              <span class="lm-nearby-dot" style="background:${r.color || '#0046C7'}"></span>
              <span class="lm-nearby-name">${escHtml(r.name || 'Route')}</span>
              <span class="lm-nearby-dist">${distStr}</span>
            </div>`;
      }).join('')}
        </div>`
      : `<div class="lm-nearby"><span class="lm-nearby-none">No jeepney routes within 1.5 km</span></div>`;

    if (activePopup) { activePopup.remove(); activePopup = null; }
    activePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 15 })
      .setLngLat(e.lngLat)
      .setHTML(`<div class="landmark-popup">
        <strong>${escHtml(props.name)}</strong>
        <span class="category">${pinIcon} ${escHtml(LF_LABELS[category] || category)}</span>
        <span class="coords">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
        <button class="lm-walk-btn" onclick="walkToLandmark(${lat},${lng},this)">🚶 Walk</button>
        ${nearbyHtml}
        ${dbBtns}
      </div>`)
      .addTo(map);
    activePopup.getElement().querySelectorAll('.lm-nearby-item[data-rid]').forEach(el => {
      el.addEventListener('click', () => { showRouteDetail(el.dataset.rid); activePopup?.remove(); });
    });
    activePopup.on('close', () => { activePopup = null; });
  }

  try {
    map.on('click', 'landmarks-circle', handleLandmarkClick);
    map.on('mouseenter', 'landmarks-circle', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'landmarks-circle', () => map.getCanvas().style.cursor = '');
    map.on('click', 'landmarks-icon', handleLandmarkClick);
    map.on('mouseenter', 'landmarks-icon', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'landmarks-icon', () => map.getCanvas().style.cursor = '');
  } catch (e) { console.warn('landmarks event handlers failed:', e); }
}

// ── OSRM Helpers ─────────────────────────────────
async function snapToRoad(lat, lng) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch('https://valhalla1.openstreetmap.de/locate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: [{ lon: lng, lat }], costing: 'auto' }),
      signal: controller.signal,
    });
    if (!res.ok) return { lat, lng };
    const d = await res.json();
    const edge = d[0]?.edges?.[0];
    if (edge?.correlated_lat != null) return { lat: edge.correlated_lat, lng: edge.correlated_lon };
  } catch {
  } finally { clearTimeout(timer); }
  return { lat, lng };
}

function _decodePolyline6(encoded) {
  let i = 0, lat = 0, lng = 0;
  const coords = [];
  while (i < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / 1e6, lat / 1e6]); // [lng, lat] for GeoJSON
  }
  return coords;
}

async function getRoadSegment(fromLat, fromLng, toLat, toLng) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations: [{ lon: fromLng, lat: fromLat }, { lon: toLng, lat: toLat }],
        costing: 'auto',
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Valhalla ${res.status}`);
    const d = await res.json();
    const leg = d.trip?.legs?.[0];
    if (leg) {
      return { distKm: leg.summary.length, coords: _decodePolyline6(leg.shape) };
    }
  } catch {
    // fall through to straight-line
  } finally {
    clearTimeout(timer);
  }
  return { distKm: haversine(fromLat, fromLng, toLat, toLng), coords: [[fromLng, fromLat], [toLng, toLat]] };
}

// ── Haversine ────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getNearbyLandmarks(lat, lng, radiusM = 100, max = 2) {
  return getAllLandmarks()
    .map(l => ({ ...l, distM: Math.round(haversine(lat, lng, l.lat, l.lng) * 1000) }))
    .filter(l => l.distM <= radiusM)
    .sort((a, b) => a.distM - b.distM)
    .slice(0, max);
}

// ── Render Saved Routes on Map ───────────────────
function renderAllRoutesOnMap() {
  Object.keys(routeLayers).forEach(id => removeRouteFromMap(id));
  routes.forEach(r => { try { addRouteToMap(r); } catch (e) { console.warn('Failed to render route', r.id, e); } });
}

function makeArrowImage(color) {
  const size = 20;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color || '#0046C7';
  ctx.beginPath();
  ctx.moveTo(2, 3);
  ctx.lineTo(size - 3, size / 2);
  ctx.lineTo(2, size - 3);
  ctx.lineTo(size * 0.42, size / 2);
  ctx.closePath();
  ctx.fill();
  // Use {width,height,data} format — compatible with all MapLibre GL 4.x versions
  const imgData = ctx.getImageData(0, 0, size, size);
  return { width: size, height: size, data: imgData.data };
}

function makeTerminalPinImage(color) {
  const w = 30, h = 38;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const cx = w / 2;
  const r = 12;
  const cy = r + 1;

  // Drop shadow for the whole pin
  ctx.shadowColor = 'rgba(0,0,0,0.38)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 2;

  // Pin shape: upper arc + two lines converging to tip
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI / 6, 5 * Math.PI / 6, true);
  ctx.lineTo(cx, h - 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // Reset shadow before detail layers
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Redraw filled circle head over triangle overlap, then stroke white border
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Terminal 'T' symbol
  ctx.fillStyle = '#fff';
  ctx.font = `bold 13px 'Plus Jakarta Sans', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T', cx, cy);

  const imgData = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: imgData.data };
}

function addRouteToMap(route) {
  if (!map || !route.stops || route.stops.length < 2) return;
  removeRouteFromMap(route.id);

  const lineCoords = buildSavedRouteCoords(route);
  const srcId = `src-${route.id}`;
  const stopsSrcId = `stops-src-${route.id}`;
  const arrowImgId = `arrow-img-${route.id}`;

  map.addSource(srcId, {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords } }
  });
  map.addSource(stopsSrcId, {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: route.stops.map((s, i) => ({
        type: 'Feature',
        properties: {
          name: s.name,
          address: s.address || '',
          idx: i,
          isEnd: i === 0 || i === route.stops.length - 1,
          isStart: i === 0
        },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] }
      }))
    }
  });

  if (!map.hasImage(arrowImgId)) map.addImage(arrowImgId, makeArrowImage(route.color));

  const terminalImgId = `terminal-img-${route.id}`;
  if (!map.hasImage(terminalImgId)) map.addImage(terminalImgId, makeTerminalPinImage(route.color));

  const glowId = `glow-${route.id}`;
  const lineId = `line-${route.id}`;
  const arrowsId = `arrows-${route.id}`;
  const stopsId = `stops-${route.id}`;
  const terminalId = `terminal-${route.id}`;

  const _beforeLandmarks = () => {
    try { return map.getLayer('landmarks-circle') ? 'landmarks-circle' : undefined; } catch { return undefined; }
  };
  const _bl = _beforeLandmarks();

  map.addLayer({
    id: glowId, type: 'line', source: srcId,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': route.color, 'line-width': 14, 'line-opacity': 0.12, 'line-blur': 6 }
  }, _bl);
  map.addLayer({
    id: lineId, type: 'line', source: srcId,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': route.color, 'line-width': 4, 'line-opacity': 0.9 }
  }, _bl);
  const flowId = `flow-${route.id}`;
  map.addLayer({
    id: flowId, type: 'line', source: srcId,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': 2.5,
      'line-opacity': 0,
      'line-dasharray': _FLOW_DASH_SEQ[0]
    }
  }, _bl);
  _flowLayerIds.push(flowId);
  _glowLayerIds.push(glowId);
  map.addLayer({
    id: arrowsId, type: 'symbol', source: srcId,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 90,
      'icon-image': arrowImgId,
      'icon-size': 1.2,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    }
  }, _bl);
  const reverseArrowsId = `reverse-arrows-${route.id}`;
  map.addLayer({
    id: reverseArrowsId, type: 'symbol', source: srcId,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 110,
      'icon-image': arrowImgId,
      'icon-size': 0.9,
      'icon-rotate': 180,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': 0.45 }
  }, _bl);
  // All stops except the starting point (rendered as circle dots)
  map.addLayer({
    id: stopsId, type: 'circle', source: stopsSrcId,
    filter: ['!=', ['get', 'isStart'], true],
    paint: {
      'circle-radius': ['case', ['get', 'isEnd'], 5, 3.5],
      'circle-color': route.color,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#fff',
      'circle-opacity': 0.95
    }
  }, _bl);
  // Starting point rendered as a terminal pin icon
  map.addLayer({
    id: terminalId, type: 'symbol', source: stopsSrcId,
    filter: ['==', ['get', 'isStart'], true],
    layout: {
      'icon-image': terminalImgId,
      'icon-size': 1,
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': 1 }
  }, _bl);

  // Invisible circle layer on terminal for better click detection
  const terminalClickId = `terminal-click-${route.id}`;
  map.addLayer({
    id: terminalClickId, type: 'circle', source: stopsSrcId,
    filter: ['==', ['get', 'isStart'], true],
    paint: {
      'circle-radius': 14,
      'circle-color': '#fff',
      'circle-opacity': 0.001,
      'circle-stroke-width': 0
    }
  }, _bl);

  const handleStopClick = (e) => {
    if (builderOpen || simActive) return;
    const props = e.features[0]?.properties;
    const idx = props?.idx;
    const stop = route.stops[idx];
    if (!stop) return;
    showStopPopup(route, stop, e.lngLat);
    showRouteDetail(route.id);
    highlightStopItem(idx);
  };
  map.on('click', stopsId, handleStopClick);
  map.on('click', terminalClickId, handleStopClick);
  map.on('click', terminalId, handleStopClick);
  map.on('mouseenter', stopsId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', stopsId, () => { if (!builderOpen) map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', terminalClickId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', terminalClickId, () => { if (!builderOpen) map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', terminalId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', terminalId, () => { if (!builderOpen) map.getCanvas().style.cursor = ''; });

  map.on('click', lineId, async (e) => {
    if (builderOpen || simActive) return;
    const onStop = map.queryRenderedFeatures(e.point, { layers: [stopsId, terminalClickId, terminalId] });
    if (onStop.length > 0) return;

    // Detect all routes sharing this road segment
    const allLineIds = routes.flatMap(r => [`line-${r.id}`, `glow-${r.id}`]).filter(id => {
      try { return !!map.getLayer(id); } catch { return false; }
    });
    const hitFeatures = allLineIds.length ? map.queryRenderedFeatures(e.point, { layers: allLineIds }) : [];
    const hitRouteIds = [...new Set(hitFeatures.map(f => {
      const m = f.layer.id.match(/^(?:line|glow)-(.+)$/);
      return m ? m[1] : null;
    }).filter(Boolean))];
    const hitRoutes = hitRouteIds.map(id => routes.find(r => r.id === id)).filter(Boolean);

    const { lat, lng } = e.lngLat;
    if (activePopup) { activePopup.remove(); activePopup = null; }

    // Single route — hide others immediately and open detail
    if (hitRoutes.length === 1) {
      hideOtherRoutes(hitRoutes[0].id);
      showRouteDetail(hitRoutes[0].id);
      return;
    }

    // Multiple routes — let the user pick first, then hide others
    const routeRows = hitRoutes.map(r => `
      <div class="rlp-route rlp-route-btn" onclick="window._rlpSelect('${r.id}')">
        <div class="rlp-dot" style="background:${r.color}"></div>
        <span class="rlp-name">${escHtml(r.name)}</span>
        ${r.vehicle_type ? vehicleTag(r.vehicle_type) : ''}
      </div>`).join('');

    activePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 16, maxWidth: '260px' })
      .setLngLat(e.lngLat)
      .setHTML(`<div class="route-line-popup">
        <div class="rlp-shared-label">🚌 ${hitRoutes.length} routes on this road</div>
        ${routeRows}
        <div class="rlp-address rlp-loading">Locating…</div>
        <div class="rlp-coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      </div>`)
      .addTo(map);
    activePopup.on('close', () => { activePopup = null; });

    window._rlpSelect = (routeId) => {
      if (activePopup) { activePopup.remove(); activePopup = null; }
      showRouteDetail(routeId); // showRouteDetail already calls hideOtherRoutes
    };

    const address = await getAddressFromCoords(lat, lng);
    if (activePopup) {
      const el = activePopup.getElement().querySelector('.rlp-address');
      if (el) { el.textContent = address || 'No address found'; el.classList.remove('rlp-loading'); }
    }
  });
  map.on('mouseenter', lineId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', lineId, () => { if (!builderOpen) map.getCanvas().style.cursor = ''; });

  routeLayers[route.id] = [glowId, lineId, flowId, arrowsId, reverseArrowsId, stopsId, terminalId, terminalClickId];
  routeSources[route.id] = [srcId, stopsSrcId];
}

// ── Route Popup (quick info on line click) ────────
function showRoutePopup(route, lngLat) {
  if (activePopup) { activePopup.remove(); activePopup = null; }

  const totalKm = route.stops.reduce((s, st) => s + (st.roadDistFromPrev || 0), 0);

  activePopup = new maplibregl.Popup({
    closeButton: false, closeOnClick: true, offset: 16, maxWidth: '260px'
  })
    .setLngLat(lngLat)
    .setHTML(`
      <div class="route-popup">
        <div class="rp-header">
          <div class="rp-dot" style="background:${route.color}"></div>
          <div class="rp-name">${escHtml(route.name)}</div>
        </div>
        ${route.description ? `<div class="rp-desc">${escHtml(route.description)}</div>` : ''}
        <div class="rp-stats">
          <div class="rp-stat">🚏 ${route.stops.length} stops</div>
          <div class="rp-stat">📏 ${totalKm.toFixed(2)} km</div>
          <div class="rp-stat">💰 ₱${getFareRates(route.vehicle_type).base.toFixed(2)}–₱${calcFare(totalKm, route.vehicle_type).toFixed(2)}</div>
          ${route.hours ? `<div class="rp-stat">🕐 ${escHtml(route.hours)}</div>` : ''}
          ${route.frequency ? `<div class="rp-stat">🔁 ${escHtml(route.frequency)}</div>` : ''}
        </div>
        <button class="rp-btn" id="rp-detail-btn">View Details →</button>
      </div>
    `)
    .addTo(map);

  activePopup.getElement().querySelector('#rp-detail-btn')?.addEventListener('click', () => {
    activePopup.remove();
    activePopup = null;
    showRouteDetail(route.id);
  });
  activePopup.on('close', () => { activePopup = null; });
}

function showStopPopup(route, stop, lngLat) {
  if (activePopup) { activePopup.remove(); activePopup = null; }

  const nearby = getNearbyLandmarks(stop.lat, stop.lng, 70, 2);
  const nearbyHtml = nearby.length ? `
    <div class="sp-nearby">
      ${nearby.map(l => `
        <div class="sp-nearby-item">
          <span class="sp-nearby-icon">${LANDMARK_ICONS[l.category] || '📍'}</span>
          <span class="sp-nearby-name">${escHtml(l.name)}</span>
          <span class="sp-nearby-dist">${l.distM}m</span>
        </div>`).join('')}
    </div>` : '';

  activePopup = new maplibregl.Popup({
    closeButton: false, closeOnClick: true, offset: [0, -4], maxWidth: '260px'
  })
    .setLngLat(lngLat)
    .setHTML(`
      <div class="stop-popup">
        <div class="sp-badge">
          <div class="sp-dot" style="background:${route.color}"></div>
          <span style="color:${route.color}">${escHtml(route.name)}</span>
        </div>
        <div class="sp-name">${escHtml(stop.name)}</div>
        ${stop.address ? `<div class="sp-address">${escHtml(stop.address)}</div>` : ''}
        ${nearbyHtml}
      </div>
    `)
    .addTo(map);
  activePopup.on('close', () => { activePopup = null; });
}

function hideOtherRoutes(routeId) {
  if (!map || !routes.length) return;
  routes.forEach(r => {
    const isActive = r.id === routeId;
    const vis = isActive ? 'visible' : 'none';
    try { map.setLayoutProperty(`line-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`line-${r.id}`, 'line-opacity', isActive ? 1 : 0.9); } catch { }
    try { map.setPaintProperty(`line-${r.id}`, 'line-width', isActive ? 5 : 4); } catch { }
    try { map.setLayoutProperty(`stops-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`stops-${r.id}`, 'circle-opacity', 0.95); } catch { }
    try { map.setLayoutProperty(`glow-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`glow-${r.id}`, 'line-opacity', isActive ? 0.4 : 0.12); } catch { }
    try { map.setLayoutProperty(`arrows-${r.id}`, 'visibility', isActive ? 'visible' : 'none'); } catch { }
    try { map.setLayoutProperty(`reverse-arrows-${r.id}`, 'visibility', isActive ? 'visible' : 'none'); } catch { }
    try { map.setLayoutProperty(`terminal-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`terminal-${r.id}`, 'icon-opacity', 1); } catch { }
    try { map.setPaintProperty(`terminal-click-${r.id}`, 'circle-opacity', 0); } catch { }
    try { map.setLayoutProperty(`flow-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`flow-${r.id}`, 'line-opacity', isActive ? 0.5 : 0); } catch { }
  });
  _startRouteAnimation();
}

function showAllRoutes() {
  if (!map || !routes.length) return;
  _stopRouteAnimation();
  routes.forEach(r => {
    try { map.setLayoutProperty(`line-${r.id}`, 'visibility', 'visible'); } catch { }
    try { map.setPaintProperty(`line-${r.id}`, 'line-opacity', 0.9); } catch { }
    try { map.setPaintProperty(`line-${r.id}`, 'line-width', 4); } catch { }
    try { map.setLayoutProperty(`stops-${r.id}`, 'visibility', 'visible'); } catch { }
    try { map.setPaintProperty(`stops-${r.id}`, 'circle-opacity', 0.95); } catch { }
    try { map.setLayoutProperty(`glow-${r.id}`, 'visibility', 'visible'); } catch { }
    try { map.setPaintProperty(`glow-${r.id}`, 'line-opacity', 0.12); } catch { }
    try { map.setLayoutProperty(`arrows-${r.id}`, 'visibility', 'visible'); } catch { }
    try { map.setLayoutProperty(`reverse-arrows-${r.id}`, 'visibility', 'visible'); } catch { }
    try { map.setLayoutProperty(`terminal-${r.id}`, 'visibility', 'visible'); } catch { }
    try { map.setPaintProperty(`terminal-${r.id}`, 'icon-opacity', 1); } catch { }
    try { map.setPaintProperty(`terminal-click-${r.id}`, 'circle-opacity', 0); } catch { }
    try { map.setLayoutProperty(`flow-${r.id}`, 'visibility', 'visible'); } catch { }
    try { map.setPaintProperty(`flow-${r.id}`, 'line-opacity', 0); } catch { }
  });
}

function buildSavedRouteCoords(route) {
  if (!route.stops?.length) return [];
  const all = [[route.stops[0].lng, route.stops[0].lat]];
  for (let i = 1; i < route.stops.length; i++) {
    const path = route.stops[i].roadPathFromPrev;
    if (path?.length > 1) all.push(...path.slice(1));
    else all.push([route.stops[i].lng, route.stops[i].lat]);
  }
  return all;
}

// Mirrors mobile _findNearestRoutePoint(): finds the closest point on the route via ACTUAL ROUTED DISTANCE.
// Instead of geometric projection, samples route stops and polyline points, calculates routed walk distance to each,
// and returns the one with shortest walking distance via actual pedestrian network.
async function findNearestPointForWalk(route, lat, lng) {
  const coords = buildSavedRouteCoords(route); // [[lng, lat], ...]
  if (!coords.length) return { lat, lng };

  // Find nearest route vertex (geometric) and sample a focused window around it
  const nv = findNearestVertex(route, lat, lng);
  const centerIdx = nv.idx || 0;
  const windowSize = Math.max(20, Math.floor(coords.length * 0.05)); // at least 20 points, ~5% of route
  const start = Math.max(0, centerIdx - windowSize);
  const end = Math.min(coords.length - 1, centerIdx + windowSize);

  const candidates = [];
  // include all stops as candidates (they may be useful)
  for (let i = 0; i < route.stops.length; i++) {
    candidates.push({ lat: route.stops[i].lat, lng: route.stops[i].lng, type: 'stop', index: -1 });
  }
  // include dense vertices in the focused window
  for (let i = start; i <= end; i++) {
    candidates.push({ lat: coords[i][1], lng: coords[i][0], type: 'polyline', index: i });
  }

  console.log(`[walk] "${route.name}" focused sampling ${candidates.length} candidates around idx=${centerIdx} (window=${windowSize})`);

  // Evaluate candidates in batches against OSRM /table
  let bestDistKm = Infinity, bestPoint = { lat, lng };
  const MAX_BATCH = 50;
  for (let batch = 0; batch < candidates.length; batch += MAX_BATCH) {
    const batchCands = candidates.slice(batch, batch + MAX_BATCH);
    const osrmCandidates = batchCands.map(c => `${c.lng},${c.lat}`).join(';');
    try {
      const url = `https://router.project-osrm.org/table/v1/foot/${lng},${lat};${osrmCandidates}?annotations=distance`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM table ${res.status}`);
      const data = await res.json();
      if (data.distances && data.distances[0]) {
        const distances = data.distances[0].slice(1);
        distances.forEach((distMeters, idx) => {
          const distKm = distMeters / 1000;
          if (distKm < bestDistKm) {
            bestDistKm = distKm;
            bestPoint = batchCands[idx];
          }
        });
      }
    } catch (e) {
      console.warn('[walk] OSRM table batch failed, using geometric fallback', e);
      batchCands.forEach(c => {
        const d = haversine(lat, lng, c.lat, c.lng);
        if (d < bestDistKm) {
          bestDistKm = d;
          bestPoint = c;
        }
      });
    }
  }

  console.log(`[walk] → best candidate (${bestPoint.type}): ${bestDistKm.toFixed(3)}km away at (${bestPoint.lat.toFixed(4)},${bestPoint.lng.toFixed(4)})`);
  return bestPoint;
}

function findNearestOnRoute(route, lat, lng) {
  let minDist = Infinity, bestLat = null, bestLng = null;

  for (let si = 0; si < route.stops.length - 1; si++) {
    const stopA = route.stops[si], stopB = route.stops[si + 1];
    const path = stopB.roadPathFromPrev;

    // Use only interior road coords — exclude the stop endpoints themselves
    let interior;
    if (path && path.length > 2) {
      interior = path.slice(1, -1); // drop first (= stopA) and last (= stopB)
    } else {
      // No road data: use midpoint of the straight line between stops
      interior = [[(stopA.lng + stopB.lng) / 2, (stopA.lat + stopB.lat) / 2]];
    }

    if (interior.length === 1) {
      const iy = interior[0][1], ix = interior[0][0];
      if (!route.stops.some(s => haversine(iy, ix, s.lat, s.lng) < 0.01)) {
        const d = haversine(lat, lng, iy, ix);
        if (d < minDist) { minDist = d; bestLat = iy; bestLng = ix; }
      }
      continue;
    }

    for (let i = 0; i < interior.length - 1; i++) {
      const ax = interior[i][0], ay = interior[i][1];
      const bx = interior[i + 1][0], by = interior[i + 1][1];
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 0 ? Math.max(0, Math.min(1, ((lng - ax) * dx + (lat - ay) * dy) / lenSq)) : 0;
      const cx = ax + t * dx, cy = ay + t * dy;
      // Skip if projected foot lands within 10 m of any stop
      if (route.stops.some(s => haversine(cy, cx, s.lat, s.lng) < 0.01)) continue;
      const d = haversine(lat, lng, cy, cx);
      if (d < minDist) { minDist = d; bestLat = cy; bestLng = cx; }
    }
  }

  if (bestLat === null) {
    // Fallback: nearest stop
    const ns = route.stops.reduce((b, s) => { const d = haversine(lat, lng, s.lat, s.lng); return d < b.d ? { s, d } : b; }, { s: route.stops[0], d: Infinity }).s;
    return { lat: ns.lat, lng: ns.lng, dist: Infinity };
  }
  return { lat: bestLat, lng: bestLng, dist: minDist };
}

// Choose the nearest actual vertex from the saved route coordinates
function findNearestVertex(route, lat, lng) {
  const coords = buildSavedRouteCoords(route); // [[lng, lat], ...]
  if (!coords.length) return { lat, lng, dist: Infinity };
  let bestIdx = 0; let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const cx = coords[i][0], cy = coords[i][1];
    const d = haversine(lat, lng, cy, cx);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return { lat: coords[bestIdx][1], lng: coords[bestIdx][0], dist: bestDist, idx: bestIdx };
}

// Query OSRM nearest endpoint to snap a coordinate to the routable pedestrian network
async function osrmNearest(lng, lat) {
  try {
    const url = `https://router.project-osrm.org/nearest/v1/foot/${lng},${lat}?number=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM nearest ${res.status}`);
    const data = await res.json();
    const wp = data.waypoints && data.waypoints[0];
    if (wp && wp.location && wp.location.length >= 2) {
      return { lng: wp.location[0], lat: wp.location[1] };
    }
  } catch (e) {
    console.warn('OSRM nearest failed', e);
  }
  return null;
}

function removeRouteFromMap(routeId) {
  const layers = routeLayers[routeId] || [];
  _flowLayerIds = _flowLayerIds.filter(id => !layers.includes(id));
  _glowLayerIds = _glowLayerIds.filter(id => !layers.includes(id));
  layers.forEach(lyr => { try { map.removeLayer(lyr); } catch { } });
  (routeSources[routeId] || []).forEach(src => { try { map.removeSource(src); } catch { } });
  try { if (map.hasImage(`arrow-img-${routeId}`)) map.removeImage(`arrow-img-${routeId}`); } catch { }
  try { if (map.hasImage(`terminal-img-${routeId}`)) map.removeImage(`terminal-img-${routeId}`); } catch { }
  delete routeLayers[routeId];
  delete routeSources[routeId];
}

// ── Area Filter ───────────────────────────────────
function _routeMatchesArea(route) {
  if (!filterTown && !filterBarangay) return true;
  return route.stops.some(s => {
    const feat = getBrgyFeatureFromCoords(s.lng, s.lat);
    if (!feat) return false;
    if (filterBarangay) return feat.properties.name === filterBarangay;
    return feat.properties.city === filterTown;
  });
}

function _populateBrgyDropdown() {
  const sel = document.getElementById('af-barangay');
  sel.innerHTML = '<option value="">All Barangays</option>';
  if (!filterTown) { sel.disabled = true; return; }
  sel.disabled = false;
  (_areaIndex[filterTown] || []).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  });
}

function _syncAreaClearBtn() {
  const btn = document.getElementById('af-clear');
  btn.style.display = (filterTown || filterBarangay) ? '' : 'none';
}

function initAreaFilter() {
  buildAreaIndex();
  const townSel = document.getElementById('af-town');
  Object.keys(_areaIndex).sort().forEach(city => {
    const opt = document.createElement('option');
    opt.value = city; opt.textContent = city;
    townSel.appendChild(opt);
  });

  townSel.addEventListener('change', () => {
    filterTown = townSel.value;
    filterBarangay = '';
    _populateBrgyDropdown();
    _syncAreaClearBtn();
    renderRouteList(document.getElementById('route-search').value);
    refreshLandmarksLayer();
    flyToAreaFilter();
    renderPlacesResults();
  });

  document.getElementById('af-barangay').addEventListener('change', e => {
    filterBarangay = e.target.value;
    _syncAreaClearBtn();
    renderRouteList(document.getElementById('route-search').value);
    refreshLandmarksLayer();
    flyToAreaFilter();
    renderPlacesResults();
  });

  document.getElementById('af-clear').addEventListener('click', () => {
    filterTown = ''; filterBarangay = '';
    document.getElementById('af-town').value = '';
    document.getElementById('af-barangay').value = '';
    _populateBrgyDropdown();
    _syncAreaClearBtn();
    renderRouteList(document.getElementById('route-search').value);
    refreshLandmarksLayer();
    renderPlacesResults();
  });
}

// ── Route List ────────────────────────────────────
function applyMapFilter(visibleIds) {
  if (!map) return;
  const all = visibleIds === null;
  routes.forEach(r => {
    const show = all || visibleIds.has(r.id);
    const vis = show ? 'visible' : 'none';
    try { map.setLayoutProperty(`line-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`line-${r.id}`, 'line-opacity', 0.9); } catch { }
    try { map.setPaintProperty(`line-${r.id}`, 'line-width', 4); } catch { }
    try { map.setLayoutProperty(`stops-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`stops-${r.id}`, 'circle-opacity', 0.95); } catch { }
    try { map.setLayoutProperty(`glow-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`glow-${r.id}`, 'line-opacity', 0.12); } catch { }
    try { map.setLayoutProperty(`arrows-${r.id}`, 'visibility', show ? 'visible' : 'none'); } catch { }
    try { map.setLayoutProperty(`reverse-arrows-${r.id}`, 'visibility', show ? 'visible' : 'none'); } catch { }
    try { map.setLayoutProperty(`terminal-${r.id}`, 'visibility', vis); } catch { }
    try { map.setPaintProperty(`terminal-${r.id}`, 'icon-opacity', 1); } catch { }
  });
}

function initVehicleFilter() {
  document.getElementById('vehicle-filter').addEventListener('click', e => {
    const chip = e.target.closest('.vf-chip');
    if (!chip) return;
    filterVehicle = chip.dataset.vt;
    document.querySelectorAll('.vf-chip').forEach(c => c.classList.toggle('active', c === chip));
    renderRouteList(document.getElementById('route-search').value);
  });
}

function renderRouteList(filter = '') {
  const list = document.getElementById('route-list');
  const empty = document.getElementById('empty-state');
  const q = filter.toLowerCase();
  const filtered = routes.filter(r =>
    (!q || r.name.toLowerCase().includes(q) || r.stops.some(s => s.name.toLowerCase().includes(q))) &&
    _routeMatchesArea(r) &&
    (!filterVehicle || (r.vehicle_type || 'puj') === filterVehicle)
  );

  const isFiltered = q || filterTown || filterBarangay || filterVehicle;
  if (!activeRouteId) applyMapFilter(isFiltered ? new Set(filtered.map(r => r.id)) : null);

  list.innerHTML = '';
  empty.classList.toggle('hidden', filtered.length > 0);

  filtered.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = `route-item${activeRouteId === r.id ? ' active' : ''}`;
    div.dataset.id = r.id;
    div.style.animationDelay = `${i * 0.05}s`;
    const liveCount = _livePasadaCounts[r.id] || 0;
    const liveBadge = liveCount > 0
      ? `<span class="live-pasada-badge"><span class="live-dot"></span><span class="live-badge-count">${liveCount}</span> live</span>`
      : '';
    div.innerHTML = `
      <div class="route-item-dot" style="background:${r.color}"></div>
      <div class="route-item-info">
        <div class="route-item-name">${r.name}</div>
        <div class="route-item-meta">${r.stops.length} stops · ${routeTotalDistStr(r)}${r.vehicle_type ? ` · ${vehicleTag(r.vehicle_type)}` : ''}${liveBadge ? `&ensp;${liveBadge}` : ''}</div>
      </div>
      ${isAdmin() ? `<div class="route-item-actions">
        <button class="btn-icon-sm" data-action="edit" title="Edit">✎</button>
        <button class="btn-icon-sm delete" data-action="delete" title="Delete">🗑</button>
      </div>` : ''}`;
    div.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'edit') { startEdit(r.id); return; }
      if (action === 'delete') { confirmDelete(r.id); return; }
      showRouteDetail(r.id);
    });
    list.appendChild(div);
  });
}

function routeTotalDistStr(route) {
  if (!route.stops || route.stops.length < 2) return '—';
  const km = route.stops.reduce((sum, s) => sum + (s.roadDistFromPrev || 0), 0);
  return `${km.toFixed(2)} km`;
}

function updateRouteCount() {
  document.getElementById('route-count').textContent = routes.length;
}

// ── Route Detail ──────────────────────────────────
function showRouteDetail(routeId) {
  const route = routes.find(r => r.id === routeId);
  if (!route) return;

  activeRouteId = routeId;
  document.querySelectorAll('#route-list .route-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === routeId);
  });

  // Hide other routes when one is selected
  hideOtherRoutes(routeId);

  const totalKm = route.stops.reduce((s, st) => s + (st.roadDistFromPrev || 0), 0);

  document.getElementById('detail-dot').style.background = route.color;
  document.getElementById('detail-title').textContent = route.name;
  document.getElementById('detail-desc').innerHTML =
    (route.vehicle_type ? vehicleTag(route.vehicle_type) + ' ' : '') +
    (route.description ? escHtml(route.description) : '');
  document.getElementById('detail-stats').innerHTML = `
    <div class="detail-stat">
      <div class="detail-stat-value" style="color:${route.color}">${route.stops.length}</div>
      <div class="detail-stat-label">Stops</div>
    </div>
    <div class="detail-stat">
      <div class="detail-stat-value" style="color:${route.color}">${totalKm.toFixed(1)}</div>
      <div class="detail-stat-label">km</div>
    </div>
    <div class="detail-stat">
      <div class="detail-stat-value" style="color:${route.color}">₱${getFareRates(route.vehicle_type).base.toFixed(2)}</div>
      <div class="detail-stat-label">Base Fare</div>
    </div>
    <div class="detail-stat">
      <div class="detail-stat-value" style="color:${route.color}">₱${calcFare(totalKm, route.vehicle_type).toFixed(2)}</div>
      <div class="detail-stat-label">Max Fare</div>
    </div>`;

  const tl = document.getElementById('stops-timeline');
  tl.innerHTML = route.stops.map((s, i) => {
    const dist = i === 0 ? 'Start' : `+${s.roadDistFromPrev.toFixed(2)} km`;
    const isEnd = i === 0 || i === route.stops.length - 1;
    const nearby = getNearbyLandmarks(s.lat, s.lng, 100, 2);
    const nearbyHtml = nearby.map(l =>
      `<span class="stop-landmark">${LANDMARK_ICONS[l.category] || '📍'} ${escHtml(l.name)} <em>${l.distM}m</em></span>`
    ).join('');
    return `<div class="stop-item" data-i="${i}">
      <div class="stop-timeline">
        <div class="stop-dot" style="border-color:${route.color};${isEnd ? `background:${route.color};` : ''}"></div>
        <div class="stop-line" style="background:${route.color};"></div>
      </div>
      <div class="stop-info">
        <div class="stop-name">${s.name}</div>
        <div class="stop-dist">${dist}</div>
        ${nearbyHtml ? `<div class="stop-landmarks">${nearbyHtml}</div>` : ''}
      </div></div>`;
  }).join('');
  tl.querySelectorAll('.stop-item').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const i = +el.dataset.i;
      const stop = route.stops[i];
      map.flyTo({ center: [stop.lng, stop.lat], zoom: 16, duration: 900 });
      highlightStopItem(i);
      showStopPopup(route, stop, { lng: stop.lng, lat: stop.lat });
    });
  });

  document.getElementById('detail-hours').textContent = route.hours || '—';
  document.getElementById('detail-frequency').textContent = route.frequency || '—';
  _updateDetailLiveBanner(routeId);
  document.getElementById('route-detail').classList.add('visible');
  document.getElementById('sidebar-toggle').classList.remove('visible');
  closePlaceSearch();
  if (DEVICE_CONFIG.isMobile()) {
    document.getElementById('sidebar').classList.add('collapsed');
  }

  if (route.stops.length >= 2) {
    const bounds = new maplibregl.LngLatBounds();
    route.stops.forEach(s => bounds.extend([s.lng, s.lat]));
    const vw = window.innerWidth;
    const pad = vw < 700 ? 40 : { top: 80, bottom: 80, left: 340, right: 80 };
    map.fitBounds(bounds, { padding: pad, duration: 1200, maxZoom: 16 });
  }
}

function highlightStopItem(idx) {
  document.querySelectorAll('#stops-timeline .stop-item').forEach(el => el.classList.remove('active-stop'));
  const el = document.querySelector(`#stops-timeline .stop-item[data-i="${idx}"]`);
  if (!el) return;
  el.classList.add('active-stop');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideRouteDetail() {
  document.getElementById('route-detail').classList.remove('visible');
  if (DEVICE_CONFIG.isMobile()) document.getElementById('sidebar-toggle').classList.add('visible');
  activeRouteId = null;
  showAllRoutes();
  document.querySelectorAll('#route-list .route-item').forEach(el => el.classList.remove('active'));
}

// ── Feedback ──────────────────────────────────────
const FEEDBACK_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const FEEDBACK_COOLDOWN_KEY = 'esuyo_feedback_last';
const FEEDBACK_MAX_CHARS = 1000;
// Blocks obvious SQL injection patterns in text fields
const SQL_RE = /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|EXEC|EXECUTE|UNION|CAST|CONVERT|DECLARE|FETCH|CURSOR|GRANT|REVOKE)\b|--|\/\*|\*\/|'\s*(OR|AND)\s*'?\d)/i;

function hasSqlInjection(str) {
  return SQL_RE.test(str);
}

function getFeedbackCooldownRemaining() {
  const last = parseInt(localStorage.getItem(FEEDBACK_COOLDOWN_KEY) || '0', 10);
  const remaining = last + FEEDBACK_COOLDOWN_MS - Date.now();
  return remaining > 0 ? remaining : 0;
}

function openFeedback() {
  document.getElementById('feedback-category').value = '';
  document.getElementById('feedback-name').value = '';
  document.getElementById('feedback-description').value = '';
  document.getElementById('feedback-char-count').textContent = '0';
  document.getElementById('feedback-char-count').closest('.feedback-char-row').classList.remove('near-limit');
  document.getElementById('feedback-error').classList.add('hidden');

  const remaining = getFeedbackCooldownRemaining();
  const btn = document.getElementById('feedback-submit');
  if (remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    btn.disabled = true;
    btn.textContent = `Try again in ${mins} min`;
  } else {
    btn.disabled = false;
    btn.textContent = 'Send Feedback';
  }
  document.getElementById('feedback-overlay').classList.remove('hidden');
}

function closeFeedback() {
  document.getElementById('feedback-overlay').classList.add('hidden');
}

async function _sendFeedbackToDb(category, name, description) {
  const { error } = await _supabase.from('feedback').insert({
    category,
    name: name || null,
    description,
  });
  if (error) throw error;
}

function _validateFeedbackInput(category, name, description, showError) {
  if (!category) { showError('Please select a category.'); return false; }
  if (!description) { showError('Please enter a description.'); return false; }
  if (description.length > FEEDBACK_MAX_CHARS) {
    showError(`Description must be ${FEEDBACK_MAX_CHARS} characters or fewer.`); return false;
  }
  if (hasSqlInjection(description) || hasSqlInjection(name)) {
    showError('Invalid characters detected. Please rephrase your feedback.'); return false;
  }
  const remaining = getFeedbackCooldownRemaining();
  if (remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    showError(`Please wait ${mins} more minute${mins !== 1 ? 's' : ''} before submitting again.`);
    return false;
  }
  return true;
}

async function submitFeedback() {
  const category = document.getElementById('feedback-category').value;
  const name = document.getElementById('feedback-name').value.trim();
  const description = document.getElementById('feedback-description').value.trim();
  const btn = document.getElementById('feedback-submit');

  if (!_validateFeedbackInput(category, name, description, showFeedbackError)) return;

  btn.disabled = true;
  btn.textContent = 'Sending…';
  document.getElementById('feedback-error').classList.add('hidden');

  try {
    await _sendFeedbackToDb(category, name, description);
    localStorage.setItem(FEEDBACK_COOLDOWN_KEY, String(Date.now()));
    btn.textContent = '✓ Sent!';
    btn.classList.add('feedback-sent');
    setTimeout(closeFeedback, 1200);
  } catch (e) {
    showFeedbackError('Failed to send: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Send Feedback';
  }
}

function showFeedbackError(msg) {
  const el = document.getElementById('feedback-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function initFeedbackCharCounter() {
  const ta = document.getElementById('feedback-description');
  const counter = document.getElementById('feedback-char-count');
  const row = counter.closest('.feedback-char-row');
  ta.addEventListener('input', () => {
    const len = ta.value.length;
    counter.textContent = len;
    row.classList.toggle('near-limit', len >= 900);
  });
}

// ── Feedback Widget (desktop) ─────────────────────
function initFeedbackWidget() {
  const ta = document.getElementById('fw-description');
  const counter = document.getElementById('fw-char-count');
  if (!ta || !counter) return;
  const row = counter.closest('.fw-char-row');
  ta.addEventListener('input', () => {
    const len = ta.value.length;
    counter.textContent = len;
    row.classList.toggle('fw-near-limit', len >= 900);
  });

  document.getElementById('fw-toggle-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const widget = document.getElementById('feedback-widget');
    const collapsed = widget.classList.toggle('fw-collapsed');
    document.getElementById('fw-toggle-btn').title = collapsed ? 'Expand' : 'Collapse';
  });

  document.getElementById('fw-header').addEventListener('click', () => {
    const widget = document.getElementById('feedback-widget');
    if (widget.classList.contains('fw-collapsed')) {
      widget.classList.remove('fw-collapsed');
      document.getElementById('fw-toggle-btn').title = 'Collapse';
    }
  });

  document.getElementById('fw-submit').addEventListener('click', submitFeedbackWidget);

  const remaining = getFeedbackCooldownRemaining();
  if (remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    const btn = document.getElementById('fw-submit');
    btn.disabled = true;
    btn.textContent = `Try again in ${mins} min`;
  }
}

async function submitFeedbackWidget() {
  const category = document.getElementById('fw-category').value;
  const name = document.getElementById('fw-name').value.trim();
  const description = document.getElementById('fw-description').value.trim();
  const btn = document.getElementById('fw-submit');

  if (!_validateFeedbackInput(category, name, description, showFeedbackWidgetError)) return;

  btn.disabled = true;
  btn.textContent = 'Sending…';
  document.getElementById('fw-error').classList.add('hidden');

  try {
    await _sendFeedbackToDb(category, name, description);
    localStorage.setItem(FEEDBACK_COOLDOWN_KEY, String(Date.now()));
    btn.textContent = '✓ Sent!';
    btn.style.background = '#22c55e';
    setTimeout(() => {
      document.getElementById('fw-category').value = '';
      document.getElementById('fw-name').value = '';
      document.getElementById('fw-description').value = '';
      document.getElementById('fw-char-count').textContent = '0';
      btn.disabled = false;
      btn.textContent = 'Send Feedback';
      btn.style.background = '';
    }, 2000);
  } catch (e) {
    showFeedbackWidgetError('Failed to send: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Send Feedback';
  }
}

function showFeedbackWidgetError(msg) {
  const el = document.getElementById('fw-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── QR Code ───────────────────────────────────────
function showQrModal(routeId) {
  const route = routes.find(r => r.id === routeId);
  if (!route) return;

  document.getElementById('qr-route-dot').style.background = route.color;
  document.getElementById('qr-route-name').textContent = route.name;
  document.getElementById('qr-route-type').textContent = route.vehicle_type
    ? (FARE_MATRIX[route.vehicle_type]?.fullLabel || route.vehicle_type) : '';
  document.getElementById('qr-route-id').textContent = route.id;

  const container = document.getElementById('qr-container');
  container.innerHTML = '';
  new QRCode(container, {
    text: route.id,
    width: 300,
    height: 300,
    colorDark: '#0F172A',
    colorLight: '#FFFFFF',
    correctLevel: QRCode.CorrectLevel.H
  });

  document.getElementById('qr-modal-overlay').classList.remove('hidden');
}

function closeQrModal() {
  document.getElementById('qr-modal-overlay').classList.add('hidden');
}

function downloadQr() {
  const container = document.getElementById('qr-container');
  const canvas = container.querySelector('canvas');
  if (!canvas) return;
  const route = routes.find(r => r.id === activeRouteId);
  const name = (route?.name || 'route').replace(/\s+/g, '-').toLowerCase();
  const link = document.createElement('a');
  link.download = `esuyo-qr-${name}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}


// ── Builder ───────────────────────────────────────
function openBuilder(routeId = null) {
  editingRouteId = routeId;
  builderOpen = true;
  if (activePopup) { activePopup.remove(); activePopup = null; }
  document.getElementById('route-detail').classList.remove('visible');

  // Lazy load Google Places when builder opens
  _initGooglePlaces();

  if (routeId) {
    const r = routes.find(x => x.id === routeId);
    document.getElementById('builder-title').textContent = 'Edit Route';
    document.getElementById('route-name-input').value = r.name;
    document.getElementById('route-color-input').value = r.color;
    document.getElementById('route-hours-input').value = r.hours || '5:00 AM – 9:00 PM';
    document.getElementById('route-freq-input').value = r.frequency || 'Every 10 min';
    document.getElementById('route-desc-input').value = r.description || '';
    document.getElementById('route-vehicle-input').value = r.vehicle_type || 'puj';
    draftStops = r.stops.map(s => ({ ...s, roadPathFromPrev: s.roadPathFromPrev ? [...s.roadPathFromPrev] : [] }));
    hideOtherRoutes(null);
  } else {
    document.getElementById('builder-title').textContent = 'New Route';
    document.getElementById('route-name-input').value = '';
    document.getElementById('route-color-input').value = '#0046C7';
    document.getElementById('route-hours-input').value = '5:00 AM – 9:00 PM';
    document.getElementById('route-freq-input').value = 'Every 10 min';
    document.getElementById('route-desc-input').value = '';
    draftStops = [];
    hideOtherRoutes(null);
  }

  refreshDraftMap();
  renderDraftStopsList();
  updateFareSummary();
  document.getElementById('builder-panel').classList.add('open');
  setBuilderInstruction('Click map to add stops');
  enableMapPlacing();
}

function closeBuilder() {
  builderOpen = false;
  disableMapPlacing();
  clearDraftLayers();
  document.getElementById('builder-panel').classList.remove('open');
  renderRouteList(document.getElementById('route-search').value);
}

function enableMapPlacing() {
  disableMapPlacing();
  mapClickHandler = async (e) => {
    if (isSnapping) return;
    await addDraftStop(e.lngLat.lat, e.lngLat.lng);
  };
  map.on('click', mapClickHandler);
  map.getCanvas().style.cursor = 'crosshair';
}

function disableMapPlacing() {
  if (mapClickHandler) { map.off('click', mapClickHandler); mapClickHandler = null; }
  map.getCanvas().style.cursor = '';
}

function setBuilderInstruction(msg, loading = false) {
  document.getElementById('builder-instructions').innerHTML =
    `<span class="pulse-dot"${loading ? '' : ''}></span> ${msg}`;
}

// ── Add Stop — snap to road then trace ───────────
async function addDraftStop(rawLat, rawLng) {
  isSnapping = true;
  setBuilderInstruction('Snapping to road…', true);
  map.getCanvas().style.cursor = 'wait';

  try {
    const prev = draftStops.length > 0 ? draftStops[draftStops.length - 1] : null;
    const [snapped, address] = await Promise.all([
      snapToRoad(rawLat, rawLng),
      getAddressFromCoords(rawLat, rawLng),
    ]);
    const { lat, lng } = snapped;
    const seg = prev ? await getRoadSegment(prev.lat, prev.lng, lat, lng) : null;
    draftStops.push({
      name: address || `Location ${draftStops.length + 1}`,
      lat, lng, address,
      roadDistFromPrev: seg ? seg.distKm : 0,
      roadPathFromPrev: seg ? seg.coords : [],
    });
    refreshDraftMap();
    renderDraftStopsList();
    updateFareSummary();
  } finally {
    isSnapping = false;
    setBuilderInstruction('Click map to add stops');
    map.getCanvas().style.cursor = 'crosshair';
  }
}

async function closeLoop() {
  if (draftStops.length < 2) return;
  const first = draftStops[0];
  const last = draftStops[draftStops.length - 1];
  if (Math.abs(first.lat - last.lat) < 0.00001 && Math.abs(first.lng - last.lng) < 0.00001) return;

  setBuilderInstruction('Closing loop…', true);
  map.getCanvas().style.cursor = 'wait';
  try {
    const seg = await getRoadSegment(last.lat, last.lng, first.lat, first.lng);
    draftStops.push({
      name: first.name, lat: first.lat, lng: first.lng, address: first.address,
      roadDistFromPrev: seg.distKm, roadPathFromPrev: seg.coords
    });
  } catch {
    draftStops.push({
      name: first.name, lat: first.lat, lng: first.lng, address: first.address,
      roadDistFromPrev: haversine(last.lat, last.lng, first.lat, first.lng),
      roadPathFromPrev: [[last.lng, last.lat], [first.lng, first.lat]]
    });
  } finally {
    setBuilderInstruction('Click map to add stops');
    map.getCanvas().style.cursor = 'crosshair';
  }
  refreshDraftMap();
  renderDraftStopsList();
  updateFareSummary();
}

async function removeDraftStop(idx) {
  draftStops.splice(idx, 1);

  // Reconnect: re-route from new prev to new curr (the stop that shifted into position idx)
  if (idx < draftStops.length) {
    if (idx === 0) {
      draftStops[0].roadDistFromPrev = 0;
      draftStops[0].roadPathFromPrev = [];
    } else {
      const prev = draftStops[idx - 1];
      const curr = draftStops[idx];
      setBuilderInstruction('Re-routing…', true);
      try {
        const seg = await getRoadSegment(prev.lat, prev.lng, curr.lat, curr.lng);
        curr.roadDistFromPrev = seg.distKm;
        curr.roadPathFromPrev = seg.coords;
      } catch {
        curr.roadDistFromPrev = haversine(prev.lat, prev.lng, curr.lat, curr.lng);
        curr.roadPathFromPrev = [[prev.lng, prev.lat], [curr.lng, curr.lat]];
      }
      setBuilderInstruction('Click map to add stops');
    }
  }

  refreshDraftMap();
  renderDraftStopsList();
  updateFareSummary();
}

// ── Draft Map Layers ──────────────────────────────
function clearDraftLayers() {
  _draftMarkers.forEach(m => m.remove());
  _draftMarkers = [];
  _draftDelBtns = [];
  _draftDragIdx = -1;
  if (_draftOnDown) { try { map.off('mousedown', 'draft-stops-lyr', _draftOnDown); } catch { } _draftOnDown = null; }
  if (_draftOnEnter) { try { map.off('mouseenter', 'draft-stops-lyr', _draftOnEnter); } catch { } _draftOnEnter = null; }
  if (_draftOnLeave) { try { map.off('mouseleave', 'draft-stops-lyr', _draftOnLeave); } catch { } _draftOnLeave = null; }
  if (_draftOnMove) { map.off('mousemove', _draftOnMove); _draftOnMove = null; }
  if (_draftOnUp) { map.off('mouseup', _draftOnUp); _draftOnUp = null; }
  ['draft-stops-lyr', 'draft-arrows-lyr', 'draft-line-lyr', 'draft-glow-lyr'].forEach(id => { try { map.removeLayer(id); } catch { } });
  ['draft-stops-src', 'draft-line-src'].forEach(id => { try { map.removeSource(id); } catch { } });
  try { if (map.hasImage('draft-arrow-img')) map.removeImage('draft-arrow-img'); } catch { }
}

function buildDraftLineCoords() {
  if (draftStops.length === 0) return [];
  const coords = [[draftStops[0].lng, draftStops[0].lat]];
  for (let i = 1; i < draftStops.length; i++) {
    const path = draftStops[i].roadPathFromPrev;
    if (path?.length > 1) coords.push(...path.slice(1));
    else coords.push([draftStops[i].lng, draftStops[i].lat]);
  }
  return coords;
}

function _buildDraftStopsGeoJSON(overrideIdx, overrideLngLat) {
  const lastIdx = draftStops.length - 1;
  return {
    type: 'FeatureCollection',
    features: draftStops.map((s, i) => ({
      type: 'Feature',
      properties: { idx: i, isEnd: i === 0 || i === lastIdx },
      geometry: {
        type: 'Point',
        coordinates: (i === overrideIdx && overrideLngLat)
          ? [overrideLngLat.lng, overrideLngLat.lat]
          : [s.lng, s.lat]
      }
    }))
  };
}

function _buildDragLinePreview(dragIdx, ll) {
  const tmp = [];
  for (let i = 0; i < draftStops.length; i++) {
    if (i === 0) {
      tmp.push(i === dragIdx ? [ll.lng, ll.lat] : [draftStops[0].lng, draftStops[0].lat]);
    } else if (i === dragIdx) {
      tmp.push([ll.lng, ll.lat]);
    } else if (i === dragIdx + 1) {
      tmp.push([draftStops[i].lng, draftStops[i].lat]);
    } else {
      const path = draftStops[i].roadPathFromPrev;
      if (path?.length > 1) tmp.push(...path.slice(1));
      else tmp.push([draftStops[i].lng, draftStops[i].lat]);
    }
  }
  return tmp;
}

function _renderDraftStopMarkers() {
  // Transparent DOM markers — only used to anchor the hover-delete button.
  // Visual circles come from draft-stops-lyr (canvas), so they stay locked
  // to geographic position during map pan/zoom with no DOM-element lag.
  _draftDelBtns = [];
  const lastIdx = draftStops.length - 1;
  draftStops.forEach((s, idx) => {
    const isEnd = idx === 0 || idx === lastIdx;
    const size = isEnd ? 18 : 14;

    const el = document.createElement('div');
    el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;position:relative;pointer-events:none;`;

    const delBtn = document.createElement('div');
    delBtn.style.cssText = `position:absolute;top:-7px;right:-7px;width:14px;height:14px;background:#ef4444;color:#fff;border-radius:50%;font-size:10px;font-weight:bold;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;transition:opacity 0.15s;user-select:none;pointer-events:auto;`;
    delBtn.textContent = '×';
    el.appendChild(delBtn);
    delBtn.addEventListener('click', e => { e.stopPropagation(); removeDraftStop(idx); });
    delBtn.addEventListener('mouseleave', () => { delBtn.style.opacity = '0'; });

    _draftDelBtns.push({ idx, delBtn });

    const marker = new maplibregl.Marker({ element: el, draggable: false, anchor: 'center' })
      .setLngLat([s.lng, s.lat]).addTo(map);
    _draftMarkers.push(marker);
  });
}

function refreshDraftMap() {
  clearDraftLayers();
  if (draftStops.length === 0) return;

  const color = document.getElementById('route-color-input').value || '#0046C7';

  // ── Canvas circle layer for stops (stays locked to geo during pan/zoom) ──
  map.addSource('draft-stops-src', { type: 'geojson', data: _buildDraftStopsGeoJSON() });
  map.addLayer({
    id: 'draft-stops-lyr', type: 'circle', source: 'draft-stops-src',
    paint: {
      'circle-radius': ['case', ['get', 'isEnd'], 6.5, 5],
      'circle-color': color,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    }
  });

  if (draftStops.length >= 2) {
    const lineCoords = buildDraftLineCoords();
    map.addSource('draft-line-src', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords } }
    });
    map.addLayer({
      id: 'draft-glow-lyr', type: 'line', source: 'draft-line-src',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': 14, 'line-opacity': 0.14, 'line-blur': 7 }
    }, 'draft-stops-lyr');
    map.addLayer({
      id: 'draft-line-lyr', type: 'line', source: 'draft-line-src',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': 4, 'line-opacity': 0.9 }
    }, 'draft-stops-lyr');
    map.addImage('draft-arrow-img', makeArrowImage(color));
    map.addLayer({
      id: 'draft-arrows-lyr', type: 'symbol', source: 'draft-line-src',
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 90,
        'icon-image': 'draft-arrow-img',
        'icon-size': 0.7,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      }
    }, 'draft-stops-lyr');
  }

  // ── Transparent DOM markers (delete-button holders only) ────────────────
  _renderDraftStopMarkers();

  // ── Map-event drag for stops ─────────────────────────────────────────────
  _draftOnEnter = (e) => {
    if (isSnapping) return;
    map.getCanvas().style.cursor = 'grab';
    const hovIdx = e.features[0].properties.idx;
    _draftDelBtns.forEach(({ idx, delBtn }) => {
      delBtn.style.opacity = idx === hovIdx ? '1' : '0';
    });
  };
  _draftOnLeave = () => {
    if (_draftDragIdx === -1) map.getCanvas().style.cursor = builderOpen ? 'crosshair' : '';
    _draftDelBtns.forEach(({ delBtn }) => {
      if (!delBtn.matches(':hover')) delBtn.style.opacity = '0';
    });
  };
  _draftOnDown = (e) => {
    if (isSnapping) return;
    e.preventDefault();
    _draftDragIdx = e.features[0].properties.idx;
    isSnapping = true;
    map.getCanvas().style.cursor = 'grabbing';
    map.dragPan.disable();

    _draftOnMove = (evt) => {
      if (_draftDragIdx < 0) return;
      const ll = evt.lngLat;
      const stopsSrc = map.getSource('draft-stops-src');
      if (stopsSrc) stopsSrc.setData(_buildDraftStopsGeoJSON(_draftDragIdx, ll));
      const lineSrc = map.getSource('draft-line-src');
      if (lineSrc) lineSrc.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: _buildDragLinePreview(_draftDragIdx, ll) } });
      // Keep DOM marker in sync so delete button tracks correctly
      const dm = _draftMarkers[_draftDragIdx];
      if (dm) dm.setLngLat([ll.lng, ll.lat]);
    };

    _draftOnUp = async (evt) => {
      if (_draftDragIdx < 0) return;
      map.off('mousemove', _draftOnMove);
      map.off('mouseup', _draftOnUp);
      _draftOnMove = null;
      _draftOnUp = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = 'crosshair';

      const idx = _draftDragIdx;
      _draftDragIdx = -1;
      const ll = evt.lngLat;

      // Plain click (no movement) — don't re-route, just unblock
      if (haversine(ll.lat, ll.lng, draftStops[idx].lat, draftStops[idx].lng) < 0.003) {
        isSnapping = false;
        setBuilderInstruction('Click map to add stops');
        return;
      }

      setBuilderInstruction('Snapping to road…', true);
      map.getCanvas().style.cursor = 'wait';
      try {
        const snapped = await snapToRoad(ll.lat, ll.lng);
        draftStops[idx].lat = snapped.lat;
        draftStops[idx].lng = snapped.lng;
        const dm = _draftMarkers[idx];
        if (dm) dm.setLngLat([snapped.lng, snapped.lat]);

        setBuilderInstruction('Re-routing…', true);
        const [prevSeg, nextSeg] = await Promise.all([
          idx > 0 ? getRoadSegment(draftStops[idx - 1].lat, draftStops[idx - 1].lng, snapped.lat, snapped.lng) : Promise.resolve(null),
          idx < draftStops.length - 1 ? getRoadSegment(snapped.lat, snapped.lng, draftStops[idx + 1].lat, draftStops[idx + 1].lng) : Promise.resolve(null),
        ]);
        if (prevSeg) { draftStops[idx].roadDistFromPrev = prevSeg.distKm; draftStops[idx].roadPathFromPrev = prevSeg.coords; }
        if (nextSeg) { draftStops[idx + 1].roadDistFromPrev = nextSeg.distKm; draftStops[idx + 1].roadPathFromPrev = nextSeg.coords; }
        getAddressFromCoords(snapped.lat, snapped.lng).then(addr => {
          if (addr) { draftStops[idx].address = addr; draftStops[idx].name = addr; }
          renderDraftStopsList();
        });
      } finally {
        isSnapping = false;
        refreshDraftMap();
        renderDraftStopsList();
        updateFareSummary();
        setBuilderInstruction('Click map to add stops');
        map.getCanvas().style.cursor = 'crosshair';
      }
    };

    map.on('mousemove', _draftOnMove);
    map.on('mouseup', _draftOnUp);
  };

  map.on('mousedown', 'draft-stops-lyr', _draftOnDown);
  map.on('mouseenter', 'draft-stops-lyr', _draftOnEnter);
  map.on('mouseleave', 'draft-stops-lyr', _draftOnLeave);
}

// ── Draft Stops List ──────────────────────────────
function renderDraftStopsList() {
  const list = document.getElementById('stops-list');
  document.getElementById('stop-count-badge').textContent =
    `${draftStops.length} stop${draftStops.length !== 1 ? 's' : ''}`;

  const loopBtn = document.getElementById('btn-close-loop');
  if (loopBtn) {
    const n = draftStops.length;
    const alreadyClosed = n >= 2 &&
      Math.abs(draftStops[0].lat - draftStops[n - 1].lat) < 0.00001 &&
      Math.abs(draftStops[0].lng - draftStops[n - 1].lng) < 0.00001;
    loopBtn.disabled = n < 2 || alreadyClosed;
    loopBtn.title = alreadyClosed ? 'Loop already closed' : 'Route back to first stop';
  }

  if (draftStops.length === 0) {
    list.innerHTML = '<div class="stops-empty">Click anywhere on the map to place the first stop.</div>';
    return;
  }

  list.innerHTML = draftStops.map((s, i) => {
    const distStr = i === 0 ? 'Start' : `+${s.roadDistFromPrev.toFixed(2)} km (road)`;
    const coordsStr = `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`;
    const addressForName = s.address || `Location ${i + 1}`;
    const nearby = getNearbyLandmarks(s.lat, s.lng, 70, 2);
    const nearbyHtml = nearby.map(l =>
      `<span class="stop-row-landmark">${LANDMARK_ICONS[l.category] || '📍'} ${escHtml(l.name)} <em>${l.distM}m</em></span>`
    ).join('');
    return `<div class="stop-row" data-idx="${i}">
      <div class="stop-row-num">${i + 1}</div>
      <div class="stop-row-info">
        <input class="stop-row-name" value="${escHtml(addressForName)}" data-idx="${i}" placeholder="Location name">
        <div class="stop-row-address">${escHtml(s.address || 'Resolving address...')}</div>
        <div class="stop-row-coords">${coordsStr}</div>
        <div class="stop-row-dist">${distStr}</div>
        ${nearbyHtml ? `<div class="stop-row-nearby">${nearbyHtml}</div>` : ''}
      </div>
      <button class="stop-row-del" data-del="${i}" title="Remove">✕</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.stop-row-name').forEach(inp => {
    inp.addEventListener('change', e => {
      draftStops[+e.target.dataset.idx].name = e.target.value;
    });
    inp.addEventListener('click', e => e.stopPropagation());
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      await removeDraftStop(+btn.dataset.del);
    });
  });
  list.querySelectorAll('.stop-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.classList.contains('stop-row-name') || e.target.hasAttribute('data-del')) return;
      const i = +row.dataset.idx;
      map.flyTo({ center: [draftStops[i].lng, draftStops[i].lat], zoom: 16, duration: 700 });
    });
  });
}

// ── Fare Summary ──────────────────────────────────
function updateFareSummary() {
  if (draftStops.length < 2) {
    document.getElementById('summary-distance').textContent = '—';
    document.getElementById('summary-fare').textContent = '—';
    document.getElementById('fare-table-body').innerHTML = '';
    return;
  }

  const vt = document.getElementById('route-vehicle-input')?.value || 'puj';
  const rates = getFareRates(vt);
  let cumKm = 0;
  const rows = draftStops.map((s, i) => {
    cumKm += s.roadDistFromPrev || 0;
    return { name: s.name, legKm: s.roadDistFromPrev || 0, cumKm, fare: calcFare(cumKm, vt) };
  });

  document.getElementById('summary-distance').textContent = `${cumKm.toFixed(2)} km`;
  document.getElementById('summary-fare').textContent =
    `₱${rates.base.toFixed(2)} – ₱${calcFare(cumKm, vt).toFixed(2)}`;

  document.getElementById('fare-table-body').innerHTML = rows.map((r, i) => `
    <tr>
      <td>${r.name}</td>
      <td>${i === 0 ? '—' : r.legKm.toFixed(2)}</td>
      <td>${r.cumKm.toFixed(2)}</td>
      <td>₱${r.fare.toFixed(2)}</td>
    </tr>`).join('');
}

// ── Save Route ────────────────────────────────────
async function saveRoute() {
  const name = document.getElementById('route-name-input').value.trim();
  if (!name) { alert('Please enter a route name.'); return; }
  if (draftStops.length < 2) { alert('Please add at least 2 stops.'); return; }

  const btn = document.getElementById('btn-save-route');
  btn.disabled = true; btn.textContent = 'Saving…';

  const routeObj = {
    id: editingRouteId || `route-${Date.now()}`,
    name,
    color: document.getElementById('route-color-input').value,
    hours: document.getElementById('route-hours-input').value,
    frequency: document.getElementById('route-freq-input').value,
    description: document.getElementById('route-desc-input').value.trim(),
    vehicle_type: document.getElementById('route-vehicle-input').value,
    stops: draftStops.map(s => ({ ...s })),
    status: isAdmin() ? 'approved' : 'pending',
  };

  if (_supabase) {
    const { error } = await _supabase.from('routes').upsert(routeObj, { onConflict: 'id' });
    if (error) { console.error('Route save error:', error); alert('Failed to save route: ' + error.message); btn.disabled = false; btn.textContent = isAdmin() ? 'Save Route' : 'Submit'; return; }
  }

  const isNew = !editingRouteId;
  btn.disabled = false;

  if (!isAdmin()) {
    btn.textContent = '✓ Submitted for approval';
    setTimeout(() => { btn.textContent = 'Submit'; }, 2500);
    closeBuilder();
    return;
  }

  if (editingRouteId) {
    routes[routes.findIndex(r => r.id === editingRouteId)] = routeObj;
  } else {
    routes.push(routeObj);
  }

  btn.textContent = 'Save Route';
  saveRoutes();
  closeBuilder();
  renderAllRoutesOnMap();
  renderRouteList();
  updateRouteCount();
  showRouteDetail(routeObj.id);
  if (isNew) showQrModal(routeObj.id);
}

// ── Edit / Delete ─────────────────────────────────
function startEdit(routeId) { hideRouteDetail(); openBuilder(routeId); }

let _pendingDeleteFn = null;

function _openDeleteModal(title, msg, fn) {
  _pendingDeleteFn = fn;
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function _closeDeleteModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  _pendingDeleteFn = null;
}

function confirmDelete(routeId) {
  const route = routes.find(r => r.id === routeId);
  _openDeleteModal(
    'Delete Route?',
    `This will permanently remove "${route?.name || 'this route'}" and all its stops.`,
    async () => {
      if (_supabase) {
        const { error } = await _supabase.from('routes').delete().eq('id', routeId);
        if (error) { console.error('Route delete error:', error); alert('Failed to delete route: ' + error.message); return; }
      }
      removeRouteFromMap(routeId);
      routes = routes.filter(r => r.id !== routeId);
      saveRoutes();
      hideRouteDetail();
      renderRouteList();
      updateRouteCount();
      _closeDeleteModal();
    }
  );
}

async function doDelete() {
  if (!_pendingDeleteFn) return;
  await _pendingDeleteFn();
}

// ── Route Simulation ──────────────────────────────
let simActive = false;
let simPaused = false;
let simRouteId = null;
let simCoords = [];
let simCumDist = [];
let simTotalKm = 0;
let simProgress = 0;
let simSpeed = 120;
let simMarker = null;
let simAnimFrame = null;
let simLastTs = null;
let simStopIdxs = [];
let simCurrentBearing = 0;
const SIM_SPEEDS = [40, 80, 120, 200, 400, 800];

// Flip the jeepney image when heading leftward on screen
function _updateSimMirror() {
  if (!simMarker) return;
  const screenBearing = (simCurrentBearing - map.getBearing() + 360) % 360;
  const img = simMarker.getElement()?.querySelector('.sim-jeep-img');
  if (img) img.style.transform = screenBearing > 180 ? 'scaleX(-1)' : 'none';
}

function _bearingBetween([lng1, lat1], [lng2, lat2]) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function _posAtProgress(prog) {
  const n = simCoords.length;
  if (prog <= 0) return {
    lngLat: simCoords[0],
    bearing: n > 1 ? _bearingBetween(simCoords[0], simCoords[1]) : 0
  };
  if (prog >= simTotalKm) return {
    lngLat: simCoords[n - 1],
    bearing: n > 1 ? _bearingBetween(simCoords[n - 2], simCoords[n - 1]) : 0
  };
  let lo = 0, hi = simCumDist.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; simCumDist[mid] <= prog ? lo = mid : hi = mid; }
  const t = (prog - simCumDist[lo]) / (simCumDist[hi] - simCumDist[lo]);
  const a = simCoords[lo], b = simCoords[hi];
  return {
    lngLat: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    bearing: _bearingBetween(a, b)
  };
}


function _simNextStopName() {
  const route = routes.find(r => r.id === simRouteId);
  for (let i = 0; i < simStopIdxs.length; i++) {
    if (simCumDist[simStopIdxs[i]] > simProgress + 0.001)
      return route?.stops[i]?.name || `Stop ${i + 1}`;
  }
  return 'End of route';
}

function _simTick(ts) {
  if (!simActive || simPaused) { simAnimFrame = null; return; }
  if (simLastTs !== null) {
    const dt = Math.min((ts - simLastTs) / 1000, 0.2);
    simProgress += (simSpeed / 3600) * dt;
    if (simProgress >= simTotalKm) { simProgress = simTotalKm; _simFinish(); return; }
  }
  simLastTs = ts;
  const { lngLat, bearing } = _posAtProgress(simProgress);
  simCurrentBearing = bearing;
  simMarker.setLngLat(lngLat);
  _updateSimMirror();
  if (document.getElementById('sim-follow')?.checked) map.easeTo({ center: lngLat, duration: 80 });
  const pct = (simProgress / simTotalKm) * 100;
  document.getElementById('sim-progress-fill').style.width = pct + '%';
  document.getElementById('sim-progress-label').textContent = `${simProgress.toFixed(2)} / ${simTotalKm.toFixed(2)} km`;
  document.getElementById('sim-next-stop').textContent = _simNextStopName();
  simAnimFrame = requestAnimationFrame(_simTick);
}

function _simFinish() {
  simPaused = true;
  if (simAnimFrame) { cancelAnimationFrame(simAnimFrame); simAnimFrame = null; }
  document.getElementById('sim-play-pause').textContent = '↺ Restart';
  document.getElementById('sim-next-stop').textContent = 'End of route';
  setTimeout(() => { if (simPaused && simProgress >= simTotalKm) stopSimulation(); }, 2000);
}

function startSimulation(routeId) {
  stopSimulation();
  const route = routes.find(r => r.id === routeId);
  if (!route || route.stops.length < 2) { alert('Route needs at least 2 stops to simulate.'); return; }
  simRouteId = routeId; simActive = true; simPaused = false; simProgress = 0; simLastTs = null;
  simCoords = buildSavedRouteCoords(route);
  simCumDist = [0];
  for (let i = 1; i < simCoords.length; i++)
    simCumDist.push(simCumDist[i - 1] + haversine(simCoords[i - 1][1], simCoords[i - 1][0], simCoords[i][1], simCoords[i][0]));
  simTotalKm = simCumDist[simCumDist.length - 1];
  // Map stops to coord indices
  simStopIdxs = [0]; let cc = 1;
  for (let i = 1; i < route.stops.length; i++) {
    const p = route.stops[i].roadPathFromPrev;
    cc += p?.length > 1 ? p.length - 1 : 1;
    simStopIdxs.push(cc - 1);
  }
  // Marker
  const el = document.createElement('div');
  el.className = 'sim-marker';
  el.innerHTML = `<img src="assets/jeep.png" class="sim-jeep-img" draggable="false">`;
  simCurrentBearing = _posAtProgress(0).bearing;
  simMarker = new maplibregl.Marker({
    element: el,
    anchor: 'center',
    pitchAlignment: 'viewport',  // stays flat on screen, never tilts with pitch
  }).setLngLat(simCoords[0]).addTo(map);
  _updateSimMirror();
  map.on('rotate', _updateSimMirror);
  // Panel
  document.getElementById('sim-dot').style.background = route.color;
  document.getElementById('sim-name').textContent = route.name;
  document.getElementById('sim-vtag').innerHTML = route.vehicle_type ? vehicleTag(route.vehicle_type) : '';
  document.getElementById('sim-speed-label').textContent = simSpeed + ' km/h';
  document.getElementById('sim-play-pause').textContent = '⏸';
  document.getElementById('sim-progress-fill').style.width = '0%';
  document.getElementById('sim-progress-label').textContent = `0.00 / ${simTotalKm.toFixed(2)} km`;
  document.getElementById('sim-next-stop').textContent = route.stops[1]?.name || 'Stop 2';
  document.getElementById('sim-panel').classList.remove('hidden');
  document.getElementById('route-detail').classList.remove('visible'); // hide detail panel during sim
  if (DEVICE_CONFIG.isMobile()) {
    document.getElementById('sidebar').classList.add('collapsed');
    document.getElementById('sidebar-toggle').classList.add('visible');
  }
  hideOtherRoutes(routeId);
  map.flyTo({ center: simCoords[0], zoom: 15.5, duration: 800 });
  simAnimFrame = requestAnimationFrame(_simTick);
}

function stopSimulation() {
  simActive = false; simPaused = false;
  map.off('rotate', _updateSimMirror);
  if (simAnimFrame) { cancelAnimationFrame(simAnimFrame); simAnimFrame = null; }
  if (simMarker) { simMarker.remove(); simMarker = null; }
  document.getElementById('sim-panel')?.classList.add('hidden');
  simCoords = []; simCumDist = []; simTotalKm = 0; simProgress = 0; simLastTs = null;
  if (simRouteId) showRouteDetail(simRouteId); // restore detail panel (keeps other routes hidden)
  simRouteId = null;
}

function _simTogglePause() {
  if (!simActive) return;
  if (simProgress >= simTotalKm) { simProgress = 0; simLastTs = null; simPaused = false; }
  else simPaused = !simPaused;
  document.getElementById('sim-play-pause').textContent = simPaused ? '▶' : '⏸';
  if (!simPaused) { simLastTs = null; simAnimFrame = requestAnimationFrame(_simTick); }
}

function _simChangeSpeed(dir) {
  const idx = SIM_SPEEDS.indexOf(simSpeed);
  simSpeed = SIM_SPEEDS[Math.max(0, Math.min(SIM_SPEEDS.length - 1, idx + dir))];
  document.getElementById('sim-speed-label').textContent = simSpeed + ' km/h';
}

// ── Sync all routes to Supabase ───────────────────
async function syncRoutesToDB() {
  if (!_supabase) { alert('Supabase is not configured.'); return; }
  if (!routes.length) { alert('No routes to sync.'); return; }
  const btn = document.getElementById('btn-sync-db');
  btn.disabled = true; btn.textContent = '☁ Syncing…';
  const { error } = await _supabase.from('routes').upsert(routes, { onConflict: 'id' });
  btn.disabled = false; btn.textContent = '☁ Sync to DB';
  if (error) { console.error('Sync error:', error); alert('Sync failed: ' + error.message); return; }
  alert(`${routes.length} route${routes.length !== 1 ? 's' : ''} synced to database.`);
}

// ── Export ────────────────────────────────────────
function exportRoutes() {
  const json = JSON.stringify(routes, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `esuyo_routes_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

// ── Map Controls ──────────────────────────────────
const STYLE_CARTO = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const STYLE_LIBERTY = 'https://tiles.openfreemap.org/styles/liberty';
let currentMapStyle = STYLE_CARTO;

function hideNonRoadLabels() {
  // Prefix pattern for our custom layers — never touch these
  const OUR_LAYERS = /^(landmarks|brgy|green-cover|landuse-cover|hillshade|sky-layer|line-|glow-|arrows-|reverse-arrows-|terminal-|stops-|draft-)/;
  map.getStyle().layers.forEach(layer => {
    if (layer.type !== 'symbol') return;
    if (OUR_LAYERS.test(layer.id)) return;
    const srcLayer = layer['source-layer'] || '';
    // Keep only road/street name labels (transportation_name source layer in OpenMapTiles-based styles)
    if (srcLayer === 'transportation_name' || layer.id.includes('road') || layer.id.includes('street') || layer.id.includes('highway')) return;
    try { map.setLayoutProperty(layer.id, 'visibility', 'none'); } catch { }
  });
}

function applyCartoGreen() {
  map.getStyle().layers.forEach(layer => {
    if (layer.type !== 'fill') return;
    const src = layer['source-layer'] || '';
    const id = layer.id;
    const isGreen = src === 'park' ||
      id.includes('park') || id.includes('grass') || id.includes('wood') ||
      id.includes('scrub') || id.includes('forest') || id.includes('garden') ||
      id.includes('green') || id.includes('meadow') || id.includes('landcover');
    if (isGreen) {
      try { map.setPaintProperty(id, 'fill-color', '#81B97A'); } catch { }
      try { map.setPaintProperty(id, 'fill-opacity', 0.5); } catch { }
    }
  });
  hideNonRoadLabels();
}

function applyWhiteTheme() {
  const layers = map.getStyle().layers;
  // Hide Liberty's built-in POI/place layers so only our custom landmarks show
  layers.forEach(layer => {
    const src = layer['source-layer'] || '';
    if (src === 'poi' || layer.id.startsWith('poi') || layer.id.startsWith('place-')) {
      try { map.setLayoutProperty(layer.id, 'visibility', 'none'); } catch { }
    }
  });
  layers.forEach(layer => {
    const id = layer.id;
    const src = layer['source-layer'] || '';

    // Background / ground — match CARTO Positron
    if (layer.type === 'background') {
      try { map.setPaintProperty(id, 'background-color', '#f9f9f8'); } catch { }
      return;
    }

    // Water — ocean, sea, lakes, rivers
    if (src === 'water' || src === 'waterway' ||
      id.includes('water') || id.includes('ocean') || id.includes('sea') || id.includes('lake') || id.includes('river')) {
      if (layer.type === 'fill') {
        try { map.setPaintProperty(id, 'fill-color', '#c8cdd1'); } catch { }
      } else if (layer.type === 'line') {
        try { map.setPaintProperty(id, 'line-color', '#b0b8be'); } catch { }
      }
      return;
    }

    // Roads — white surface, visible gray casing for depth
    if (src === 'transportation' && layer.type === 'line') {
      const isCasing = id.includes('casing') || id.includes('case') || id.includes('outline') || id.includes('border');
      try { map.setPaintProperty(id, 'line-color', isCasing ? '#b8b8b8' : '#ffffff'); } catch { }
      return;
    }

    // Greens — parks, forests, landcover vegetation
    if (src === 'landuse' || src === 'landcover' || src === 'landuse_overlay') {
      const isGreen = id.includes('park') || id.includes('grass') || id.includes('wood') ||
        id.includes('forest') || id.includes('scrub') || id.includes('garden') ||
        id.includes('national') || id.includes('meadow') || id.includes('green');
      if (isGreen) {
        try { map.setPaintProperty(id, 'fill-color', '#7ec87e'); } catch { }
      } else {
        try { map.setPaintProperty(id, 'fill-color', '#f9f9f8'); } catch { }
      }
      return;
    }

    // General land / earth — match ground color
    if (src === 'landuse' || id.includes('residential') || id.includes('land')) {
      try { map.setPaintProperty(id, 'fill-color', '#f9f9f8'); } catch { }
    }

    // Building footprints — match CARTO Positron (sides #dfdfdf, tops #ededed)
    if (src === 'building' && layer.type === 'fill') {
      const isTop = id.includes('top') || id.includes('roof');
      try { map.setPaintProperty(id, 'fill-color', isTop ? '#ededed' : '#dfdfdf'); } catch { }
      try { map.setPaintProperty(id, 'fill-outline-color', '#cccccc'); } catch { }
    }
  });
  hideNonRoadLabels();
}

function toggleMapStyle() {
  currentMapStyle = currentMapStyle === STYLE_CARTO ? STYLE_LIBERTY : STYLE_CARTO;

  // Clear stale layer/source tracking so renderAllRoutesOnMap re-adds cleanly
  routeLayers = {};
  routeSources = {};
  _shaderLayerReady = false;

  map.setStyle(currentMapStyle, { diff: false });

  const _reinitLayers = () => {
    try { addTerrain(); } catch (e) { console.warn('addTerrain:', e); }
    try { addBarangayLayers(); } catch (e) { console.warn('addBarangayLayers:', e); }
    try { add3DBuildings(); } catch (e) { console.warn('add3DBuildings:', e); }
    try { addGreenery(); } catch (e) { console.warn('addGreenery:', e); }

    // Force-clear landmarks and re-add (setStyle wipes them, but be explicit)
    ['landmarks-label', 'landmarks-icon', 'landmarks-circle'].forEach(id => {
      try { if (map.getLayer(id)) map.removeLayer(id); } catch { }
    });
    try { if (map.getSource('landmarks')) map.removeSource('landmarks'); } catch { }
    try { addLandmarks(); } catch (e) { console.error('addLandmarks:', e); }
    try { initLandmarkEvents(); } catch (e) { console.warn('initLandmarkEvents:', e); }
    try { fetchLandmarksFromDB(); } catch (e) { console.warn('fetchLandmarksFromDB:', e); }

    try { renderAllRoutesOnMap(); } catch (e) { console.warn('renderAllRoutesOnMap:', e); }
    if (!is3D) {
      _building3DLayerIds.forEach(id => {
        try { map.setLayoutProperty(id, 'visibility', 'none'); } catch { }
      });
    }
    try {
      if (!_shaderOn && map.getLayer('terrain-hillshade')) map.setLayoutProperty('terrain-hillshade', 'visibility', 'none');
    } catch { }
    if (currentMapStyle === STYLE_LIBERTY) {
      try { applyWhiteTheme(); } catch (e) { console.warn('applyWhiteTheme:', e); }
    }
    if (currentMapStyle === STYLE_CARTO) {
      try { applyCartoGreen(); } catch (e) { console.warn('applyCartoGreen:', e); }
    }
  };

  map.once('style.load', () => {
    // Small delay lets the base style's glyph/sprite requests start before we
    // pile on custom layers — avoids a race that can silently skip addLayer.
    setTimeout(_reinitLayers, 150);
  });

}

let is3DTerrain = false;
function toggle3DTerrain() {
  is3DTerrain = !is3DTerrain;
  if (is3DTerrain) {
    try { map.setTerrain({ source: 'terrain-dem', exaggeration: 0.6 }); } catch { }
    map.easeTo({ pitch: INITIAL_PITCH, duration: 600 });
  } else {
    try { map.setTerrain(null); } catch { }
    map.easeTo({ pitch: 0, duration: 600 });
  }
  _mswSetToggle('toggle-3d-terrain', is3DTerrain);
}

let is3D = false;
function toggle3D() {
  is3D = !is3D;
  const vis = is3D ? 'visible' : 'none';
  _building3DLayerIds.forEach(id => {
    try { map.setLayoutProperty(id, 'visibility', vis); } catch { }
  });
  _mswSetToggle('toggle-3d-buildings', is3D);
}

let _shaderOn = false;
let _shaderLayerReady = false;

function _ensureShaderLayer() {
  if (!_shaderLayerReady) {
    try {
      if (!_demProtocolRegistered) {
        _demProtocolRegistered = true;
        maplibregl.addProtocol('dem-filtered', async (params, abortController) => {
          const tileUrl = params.url.replace('dem-filtered://', 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/');
          try {
            const response = await fetch(tileUrl, { signal: abortController.signal });
            if (!response.ok) throw new Error(`${response.status}`);
            return { data: await response.arrayBuffer() };
          } catch {
            const flat = document.createElement('canvas'); flat.width = 256; flat.height = 256;
            const fc = flat.getContext('2d');
            fc.fillStyle = 'rgb(128,0,0)'; fc.fillRect(0, 0, 256, 256);
            return { data: await new Promise(r => flat.toBlob(r, 'image/png')).then(b => b.arrayBuffer()) };
          }
        });
      }
      if (!map.getSource('terrain-dem-hs')) {
        map.addSource('terrain-dem-hs', {
          type: 'raster-dem',
          tiles: ['dem-filtered://{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14,
        });
      }
      if (!map.getLayer('terrain-hillshade')) {
        const firstSymbol = map.getStyle()?.layers?.find(l => l.type === 'symbol');
        map.addLayer({
          id: 'terrain-hillshade',
          type: 'hillshade',
          source: 'terrain-dem-hs',
          layout: { visibility: 'visible' },
          paint: {
            'hillshade-exaggeration': 0.3,
            'hillshade-shadow-color': '#8a9bb0',
            'hillshade-highlight-color': '#ffffff',
            'hillshade-accent-color': '#b0bec5',
            'hillshade-illumination-direction': 315,
            'hillshade-illumination-anchor': 'map'
          }
        }, firstSymbol?.id);
      }
      _shaderLayerReady = true;
    } catch (e) { console.warn('_ensureShaderLayer:', e); }
  }
  // Whether first time or re-enable: always make the layer visible
  if (_shaderLayerReady) {
    try { map.setLayoutProperty('terrain-hillshade', 'visibility', 'visible'); } catch { }
  }
}

function toggleShader() {
  _shaderOn = !_shaderOn;
  _mswSetToggle('toggle-shader', _shaderOn);
  if (_shaderOn) {
    _ensureShaderLayer();
  } else {
    try { map.setLayoutProperty('terrain-hillshade', 'visibility', 'none'); } catch { }
  }
}

// ── Ride Mode ─────────────────────────────────────
function _rideMarker(label, color) {
  const el = document.createElement('div');
  el.className = 'ride-map-marker';
  el.style.background = color;
  el.innerHTML = `<span>${label}</span>`;
  return el;
}

function _fmtTravelTime(distKm) {
  const mins = Math.round(distKm / 20 * 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function _updateRideStep() {
  const msgs = [
    '📍 Tap your pickup point on the map',
    '🏁 Now tap your drop-off point',
    '✓ Fare calculated · Drag A or B to adjust'
  ];
  document.getElementById('ride-step-indicator').textContent = msgs[_rideStep] || '';
}

function _setRideAddress(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

let _rideRouteCoords = []; // Full route path for slider
let _rideStartIdx = 0; // Pickup index on route

async function _placeRideMarker(lat, lng, type) {
  const isPickup = type === 'pickup';

  let finalLat = lat, finalLng = lng, snapped = false, snapIdx = -1;
  if (activeRouteId) {
    const route = routes.find(r => r.id === activeRouteId);
    if (route) {
      const snap = findNearestOnRoute(route, lat, lng);
      finalLat = snap.lat; finalLng = snap.lng; snapped = true;
      snapIdx = findNearestVertex(route, snap.lat, snap.lng).idx;
    }
  }

  if (isPickup) {
    if (_ridePickupMarker) _ridePickupMarker.remove();
    _ridePickupMarker = new maplibregl.Marker({ element: _rideMarker('A', '#22c55e'), draggable: true, anchor: 'bottom-left' })
      .setLngLat([finalLng, finalLat]).addTo(map);
    _ridePickupCoords = { lat: finalLat, lng: finalLng, snapped, snapIdx };
    _setRideAddress('ride-pickup-addr', 'Locating…');
    if (snapped && activeRouteId) {
      const route = routes.find(r => r.id === activeRouteId);
      if (route) {
        _rideRouteCoords = buildSavedRouteCoords(route);
        _rideStartIdx = snapIdx;
      }
    }
    if (activeRouteId && _rideRouteCoords.length) {
      const r = routes.find(routeItem => routeItem.id === activeRouteId);
      _ridePickupMarker.on('drag', () => {
        if (!r || !_rideRouteCoords.length) return;
        const ll = _ridePickupMarker.getLngLat();
        const snap = findNearestOnRoute(r, ll.lat, ll.lng);
        const vIdx = findNearestVertex(r, snap.lat, snap.lng).idx;
        _ridePickupMarker.setLngLat([snap.lng, snap.lat]);
        _ridePickupCoords = { lat: snap.lat, lng: snap.lng, snapped: true, snapIdx: vIdx };
        _rideStartIdx = vIdx;
        _setRideAddress('ride-pickup-addr', `Stop ${vIdx + 1}`);
        if (_rideDropoffCoords) _drawRidePathAlongRoute();
      });
      _ridePickupMarker.on('dragend', async () => {
        const { lat, lng } = _ridePickupMarker.getLngLat();
        const address = await getAddressFromCoords(lat, lng);
        _setRideAddress('ride-pickup-addr', (address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`) + ' ✓');
      });
    }
  } else {
    if (_rideDropoffMarker) _rideDropoffMarker.remove();
    const marker = new maplibregl.Marker({ element: _rideMarker('B', '#ef4444'), draggable: true, anchor: 'bottom-left' })
      .setLngLat([finalLng, finalLat]).addTo(map);
    _rideDropoffMarker = marker;
    _rideDropoffCoords = { lat: finalLat, lng: finalLng, snapped, snapIdx };
    _setRideAddress('ride-dropoff-addr', 'Locating…');

    if (activeRouteId && _rideRouteCoords.length) {
      const r = routes.find(routeItem => routeItem.id === activeRouteId);
      marker.on('drag', () => {
        if (!_ridePickupMarker || !r || !_rideRouteCoords.length) return;
        const ll = marker.getLngLat();
        const snap = findNearestOnRoute(r, ll.lat, ll.lng);
        const vIdx2 = findNearestVertex(r, snap.lat, snap.lng).idx;
        marker.setLngLat([snap.lng, snap.lat]);
        _rideDropoffCoords = { lat: snap.lat, lng: snap.lng, snapped: true, snapIdx: vIdx2 };
        _setRideAddress('ride-dropoff-addr', `Stop ${vIdx2 + 1}`);
        _drawRidePathAlongRoute();
      });
    }
  }

  const address = await getAddressFromCoords(finalLat, finalLng);
  _setRideAddress(isPickup ? 'ride-pickup-addr' : 'ride-dropoff-addr',
    (address || `${finalLat.toFixed(5)}, ${finalLng.toFixed(5)}`) + (snapped ? ' ✓' : ''));
}

function _isLoopRoute(route) {
  if (route.stops.length < 2) return false;
  const first = route.stops[0], last = route.stops[route.stops.length - 1];
  return haversine(first.lat, first.lng, last.lat, last.lng) < 0.4;
}

function _buildRidePathCoords(allCoords, route, pickupIdx, dropoffIdx) {
  if (pickupIdx <= dropoffIdx) {
    return allCoords.slice(pickupIdx, dropoffIdx + 1);
  }
  // Pickup is after dropoff in route direction
  if (_isLoopRoute(route)) {
    // Loop: continue to end then wrap to beginning
    return [...allCoords.slice(pickupIdx), ...allCoords.slice(0, dropoffIdx + 1)];
  }
  // Non-loop: passenger is going backward — reverse the segment so line runs A→B
  return allCoords.slice(dropoffIdx, pickupIdx + 1).slice().reverse();
}

function _pathDistKm(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    d += haversine(lat1, lng1, lat2, lng2);
  }
  return d;
}

function _drawRidePathAlongRoute() {
  if (!_ridePickupCoords || !_rideDropoffCoords || !activeRouteId || !_rideRouteCoords.length) return;

  const route = routes.find(r => r.id === activeRouteId);
  if (!route) return;

  const allCoords = buildSavedRouteCoords(route);
  const p1Idx = _rideStartIdx;
  const p2Idx = _rideDropoffCoords.snapIdx || 0;

  const coords = _buildRidePathCoords(allCoords, route, p1Idx, p2Idx);
  const distKm = _pathDistKm(coords);
  _lastRideDistKm = distKm;
  document.getElementById('ride-dist-val').textContent = `${distKm.toFixed(2)} km`;
  document.getElementById('ride-time-val').textContent = _fmtTravelTime(distKm);

  const hasDiscount = document.getElementById('ride-discount-cb')?.checked || false;
  const rideVt = routes.find(r => r.id === activeRouteId)?.vehicle_type || 'puj';
  const fare = calcFare(distKm, rideVt);
  const finalFare = hasDiscount ? fare * 0.8 : fare;
  const fareDisplay = hasDiscount
    ? `₱${finalFare.toFixed(2)} <s style="opacity:0.5;font-size:0.7em">₱${fare.toFixed(2)}</s>`
    : `₱${fare.toFixed(2)}`;
  document.getElementById('ride-fare-val').innerHTML = fareDisplay;

  // Draw yellow path with enhanced visibility
  const geoLine = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
  try { map.removeLayer('ride-ab-glow'); } catch { }
  try { map.removeLayer('ride-ab-line'); } catch { }
  try { map.removeSource('ride-ab-src'); } catch { }
  map.addSource('ride-ab-src', { type: 'geojson', data: geoLine });
  map.addLayer({
    id: 'ride-ab-glow', type: 'line', source: 'ride-ab-src',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FACC15', 'line-width': 12, 'line-opacity': 0.6, 'line-blur': 4 }
  });
  map.addLayer({
    id: 'ride-ab-line', type: 'line', source: 'ride-ab-src',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FACC15', 'line-width': 5, 'line-opacity': 1 }
  });
}

async function _computeRide() {
  _rideStep = 2;
  _updateRideStep();
  document.getElementById('ride-dist-val').textContent = '…';
  document.getElementById('ride-fare-val').textContent = '…';
  document.getElementById('ride-fare-card').classList.remove('hidden');

  let distKm, coords;

  // Build path along route if both snapped and same route
  if (activeRouteId && _ridePickupCoords.snapped && _rideDropoffCoords.snapped) {
    const route = routes.find(r => r.id === activeRouteId);
    if (route) {
      const allCoords = buildSavedRouteCoords(route);
      const p1Idx = _ridePickupCoords.snapIdx;
      const p2Idx = _rideDropoffCoords.snapIdx;
      coords = _buildRidePathCoords(allCoords, route, p1Idx, p2Idx);
      distKm = _pathDistKm(coords);
    }
  }

  // Fall back to direct road if not using route path
  if (!coords) {
    try {
      const seg = await getRoadSegment(
        _ridePickupCoords.lat, _ridePickupCoords.lng,
        _rideDropoffCoords.lat, _rideDropoffCoords.lng
      );
      distKm = seg.distKm; coords = seg.coords;
    } catch {
      distKm = haversine(_ridePickupCoords.lat, _ridePickupCoords.lng,
        _rideDropoffCoords.lat, _rideDropoffCoords.lng);
      coords = [[_ridePickupCoords.lng, _ridePickupCoords.lat],
      [_rideDropoffCoords.lng, _rideDropoffCoords.lat]];
    }
  }

  document.getElementById('ride-dist-val').textContent = `${distKm.toFixed(2)} km`;
  document.getElementById('ride-time-val').textContent = _fmtTravelTime(distKm);
  _lastRideDistKm = distKm;

  const discountCb = document.getElementById('ride-discount-cb');
  const hasDiscount = discountCb?.checked || false;
  const rideVt2 = routes.find(r => r.id === activeRouteId)?.vehicle_type || 'puj';
  const fare = calcFare(distKm, rideVt2);
  const finalFare = hasDiscount ? fare * 0.8 : fare;
  const fareDisplay = hasDiscount
    ? `₱${finalFare.toFixed(2)} <s style="opacity:0.5;font-size:0.7em">₱${fare.toFixed(2)}</s>`
    : `₱${fare.toFixed(2)}`;
  document.getElementById('ride-fare-val').innerHTML = fareDisplay;
  document.getElementById('ride-reset-btn').classList.remove('hidden');

  // Draw route line on map
  const geoLine = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };

  // Remove existing layers first
  try { map.removeLayer('ride-ab-glow'); } catch { }
  try { map.removeLayer('ride-ab-line'); } catch { }
  try { map.removeSource('ride-ab-src'); } catch { }

  map.addSource('ride-ab-src', { type: 'geojson', data: geoLine });

  // Glow effect (white)
  map.addLayer({
    id: 'ride-ab-glow',
    type: 'line',
    source: 'ride-ab-src',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FACC15', 'line-width': 10, 'line-opacity': 0.5, 'line-blur': 3 }
  });

  // Main solid line (white)
  map.addLayer({
    id: 'ride-ab-line',
    type: 'line',
    source: 'ride-ab-src',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FACC15', 'line-width': 4, 'line-opacity': 1 }
  });

  // Fit map to show both points
  const bounds = new maplibregl.LngLatBounds()
    .extend([_ridePickupCoords.lng, _ridePickupCoords.lat])
    .extend([_rideDropoffCoords.lng, _rideDropoffCoords.lat]);
  map.fitBounds(bounds, { padding: 100, maxZoom: 16, duration: 1000 });
}

function _clearRideRoute() {
  try { map.removeLayer('ride-ab-glow'); } catch { }
  try { map.removeLayer('ride-ab-line'); } catch { }
  try { map.removeSource('ride-ab-src'); } catch { }
}

function refreshRideFare() {
  if (!rideModeActive || _rideStep !== 2 || !_lastRideDistKm) return;
  const vt = routes.find(r => r.id === activeRouteId)?.vehicle_type || 'puj';
  const fare = calcFare(_lastRideDistKm, vt);
  const hasDiscount = document.getElementById('ride-discount-cb')?.checked || false;
  const finalFare = hasDiscount ? fare * 0.8 : fare;
  const fareDisplay = hasDiscount
    ? `₱${finalFare.toFixed(2)} <s style="opacity:0.5;font-size:0.7em">₱${fare.toFixed(2)}</s>`
    : `₱${fare.toFixed(2)}`;
  document.getElementById('ride-fare-val').innerHTML = fareDisplay;
}

function resetRide() {
  if (_ridePickupMarker) { _ridePickupMarker.remove(); _ridePickupMarker = null; }
  if (_rideDropoffMarker) { _rideDropoffMarker.remove(); _rideDropoffMarker = null; }
  _ridePickupCoords = null; _rideDropoffCoords = null; _rideStep = 0;
  _rideRouteCoords = []; _rideStartIdx = 0;
  _clearRideRoute();
  _setRideAddress('ride-pickup-addr', '—');
  _setRideAddress('ride-dropoff-addr', '—');
  document.getElementById('ride-dist-val').textContent = '—';
  document.getElementById('ride-time-val').textContent = '—';
  document.getElementById('ride-fare-val').textContent = '—';
  document.getElementById('ride-fare-card').classList.add('hidden');
  document.getElementById('ride-slider-container').classList.add('hidden');
  document.getElementById('ride-reset-btn').classList.add('hidden');
  _updateRideStep();
  map.on('click', _rideClickHandler);
  map.getCanvas().style.cursor = 'crosshair';
}

function enterRideMode() {
  console.log('enterRideMode:', { activeRouteId, routesLen: routes.length });
  if (!activeRouteId) {
    alert('Select a route first from the route list, then enter ride mode');
    return;
  }
  const route = routes.find(r => r.id === activeRouteId);
  console.log('Using route:', route?.name);
  rideModeActive = true; _rideStep = 0;
  document.getElementById('ride-panel').classList.remove('hidden');
  document.getElementById('ride-step-indicator').textContent = `Route: ${route?.name || 'Unknown'} - Tap pickup`;
  _rideClickHandler = async (e) => {
    if (_rideStep >= 2) return;
    const { lat, lng } = e.lngLat;
    const type = _rideStep === 0 ? 'pickup' : 'dropoff';
    _rideStep++;
    if (_rideStep === 1) { _updateRideStep(); }
    await _placeRideMarker(lat, lng, type);
    if (_rideStep === 2) {
      map.off('click', _rideClickHandler);
      map.getCanvas().style.cursor = '';
      await _computeRide();
    }
  };
  map.on('click', _rideClickHandler);
  map.getCanvas().style.cursor = 'crosshair';
}

function exitRideMode() {
  rideModeActive = false;
  if (_rideClickHandler) { map.off('click', _rideClickHandler); _rideClickHandler = null; }
  if (_ridePickupMarker) { _ridePickupMarker.remove(); _ridePickupMarker = null; }
  if (_rideDropoffMarker) { _rideDropoffMarker.remove(); _rideDropoffMarker = null; }
  _ridePickupCoords = null; _rideDropoffCoords = null; _rideStep = 0;
  _clearRideRoute();
  map.getCanvas().style.cursor = '';
  document.getElementById('ride-panel').classList.add('hidden');
  document.getElementById('ride-fare-card').classList.add('hidden');
  document.getElementById('ride-reset-btn').classList.add('hidden');
  _setRideAddress('ride-pickup-addr', '—');
  _setRideAddress('ride-dropoff-addr', '—');
}

// ── Network & Device Detection ───────────────────
const DEVICE_CONFIG = {
  isMobile: () => window.innerWidth < 900,
  isLowBandwidth: () => {
    // Check for slow/slow-2g/3g connection
    const conn = navigator.connection?.effectiveType;
    return conn && ['slow-2g', '2g', '3g'].includes(conn);
  },
  isReducedMotion: () => {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  },
  isBatteryLow: async () => {
    if ('getBattery' in navigator) {
      const battery = await navigator.getBattery?.();
      return battery?.level < 0.2 && !battery?.charging;
    }
    return false;
  },
  supportsTouchEvents: () => 'ontouchstart' in window || navigator.maxTouchPoints > 0
};

// Apply device-specific optimizations on startup
async function initDeviceOptimizations() {
  if (DEVICE_CONFIG.isMobile()) {
    // Reduce terrain detail on mobile
    TERRAIN_DETAIL_SCALE = 0.6;
    // Disable heavy 3D effects
    document.body.classList.add('mobile-mode');
  }

  if (DEVICE_CONFIG.isLowBandwidth()) {
    // Use lower resolution tiles
    document.body.classList.add('low-bandwidth');
    // Disable animations
    document.body.classList.add('reduce-motion');
  }

  if (DEVICE_CONFIG.isReducedMotion()) {
    document.body.classList.add('reduce-motion');
  }

  // Haptic feedback on supported devices
  if (DEVICE_CONFIG.supportsTouchEvents() && 'vibrate' in navigator) {
    window.haptic = (pattern = 10) => navigator.vibrate?.(pattern);
  } else {
    window.haptic = () => { }; // Fallback
  }
}

// ── Event Optimization ──────────────────────────
// Debounce scroll/resize events on mobile
let _resizeTimeout;
let _lastScreenOrientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';

window.addEventListener('resize', () => {
  clearTimeout(_resizeTimeout);
  _resizeTimeout = setTimeout(() => {
    const newOrientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
    if (newOrientation !== _lastScreenOrientation) {
      _lastScreenOrientation = newOrientation;
      // Handle orientation change
      if (map) {
        setTimeout(() => map.resize(), 200);
      }
    }
  }, 150);
});

// Pause animations when page is not visible (battery saver)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    document.body.classList.add('page-hidden');
  } else {
    document.body.classList.remove('page-hidden');
  }
});

// Add haptic feedback to buttons
function addHapticFeedback(element) {
  if (!element || !window.haptic) return;
  element.addEventListener('click', () => {
    window.haptic?.(10);
  });
}

let TERRAIN_DETAIL_SCALE = 1; // Will be adjusted by device config

function syncAppViewportHeight() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${Math.round(viewportHeight)}px`);
}

syncAppViewportHeight();
window.visualViewport?.addEventListener('resize', syncAppViewportHeight);
window.visualViewport?.addEventListener('scroll', syncAppViewportHeight);

function initMobileSidebarCollapse() {
  const sb = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  let lastIsMobile = null;

  const syncSidebarLayout = (force = false) => {
    const isMobile = DEVICE_CONFIG.isMobile();
    if (!force && lastIsMobile === isMobile) return;
    lastIsMobile = isMobile;
    if (isMobile) {
      sb.classList.add('collapsed');
      toggle.classList.add('visible');
    } else {
      sb.classList.remove('collapsed');
      toggle.classList.remove('visible');
    }
  };

  // Collapse sidebar on initial load if mobile.
  syncSidebarLayout(true);

  // Re-check on window resize.
  window.addEventListener('resize', () => {
    syncSidebarLayout();
  });
}

// ── Find Tabs ──────────────────────────────────────
function initFindTabs() {
  document.querySelectorAll('.find-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.find-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.getElementById('routes-tab-filters').classList.toggle('hidden', name !== 'routes');
      document.getElementById('places-tab-filters').classList.toggle('hidden', name !== 'places');
      document.getElementById('routes-tab-body').classList.toggle('hidden', name !== 'routes');
      document.getElementById('places-tab-body').classList.toggle('hidden', name !== 'places');
      if (name === 'places') {
        renderPlacesResults();
        document.getElementById('places-search').focus();
      }
    });
  });
}

// ── Places Tab ─────────────────────────────────────
function renderPlacesResults() {
  const container = document.getElementById('places-results-list');
  const query = (document.getElementById('places-search').value || '').trim().toLowerCase();
  const landmarks = getAllLandmarks();

  const filtered = landmarks.filter(l => {
    const cat = (l.category || 'landmark').trim().toLowerCase();
    if (hiddenLandmarkCategories.has(cat)) return false;
    if (filterTown || filterBarangay) {
      const feat = getBrgyFeatureFromCoords(l.lng, l.lat);
      if (!feat) return false;
      if (filterBarangay && feat.properties.name !== filterBarangay) return false;
      if (filterTown && !filterBarangay && feat.properties.city !== filterTown) return false;
    }
    if (!query) return true;
    return l.name.toLowerCase().includes(query) ||
      cat.includes(query) ||
      (LF_LABELS[cat] || '').toLowerCase().includes(query);
  });

  if (!filtered.length) {
    container.innerHTML = `<div class="places-empty">${query ? 'No landmarks found' : 'No landmarks loaded yet'}</div>`;
    return;
  }

  container.innerHTML = filtered.slice(0, 60).map(l => {
    const cat = (l.category || 'landmark').trim().toLowerCase();
    const icon = LANDMARK_ICON_DATA[cat]?.emoji || '📍';
    const color = LANDMARK_ICON_DATA[cat]?.color || '#888';
    const label = LF_LABELS[cat] || cat;
    const addrLine = l.address ? `<div class="places-item-addr">${escHtml(l.address)}</div>` : '';
    const coords = `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`;
    return `<div class="places-item" data-lat="${l.lat}" data-lng="${l.lng}" data-name="${escHtml(l.name)}" data-cat="${escHtml(cat)}">
      <div class="places-item-icon" style="background:${color};color:#fff">${icon}</div>
      <div class="places-item-info">
        <div class="places-item-name">${escHtml(l.name)}</div>
        <div class="places-item-cat">${escHtml(label)}</div>
        ${addrLine}
        <div class="places-item-coords">${coords}</div>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.places-item').forEach(el => {
    const key = `${el.dataset.lat},${el.dataset.lng}`;
    if (key === _selectedPlaceKey) el.classList.add('active');
    el.addEventListener('click', () => selectPlaceLandmark({
      lat: parseFloat(el.dataset.lat),
      lng: parseFloat(el.dataset.lng),
      name: el.dataset.name,
      category: el.dataset.cat,
    }));
  });
}

const WALK_COLOR = '#0046C7';

const WALK_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.49 5.48c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9 1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1l-5.2 2.2v4.7h2v-3.4l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z"/></svg>`;

function _makeWalkMarkerEl() {
  const el = document.createElement('div');
  el.className = 'walk-marker';
  el.innerHTML = WALK_ICON_SVG;
  return el;
}

function walkToLandmark(lat, lng, btn) {
  const lmId = `lm-${lat}-${lng}`;
  if (_walkPathRouteId === lmId) { clearWalkPath(); return; }
  if (!routes.length) return;

  // Find nearest route by closest vertex
  let bestRoute = null, bestDist = Infinity, bestPoint = null;
  for (const r of routes) {
    if (!Array.isArray(r.stops) || r.stops.length < 2) continue;
    const nv = findNearestVertex(r, lat, lng);
    if (nv.dist < bestDist) { bestDist = nv.dist; bestRoute = r; bestPoint = { lat: nv.lat, lng: nv.lng }; }
  }
  if (!bestRoute) return;

  if (activePopup) activePopup.remove();
  drawWalkPath(lat, lng, bestPoint.lat, bestPoint.lng, lmId, btn);
}

function clearWalkPath() {
  try { map.removeLayer('walk-path-outline'); } catch { }
  try { map.removeLayer('walk-path'); } catch { }
  try { map.removeSource('walk-path-src'); } catch { }
  _walkMarkers.forEach(m => m.remove());
  _walkMarkers = [];
  _walkPathRouteId = null;
  document.querySelectorAll('.nearby-route-walk-btn').forEach(b => b.classList.remove('active'));
}

async function drawWalkPath(fromLat, fromLng, toLat, toLng, routeId, btn) {
  clearWalkPath();
  _walkPathRouteId = routeId;

  if (btn) { btn.classList.add('loading'); btn.disabled = true; }

  // Snap user location to nearest routable pedestrian node
  let snappedFrom = { lat: fromLat, lng: fromLng };
  try {
    const sf = await osrmNearest(fromLng, fromLat);
    if (sf) snappedFrom = sf;
  } catch (e) { console.warn('snapping failed', e); }

  // Use the best routed point directly (found via pedestrian routing distance, not geometric)
  let routeJoin = { lat: toLat, lng: toLng };
  console.log('[walk-debug] snapped from:', snappedFrom, 'route target (routed nearest):', routeJoin);

  // Route from snapped start to the routed nearest point on the route
  let coords = [[snappedFrom.lng, snappedFrom.lat], [routeJoin.lng, routeJoin.lat]];

  async function routeWithOSRM(from, to) {
    const url = `https://router.project-osrm.org/route/v1/foot/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=polyline6&steps=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM route ${res.status}`);
    const data = await res.json();
    const leg = data.routes?.[0];
    if (!leg?.geometry) throw new Error('OSRM route missing geometry');
    return _decodePolyline6(leg.geometry);
  }

  try {
    coords = await routeWithOSRM(snappedFrom, routeJoin);
    console.log('[walk-debug] OSRM routed:', coords.length, 'waypoints');
  } catch {
    try {
      const res = await fetch('https://valhalla1.openstreetmap.de/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locations: [{ lon: snappedFrom.lng, lat: snappedFrom.lat }, { lon: routeJoin.lng, lat: routeJoin.lat }],
          costing: 'pedestrian',
        }),
      });
      const data = await res.json();
      const leg = data.trip?.legs?.[0];
      if (leg) {
        coords = _decodePolyline6(leg.shape);
        console.log('[walk-debug] Valhalla routed:', coords.length, 'waypoints');
      }
    } catch (e) {
      console.warn('[walk-debug] routing failed, using straight line', e);
      // Fallback to straight line
    }
  }

  // Force exact endpoints to ensure clean snap to route
  coords[0] = [snappedFrom.lng, snappedFrom.lat];
  coords[coords.length - 1] = [routeJoin.lng, routeJoin.lat];


  if (btn) { btn.classList.remove('loading'); btn.disabled = false; btn.classList.add('active'); }
  if (_walkPathRouteId !== routeId) return;

  map.addSource('walk-path-src', {
    type: 'geojson',
    data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }
  });

  map.addLayer({
    id: 'walk-path-outline',
    type: 'line', source: 'walk-path-src',
    paint: { 'line-color': '#fff', 'line-width': 10, 'line-opacity': 0.45 }
  });
  map.addLayer({
    id: 'walk-path',
    type: 'line', source: 'walk-path-src',
    paint: { 'line-color': WALK_COLOR, 'line-width': 5.5, 'line-dasharray': [1.5, 1.8], 'line-opacity': 1 }
  });

  // Walk markers at start and end
  const startM = new maplibregl.Marker({ element: _makeWalkMarkerEl(), anchor: 'center' })
    .setLngLat([snappedFrom.lng || fromLng, snappedFrom.lat || fromLat]).addTo(map);
  const endM = new maplibregl.Marker({ element: _makeWalkMarkerEl(), anchor: 'center' })
    .setLngLat([coords[coords.length - 1][0], coords[coords.length - 1][1]]).addTo(map);
  _walkMarkers = [startM, endM];

  const lngs = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  map.fitBounds(
    [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 80, maxZoom: 17, duration: 700, pitch: 0, bearing: 0 }
  );
}

async function selectPlaceLandmark(lm) {
  clearWalkPath();
  _selectedPlaceKey = `${lm.lat},${lm.lng}`;
  map.flyTo({ center: [lm.lng, lm.lat], zoom: Math.max(map.getZoom(), 15), duration: 800 });

  // Highlight the selected item in the list
  document.querySelectorAll('.places-item').forEach(el => {
    el.classList.toggle('active', el.dataset.lat === String(lm.lat) && el.dataset.lng === String(lm.lng));
  });

  const icon = LANDMARK_ICON_DATA[lm.category]?.emoji || '📍';
  document.getElementById('nearby-lm-name').textContent = `${icon} ${lm.name}`;
  document.getElementById('places-results-list').classList.add('hidden');
  document.getElementById('nearby-panel').classList.remove('hidden');

  await renderNearbyRoutes(lm);
}

async function renderNearbyRoutes(lm) {
  const THRESHOLD_KM = 1.5;
  const container = document.getElementById('nearby-routes-list');

  const VT_LABELS = {
    puj: '🚐 PUJ', mpuj: '🚌 MPUJ',
    'pub-city': '🚍 PUB City', 'pub-city-ac': '🚍 PUBw/AC', 'uv-express': '🚙 UV Express',
  };

  // Pre-filter geometrically to avoid firing OSRM for every route in the dataset
  const GEO_PREFILTER_KM = THRESHOLD_KM + 1.0; // generous buffer above the display threshold
  const preFiltered = routes.filter(r => {
    if (!Array.isArray(r.stops) || !r.stops.length) return false;
    const geoDist = Math.min(...r.stops.map(s => haversine(lm.lat, lm.lng, s.lat, s.lng)));
    return geoDist <= GEO_PREFILTER_KM;
  });

  // Async map: OSRM-evaluate only the geometrically nearby routes
  const candidates = await Promise.all(
    preFiltered.map(async (r) => {
      try {
        const nearestPoint = await findNearestPointForWalk(r, lm.lat, lm.lng);
        const minDist = haversine(lm.lat, lm.lng, nearestPoint.lat, nearestPoint.lng);
        return { r, minDist, nearestPoint };
      } catch (e) {
        console.warn('[walk] failed to find nearest point for', r.name, e);
        return null;
      }
    })
  );

  const filtered = candidates
    .filter(c => c && c.minDist <= THRESHOLD_KM)
    .sort((a, b) => a.minDist - b.minDist);

  if (!filtered.length) {
    container.innerHTML = '<div class="nearby-empty">No jeepney routes within 1.5 km of this landmark.</div>';
    return;
  }

  container.innerHTML = filtered.slice(0, 8).map(({ r, minDist, nearestPoint }) => {
    const distStr = minDist < 1 ? `${Math.round(minDist * 1000)} m` : `${minDist.toFixed(1)} km`;
    const vt = VT_LABELS[r.vehicleType] || r.vehicleType || '';
    return `<div class="nearby-route-item">
      <div class="nearby-route-color" style="background:${r.color || '#0046C7'}"></div>
      <div class="nearby-route-info">
        <div class="nearby-route-name">${escHtml(r.name || 'Unnamed Route')}</div>
        <div class="nearby-route-meta">${escHtml(vt)} · ${distStr} away</div>
      </div>
      <button class="nearby-route-walk-btn" data-rid="${escHtml(r.id)}"
        data-from-lat="${lm.lat}" data-from-lng="${lm.lng}"
        data-to-lat="${nearestPoint.lat}" data-to-lng="${nearestPoint.lng}"
        title="Show walk path to nearest point on the route">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.49 5.48c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-3.6 13.9 1-4.4 2.1 2v6h2v-7.5l-2.1-2 .6-3c1.3 1.5 3.3 2.5 5.5 2.5v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1l-5.2 2.2v4.7h2v-3.4l1.8-.7-1.6 8.1-4.9-1-.4 2 7 1.4z"/></svg>
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('.nearby-route-walk-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rid = btn.dataset.rid;
      const toLat = parseFloat(btn.dataset.toLat);
      const toLng = parseFloat(btn.dataset.toLng);
      console.log('[walk-debug] walk button clicked', { rid, toLat, toLng });

      // Add debug marker for the target point
      if (map.getSource('debug-target')) map.removeSource('debug-target');
      if (map.getLayer('debug-target-layer')) map.removeLayer('debug-target-layer');
      map.addSource('debug-target', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'Point', coordinates: [toLng, toLat] } }
      });
      map.addLayer({
        id: 'debug-target-layer',
        type: 'circle', source: 'debug-target',
        paint: { 'circle-radius': 8, 'circle-color': '#FF0000', 'circle-opacity': 0.5 }
      });

      if (_walkPathRouteId === rid) {
        clearWalkPath();
      } else {
        document.querySelectorAll('.nearby-route-walk-btn').forEach(b => b.classList.remove('active'));
        drawWalkPath(
          parseFloat(btn.dataset.fromLat), parseFloat(btn.dataset.fromLng),
          toLat, toLng,
          rid, btn
        );
      }
    });
  });
}

function bindEvents() {
  document.getElementById('btn-new-route').addEventListener('click', () => openBuilder());
  document.getElementById('route-search').addEventListener('input', e => renderRouteList(e.target.value));
  document.getElementById('places-search').addEventListener('input', () => renderPlacesResults());
  document.getElementById('nearby-back-btn').addEventListener('click', () => {
    clearWalkPath();
    document.getElementById('nearby-panel').classList.add('hidden');
    document.getElementById('places-results-list').classList.remove('hidden');
  });
  document.getElementById('btn-sync-db').addEventListener('click', syncRoutesToDB);
  document.getElementById('btn-refresh-pins').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh-pins');
    btn.disabled = true;
    btn.style.animation = 'spin 0.8s linear infinite';
    _clearLandmarkCache();
    await fetchLandmarksFromDB(true);
    btn.disabled = false;
    btn.style.animation = '';
  });
  document.getElementById('fare-era-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.fare-era-btn');
    if (!btn) return;
    fareEra = btn.dataset.era;
    document.querySelectorAll('.fare-era-btn').forEach(b => b.classList.toggle('active', b.dataset.era === fareEra));
    if (activeRouteId) showRouteDetail(activeRouteId);
    updateFareSummary();
    renderRouteList(document.getElementById('route-search').value);
    refreshRideFare();
  });
  document.getElementById('btn-export').addEventListener('click', exportRoutes);
  document.getElementById('logo-btn').addEventListener('click', () => {
    const overlay = document.getElementById('auth-overlay');
    const pwInput = document.getElementById('auth-password');
    const errMsg = document.getElementById('auth-error');
    pwInput.value = '';
    errMsg.classList.add('hidden');
    overlay.classList.remove('hidden');
    setTimeout(() => pwInput.focus(), 60);
  });

  document.getElementById('builder-close').addEventListener('click', closeBuilder);
  document.getElementById('btn-cancel-builder').addEventListener('click', closeBuilder);
  document.getElementById('btn-save-route').addEventListener('click', saveRoute);
  document.getElementById('btn-close-loop').addEventListener('click', closeLoop);

  document.getElementById('route-color-input').addEventListener('input', () => refreshDraftMap());

  document.getElementById('btn-toggle-table').addEventListener('click', () => {
    const tbl = document.getElementById('fare-table');
    const btn = document.getElementById('btn-toggle-table');
    tbl.classList.toggle('hidden');
    btn.textContent = tbl.classList.contains('hidden') ? 'Show fare table ▾' : 'Hide fare table ▴';
  });

  document.getElementById('detail-close').addEventListener('click', hideRouteDetail);
  document.getElementById('btn-edit-route').addEventListener('click', () => { if (activeRouteId) startEdit(activeRouteId); });
  document.getElementById('btn-ride-from-route').addEventListener('click', () => { if (activeRouteId) enterRideMode(); });
  document.getElementById('btn-simulate-route').addEventListener('click', () => { if (activeRouteId) startSimulation(activeRouteId); });
  document.getElementById('btn-delete-detail').addEventListener('click', () => { if (activeRouteId) confirmDelete(activeRouteId); });
  document.getElementById('btn-gen-qr').addEventListener('click', () => { if (activeRouteId) showQrModal(activeRouteId); });
  document.getElementById('feedback-close').addEventListener('click', closeFeedback);
  document.getElementById('btn-mobile-feedback').addEventListener('click', () => {
    document.getElementById('mobile-feedback-ping').classList.add('hidden');
    openFeedback();
  });
  document.getElementById('feedback-overlay').addEventListener('click', e => { if (e.target.id === 'feedback-overlay') closeFeedback(); });
  document.getElementById('feedback-submit').addEventListener('click', submitFeedback);
  initFeedbackCharCounter();
  initFeedbackWidget();
  initAllRatings();
  document.getElementById('qr-modal-close').addEventListener('click', closeQrModal);
  document.getElementById('qr-modal-overlay').addEventListener('click', e => { if (e.target.id === 'qr-modal-overlay') closeQrModal(); });
  document.getElementById('qr-btn-download').addEventListener('click', downloadQr);
  document.getElementById('sim-end-btn').addEventListener('click', stopSimulation);
  document.getElementById('sim-play-pause').addEventListener('click', _simTogglePause);
  document.getElementById('sim-slower').addEventListener('click', () => _simChangeSpeed(-1));
  document.getElementById('sim-faster').addEventListener('click', () => _simChangeSpeed(1));

  document.getElementById('modal-cancel').addEventListener('click', _closeDeleteModal);
  document.getElementById('modal-confirm').addEventListener('click', doDelete);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') _closeDeleteModal();
  });

  document.getElementById('rp-bar-save').addEventListener('click', saveReposition);
  document.getElementById('rp-bar-cancel').addEventListener('click', cancelReposition);
  document.getElementById('btn-add-place').addEventListener('click', openPlaceSearch);
  document.getElementById('ps-mode-drop').addEventListener('click', () => _setSearchMode('drop'));
  document.getElementById('ps-close').addEventListener('click', closePlaceSearch);
  document.getElementById('ps-search-btn').addEventListener('click', runPlaceSearch);
  document.getElementById('ps-input').addEventListener('keydown', e => { if (e.key === 'Enter') runPlaceSearch(); });
  document.getElementById('ps-mode-google').addEventListener('click', () => _setSearchMode('google'));
  document.getElementById('ps-mode-osm').addEventListener('click', () => _setSearchMode('osm'));
  document.getElementById('ps-save').addEventListener('click', savePlaceToMap);
  document.getElementById('ps-discard').addEventListener('click', discardPlacePreview);

  // Edit-style bar
  document.getElementById('es-bar-save').addEventListener('click', saveEditStyle);
  document.getElementById('es-bar-cancel').addEventListener('click', cancelEditStyle);

  document.getElementById('ride-close-btn').addEventListener('click', exitRideMode);
  document.getElementById('ride-reset-btn').addEventListener('click', resetRide);
  document.getElementById('ride-discount-cb')?.addEventListener('change', () => {
    if (_rideStep === 2 && _lastRideDistKm) {
      const rideVt3 = routes.find(r => r.id === activeRouteId)?.vehicle_type || 'puj';
      const fare = calcFare(_lastRideDistKm, rideVt3);
      const hasDiscount = document.getElementById('ride-discount-cb').checked;
      const finalFare = hasDiscount ? fare * 0.8 : fare;
      const fareDisplay = hasDiscount
        ? `₱${finalFare.toFixed(2)} <s style="opacity:0.5;font-size:0.7em">₱${fare.toFixed(2)}</s>`
        : `₱${fare.toFixed(2)}`;
      document.getElementById('ride-fare-val').innerHTML = fareDisplay;
    }
  });

  document.getElementById('lf-show-all').addEventListener('click', () => setAllLandmarkCategories(true));
  document.getElementById('lf-hide-all').addEventListener('click', () => setAllLandmarkCategories(false));
  document.getElementById('toggle-barangays').addEventListener('change', toggleBarangays);
  document.getElementById('toggle-shader').addEventListener('change', toggleShader);
  document.getElementById('toggle-3d-buildings').addEventListener('change', toggle3D);
  document.getElementById('toggle-3d-terrain').addEventListener('change', toggle3DTerrain);
  _mswSetToggle('toggle-3d-buildings', is3D);
  _mswSetToggle('toggle-shader', _shaderOn);
  _mswSetToggle('toggle-barangays', barangaysVisible);
  _mswSetToggle('toggle-3d-terrain', is3DTerrain);
  document.getElementById('btn-map-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('map-settings-widget').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#map-settings-widget') && !e.target.closest('#btn-map-settings')) {
      document.getElementById('map-settings-widget').classList.add('hidden');
    }
  });
  document.getElementById('top-notice-close').addEventListener('click', () => {
    document.getElementById('top-notice').classList.add('hidden');
  });
  const _openMobileModal = () => document.getElementById('mobile-app-overlay').classList.remove('hidden');
  const _closeMobileModal = () => document.getElementById('mobile-app-overlay').classList.add('hidden');
  document.getElementById('btn-get-mobile').addEventListener('click', _openMobileModal);
  document.getElementById('btn-notice-mobile').addEventListener('click', _openMobileModal);
  document.getElementById('mobile-app-close').addEventListener('click', _closeMobileModal);
  document.getElementById('mobile-app-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('mobile-app-overlay')) _closeMobileModal();
  });
  document.getElementById('btn-improve-app').addEventListener('click', () => {
    openFeedback();
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    hideRouteDetail();
    map.flyTo({ center: MAP_CENTER, zoom: INITIAL_ZOOM, pitch: INITIAL_PITCH, bearing: INITIAL_BEARING, duration: 1200 });
  });

  const _collapseSidebar = () => {
    const sb = document.getElementById('sidebar');
    sb.classList.add('collapsed');
    document.getElementById('sidebar-toggle').classList.add('visible');
  };
  const _toggleSidebar = () => {
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('collapsed');
    document.getElementById('sidebar-toggle').classList.toggle('visible', sb.classList.contains('collapsed'));
  };
  document.getElementById('sidebar-toggle').addEventListener('click', _toggleSidebar);
  document.getElementById('sidebar-collapse-btn').addEventListener('click', _toggleSidebar);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (rideModeActive) { exitRideMode(); return; }
      if (_repositionId) { cancelReposition(); return; }
      if (document.getElementById('place-search-panel').classList.contains('open')) { closePlaceSearch(); return; }
      if (builderOpen) { closeBuilder(); return; }
      if (!document.getElementById('sidebar').classList.contains('collapsed')) { _collapseSidebar(); return; }
      hideRouteDetail();
    }
  });
}

// ── Place Search (Google Places + OSM toggle) ─────
let previewMarker = null;
let previewPlace = null;
let _searchMode = 'google'; // 'google' | 'osm'

let _googlePlacesLoading = false;
function _initGooglePlaces() {
  if (window.googlePlacesReady || _googlePlacesLoading || window.google?.maps) return;
  const key = (typeof CONFIG !== 'undefined' ? CONFIG.GOOGLE_PLACES_API_KEY : '') || '';
  if (!key) return;
  _googlePlacesLoading = true;
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async`;
  script.onload = () => { window.googlePlacesReady = true; _googlePlacesLoading = false; };
  script.onerror = () => { _googlePlacesLoading = false; };
  document.head.appendChild(script);
}

function openPlaceSearch() {
  _initGooglePlaces();
  if (_searchMode === 'google' && !window.googlePlacesReady) {
    _setSearchMode('osm');
  }
  document.getElementById('place-search-panel').classList.add('open');
  if (_searchMode !== 'drop') setTimeout(() => document.getElementById('ps-input').focus(), 150);
}

function _setSearchMode(mode) {
  _searchMode = mode;
  document.getElementById('ps-mode-google').classList.toggle('active', mode === 'google');
  document.getElementById('ps-mode-osm').classList.toggle('active', mode === 'osm');
  document.getElementById('ps-mode-drop').classList.toggle('active', mode === 'drop');
  const isSearch = mode !== 'drop';
  document.getElementById('ps-search-wrap').style.display = isSearch ? '' : 'none';
  const input = document.getElementById('ps-input');
  input.placeholder = mode === 'osm' ? 'e.g. Legazpi City Hall (OSM)' : 'e.g. Legazpi City Hall';
  document.getElementById('ps-hint').textContent = isSearch
    ? 'Type a place name and press Search. Pick a result to preview it, then save it to your database.'
    : 'Tap anywhere on the map to place your pin.';
  document.getElementById('ps-hint').classList.remove('hidden');
  if (_dropPinMode && isSearch) {
    _dropPinMode = false;
    map.getCanvas().style.cursor = '';
  }
  if (!isSearch) {
    _dropPinMode = true;
    map.getCanvas().style.cursor = 'crosshair';
  }
  discardPlacePreview();
}

function closePlaceSearch() {
  document.getElementById('place-search-panel').classList.remove('open');
  discardPlacePreview();
  if (_dropPinMode) {
    _dropPinMode = false;
    map.getCanvas().style.cursor = '';
  }
}

function discardPlacePreview() {
  if (previewMarker) { previewMarker.remove(); previewMarker = null; }
  previewPlace = null;
  document.getElementById('ps-input').value = '';
  document.getElementById('ps-results').innerHTML = '';
  document.getElementById('ps-results').classList.remove('active');
  document.getElementById('ps-preview').classList.add('hidden');
  document.getElementById('ps-hint').classList.remove('hidden');
  const btn = document.getElementById('ps-search-btn');
  btn.disabled = false;
  btn.textContent = 'Search';
}

// Fired by button click or Enter — dispatches to active search mode
async function runPlaceSearch() {
  if (_searchMode === 'osm') { runOsmPlaceSearch(); return; }
  if (_searchMode === 'google' && !window.googlePlacesReady) { _setSearchMode('osm'); runOsmPlaceSearch(); return; }

  const val = document.getElementById('ps-input').value.trim();
  if (!val) return;

  const btn = document.getElementById('ps-search-btn');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  const resultsBox = document.getElementById('ps-results');
  resultsBox.innerHTML = '';
  resultsBox.classList.remove('active');
  document.getElementById('ps-preview').classList.add('hidden');
  document.getElementById('ps-hint').classList.add('hidden');

  try {
    const { Place } = await google.maps.importLibrary('places');
    const { places } = await Place.searchByText({
      textQuery: val + ' Albay Philippines',
      fields: ['displayName', 'formattedAddress', 'location', 'id'],
      locationBias: { center: { lat: 13.2, lng: 123.65 }, radius: 50000 },
    });

    btn.disabled = false;
    btn.textContent = 'Search';

    if (!places?.length) {
      resultsBox.innerHTML = '<div class="ps-no-results">No results found. Try a different name.</div>';
      resultsBox.classList.add('active');
      return;
    }

    resultsBox.classList.add('active');
    places.slice(0, 6).forEach(r => {
      const lat = r.location.lat();
      const lng = r.location.lng();
      const item = document.createElement('div');
      item.className = 'ps-suggestion';
      item.innerHTML = `
        <span class="ps-sug-main">${escHtml(r.displayName)}</span>
        <span class="ps-sug-sub">${escHtml(r.formattedAddress || '')}</span>`;
      item.addEventListener('click', () => {
        resultsBox.querySelectorAll('.ps-suggestion').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        previewPlace = {
          name: r.displayName,
          lat, lng,
          address: r.formattedAddress || '',
          google_place_id: r.id,
        };
        showPlacePreview(previewPlace);
      });
      resultsBox.appendChild(item);
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Search';
    console.error('Place search error:', e);
    resultsBox.innerHTML = '<div class="ps-no-results">Search failed. Check your API key.</div>';
    resultsBox.classList.add('active');
  }
}

async function runOsmPlaceSearch() {
  const val = document.getElementById('ps-input').value.trim();
  if (!val) return;

  const btn = document.getElementById('ps-search-btn');
  btn.disabled = true;
  btn.textContent = 'Searching…';

  const resultsBox = document.getElementById('ps-results');
  resultsBox.innerHTML = '';
  resultsBox.classList.remove('active');
  document.getElementById('ps-preview').classList.add('hidden');
  document.getElementById('ps-hint').classList.add('hidden');

  try {
    const url = `${NOMINATIM}/search?format=json&q=${encodeURIComponent(val + ', Legazpi Albay Philippines')}&limit=8&addressdetails=1&namedetails=1&countrycodes=ph&viewbox=123.5,13.0,123.9,13.4&bounded=0`;
    const res = await fetch(url, NOMINATIM_OPTS);
    const places = await res.json();

    btn.disabled = false;
    btn.textContent = 'Search';

    if (!places?.length) {
      resultsBox.innerHTML = '<div class="ps-no-results">No results found. Try a different name.</div>';
      resultsBox.classList.add('active');
      return;
    }

    resultsBox.classList.add('active');
    places.slice(0, 6).forEach(r => {
      const lat = parseFloat(r.lat);
      const lng = parseFloat(r.lon);
      const name = r.namedetails?.name || r.display_name.split(',')[0];
      const item = document.createElement('div');
      item.className = 'ps-suggestion';
      item.innerHTML = `
        <span class="ps-sug-main">${escHtml(name)}</span>
        <span class="ps-sug-sub">${escHtml(r.display_name)}</span>`;
      item.addEventListener('click', () => {
        resultsBox.querySelectorAll('.ps-suggestion').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');
        previewPlace = { name, lat, lng, address: r.display_name, google_place_id: null };
        showPlacePreview(previewPlace);
      });
      resultsBox.appendChild(item);
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Search';
    console.error('OSM search error:', e);
    resultsBox.innerHTML = '<div class="ps-no-results">Search failed. Try again.</div>';
    resultsBox.classList.add('active');
  }
}

function _syncCategoryStyle() {
  const cat = document.getElementById('ps-category').value;
  const colorEl = document.getElementById('ps-color-input');
  const iconEl = document.getElementById('ps-icon-input');
  if (!colorEl.dataset.userSet) colorEl.value = LANDMARK_COLORS[cat] || '#673AB7';
  if (!iconEl.dataset.userSet) iconEl.value = LANDMARK_ICONS[cat] || '';
}

function showPlacePreview(place, noFly = false) {
  if (previewMarker) previewMarker.remove();
  previewMarker = new maplibregl.Marker({ color: '#FF6B35', draggable: true })
    .setLngLat([place.lng, place.lat])
    .addTo(map);
  previewMarker.on('drag', () => {
    const { lat, lng } = previewMarker.getLngLat();
    previewPlace.lat = lat;
    previewPlace.lng = lng;
    document.getElementById('ps-coords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  });
  if (!noFly) map.flyTo({ center: [place.lng, place.lat], zoom: 16, pitch: 0, duration: 900 });

  document.getElementById('ps-name').value = place.name;
  document.getElementById('ps-address').textContent = place.address;
  document.getElementById('ps-coords').textContent = `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`;

  document.getElementById('ps-hint').classList.add('hidden');
  document.getElementById('ps-preview').classList.remove('hidden');
}

async function savePlaceToMap() {
  if (!previewPlace) return;
  const name = document.getElementById('ps-name').value.trim() || previewPlace.name;
  const category = document.getElementById('ps-category').value;
  const btn = document.getElementById('ps-save');

  btn.disabled = true;
  btn.textContent = 'Saving…';
  const ok = await saveLandmarkToDB({ ...previewPlace, name, category });
  btn.disabled = false;

  if (ok) {
    btn.textContent = isAdmin() ? '✓ Saved' : '✓ Submitted for approval';
    setTimeout(() => { btn.textContent = 'Save to Map'; }, 2500);
    if (previewMarker) { previewMarker.remove(); previewMarker = null; }
    previewPlace = null;
    document.getElementById('ps-preview').classList.add('hidden');
    if (isAdmin() && !landmarksVisible) toggleLandmarks();
  } else {
    btn.textContent = isAdmin() ? 'Save to Map' : 'Submit';
  }
}

// ── Rating ────────────────────────────────────────
const RATING_KEY = 'esuyo_rating';

function initRatingStars(starsId, msgId) {
  const container = document.getElementById(starsId);
  const msg = document.getElementById(msgId);
  if (!container || !msg) return;

  const stars = Array.from(container.querySelectorAll('.fw-star'));
  const saved = parseInt(localStorage.getItem(RATING_KEY) || '0', 10);

  function setDisplay(val, readonly) {
    stars.forEach((s, i) => {
      s.classList.toggle('selected', i < val);
      s.classList.toggle('readonly', readonly);
    });
    if (readonly && val) {
      msg.textContent = `You rated ${val}/5 — thanks!`;
      msg.classList.add('rated');
    }
  }

  if (saved) { setDisplay(saved, true); return; }

  stars.forEach((star, i) => {
    star.addEventListener('mouseenter', () => {
      stars.forEach((s, j) => s.classList.toggle('hovered', j <= i));
    });
    star.addEventListener('mouseleave', () => {
      stars.forEach(s => s.classList.remove('hovered'));
    });
    star.addEventListener('click', async () => {
      const val = parseInt(star.dataset.val, 10);
      localStorage.setItem(RATING_KEY, String(val));
      setDisplay(val, true);
      stars.forEach(s => { s.removeEventListener('mouseenter', () => { }); s.removeEventListener('mouseleave', () => { }); });
      try {
        await _supabase.from('ratings').insert({ score: val });
      } catch (e) {
        console.warn('Rating insert failed:', e);
      }
    });
  });
}

function initAllRatings() {
  initRatingStars('fw-stars', 'fw-rating-msg');
  initRatingStars('modal-stars', 'modal-rating-msg');
}

// ── Page View Tracking ────────────────────────────
async function trackPageView() {
  if (!_supabase) return;
  if (localStorage.getItem('esuyo_viewed')) {
    if (isAdmin()) loadPageViewCount();
    return;
  }
  try {
    await _supabase.from('page_views').insert({});
    localStorage.setItem('esuyo_viewed', '1');
  } catch (e) {
    console.warn('Page view insert failed:', e);
  }
  if (isAdmin()) loadPageViewCount();
}

async function loadPageViewCount() {
  try {
    const { count } = await _supabase
      .from('page_views')
      .select('*', { count: 'exact', head: true });
    const el = document.getElementById('pageview-count');
    if (el) el.textContent = count?.toLocaleString() ?? '—';
  } catch (e) {
    console.warn('Page view count failed:', e);
  }
}

// ── Utils ─────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

