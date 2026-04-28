/* ═══════════════════════════════════════════════
   E-Suyo — Route Admin Panel Logic
   ═══════════════════════════════════════════════ */

const MAP_CENTER = [123.7438, 13.1391];
const INITIAL_ZOOM = 13.2;
const INITIAL_PITCH = 55;
const INITIAL_BEARING = -15;

const OSRM = 'https://router.project-osrm.org';

// ── LTFRB Fare Matrix ─────────────────────────────
// pre2026 = rates before March 2026 (Oct 2023 provisional)
// post2026 = rates from March 2026 onwards
const FARE_MATRIX = {
  'puj':         { label: 'PUJ',       fullLabel: 'Traditional Jeepney', emoji: '🚐',
    pre2026:  { base: 13.00, baseKm: 4, perKm: 1.80 },
    post2026: { base: 14.00, baseKm: 4, perKm: 2.00 } },
  'mpuj':        { label: 'MPUJ',      fullLabel: 'Modern Jeepney',       emoji: '🚌',
    pre2026:  { base: 15.00, baseKm: 4, perKm: 2.20 },
    post2026: { base: 17.00, baseKm: 4, perKm: 2.30 } },
  'pub-city':    { label: 'PUB City',  fullLabel: 'City Bus (Ordinary)',  emoji: '🚍',
    pre2026:  { base: 13.00, baseKm: 5, perKm: 2.25 },
    post2026: { base: 15.00, baseKm: 5, perKm: 2.49 } },
  'pub-city-ac': { label: 'PUBw/AC',  fullLabel: 'City Bus (Aircon)',    emoji: '🚍',
    pre2026:  { base: 15.00, baseKm: 5, perKm: 2.65 },
    post2026: { base: 18.00, baseKm: 5, perKm: 2.98 } },
  'uv-express':  { label: 'UV Express', fullLabel: 'UV Express',         emoji: '🚙',
    pre2026:  { base: 25.00, baseKm: 5, perKm: 2.00 },
    post2026: { base: 25.00, baseKm: 5, perKm: 2.00 } },
};

let fareEra = 'post2026'; // toggled by header button

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

function initFareMatrixTooltip() {
  const el = document.getElementById('fare-matrix-tooltip');
  if (!el) return;
  const rows = Object.entries(FARE_MATRIX).map(([, v]) => `
    <tr>
      <td class="fmt-vehicle">${v.emoji} ${v.label}</td>
      <td class="fmt-rate">₱${v.pre2026.base.toFixed(2)}<span class="fmt-km"> / ${v.pre2026.baseKm}km</span><span class="fmt-extra"> +₱${v.pre2026.perKm.toFixed(2)}/km</span></td>
      <td class="fmt-rate">₱${v.post2026.base.toFixed(2)}<span class="fmt-km"> / ${v.post2026.baseKm}km</span><span class="fmt-extra"> +₱${v.post2026.perKm.toFixed(2)}/km</span></td>
    </tr>`).join('');
  el.innerHTML = `
    <table class="fmt-table">
      <thead>
        <tr>
          <th>Vehicle</th>
          <th>Pre-2026</th>
          <th>2026 Rates</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ── State ────────────────────────────────────────
let map = null;
let routes = [];
let activeRouteId = null;
let filterTown = '';
let filterBarangay = '';
let _areaIndex = {};
let builderOpen = false;
let editingRouteId = null;
let isSnapping = false; // still used to block map clicks during async stop placement
let activePopup = null;

// Each stop: { name, lat, lng, address, roadDistFromPrev, roadPathFromPrev[] }
let draftStops = [];
let _draftMarkers = [];
let _draftDelBtns = [];   // [{ idx, delBtn }] for hover-show delete buttons
let _draftDragIdx  = -1;  // index of stop currently being dragged (-1 = none)
let _draftOnMove   = null;
let _draftOnUp     = null;
let _draftOnEnter  = null;
let _draftOnLeave  = null;
let _draftOnDown   = null;
let pendingDelete  = null;

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

// ── Geocoding (Nominatim + CORS Proxy) ──────────
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const CORS_PROXY = 'https://corsproxy.io/?';
const NOMINATIM_OPTS = { headers: { 'User-Agent': 'E-Suyo/1.0' } };

async function getCoordsFromPlace(placeName) {
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  await delay(1000); // Rate limit: 1 req/sec
  try {
    const url = `${NOMINATIM}/search?format=json&q=${encodeURIComponent(placeName + ', Legazpi Albay')}&limit=1`;
    const res = await fetch(CORS_PROXY + encodeURIComponent(url), NOMINATIM_OPTS);
    const data = await res.json();
    if (data && data[0]) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (e) { console.warn('Geocode fail:', placeName, e); }
  return null;
}

// ── Local barangay polygon lookup ────────────────
let legazpiBarangays = null;

function loadBarangays() {
  legazpiBarangays = window.LEGAZPI_BARANGAYS || null;
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
  } catch {}
  return '';
}

let routeLayers = {};
let routeSources = {};
let mapClickHandler = null;

// ── Init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadBarangays();
  initSupabase();
  await loadRoutes();
  initMap();
  initAreaFilter();
  bindEvents();
  initFareMatrixTooltip();
});

// ── Persistence ──────────────────────────────────
async function loadRoutes() {
  const { data, error } = await _supabase.from('routes').select('*').order('created_at', { ascending: true });
  if (error) { console.error('Failed to load routes from DB:', error); routes = []; return; }
  routes = data;
  localStorage.setItem('esuyo_routes', JSON.stringify(routes)); // cache
}
function saveRoutes() {
  localStorage.setItem('esuyo_routes', JSON.stringify(routes));
}

// ── Map Init ──────────────────────────────────────
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        carto: {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
            'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
            'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'
          ],
          tileSize: 512,
          attribution: '&copy; CARTO &copy; OpenStreetMap'
        }
      },
      layers: [{ id: 'carto-layer', type: 'raster', source: 'carto' }],
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
    },
    center: MAP_CENTER, zoom: INITIAL_ZOOM,
    pitch: INITIAL_PITCH, bearing: INITIAL_BEARING,
    maxZoom: 18, minZoom: 10, antialias: true,
    renderWorldCopies: false
  });

  map.on('load', () => {
    try {
      addTerrain();
      addBarangayLayers();
      add3DBuildings();
      addLandmarks();
      initLandmarkFilter();
      renderAllRoutesOnMap();
      renderRouteList();
      updateRouteCount();
      fetchLandmarksFromDB(); // async — updates layer when Supabase responds
    } catch (e) {
      console.error('Map load error:', e);
    } finally {
      setTimeout(() => document.getElementById('loading-screen').classList.add('hidden'), 700);
    }

    // Click outside route/landmark to close detail and popups
    map.on('click', (e) => {
      if (builderOpen) return;
      if (rideModeActive) return;
      const routeLayerIds = routes.flatMap(r => [`line-${r.id}`, `glow-${r.id}`]).filter(id => {
        try { return !!map.getLayer(id); } catch { return false; }
      });
      const popupLayerIds = [...routeLayerIds, 'landmarks-circle', 'stops-src'].filter(id => {
        try { return !!map.getLayer(id); } catch { return false; }
      });
      const routeFeatures = routeLayerIds.length ? map.queryRenderedFeatures(e.point, { layers: routeLayerIds }) : [];
      const popupFeatures = popupLayerIds.length ? map.queryRenderedFeatures(e.point, { layers: popupLayerIds }) : [];
      if (routeFeatures.length === 0 && activeRouteId) hideRouteDetail();
      if (popupFeatures.length === 0 && activePopup) { activePopup.remove(); activePopup = null; }
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

    map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: ['dem-filtered://{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 14,
      attribution: 'Terrain: Mapzen/AWS'
    });

    map.addLayer({
      id: 'terrain-hillshade',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-exaggeration': 0.3,
        'hillshade-shadow-color': '#8a9bb0',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#b0bec5',
        'hillshade-illumination-direction': 315,
        'hillshade-illumination-anchor': 'map'
      }
    });

    map.setTerrain({ source: 'terrain-dem', exaggeration: 0.65 });

    // High-altitude soft light — minimises dark side-faces on 3D extrusions.
    // position: [radial dist, azimuth °, polar/altitude °] — 75° = nearly overhead.
    map.setLight({ anchor: 'map', color: '#ffffff', intensity: 0.15, position: [1.5, 315, 75] });

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

function add3DBuildings() {
  try {
    map.addSource('omf', {
      type: 'vector',
      tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'],
      maxzoom: 14
    });
    map.addLayer({
      id: 'bld-3d', type: 'fill-extrusion',
      source: 'omf', 'source-layer': 'building', minzoom: 13,
      paint: {
        'fill-extrusion-color': '#c8cdd5',
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['*', ['coalesce', ['get', 'levels'], 2], 3.5]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, 0.55, 16, 0.8]
      }
    });
  } catch {}
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
const SUPABASE_URL      = window.ESUYO_CONFIG?.SUPABASE_URL      || '';
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
const LANDMARK_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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
  } catch {}
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
  };
  const { error } = landmark.google_place_id
    ? await _supabase.from('landmarks').upsert(payload, { onConflict: 'google_place_id' })
    : await _supabase.from('landmarks').insert(payload);
  if (error) { console.error('Save error:', error); return false; }
  _clearLandmarkCache();
  await fetchLandmarksFromDB(true);
  return true;
}


async function deleteLandmarkFromDB(id) {
  if (!_supabase) return;
  await _supabase.from('landmarks').delete().eq('id', id);
  dbLandmarks = dbLandmarks.filter(l => l.id !== id);
  _writeLandmarkCache(dbLandmarks);
  refreshLandmarksLayer();
}

function getAllLandmarks() {
  return dbLandmarks;
}


function refreshLandmarksLayer() {
  const src = map?.getSource('landmarks');
  if (!src) return;
  const visible = getAllLandmarks().filter(l => !hiddenLandmarkCategories.has(l.category || 'landmark'));
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
  map.setLayoutProperty('landmarks-circle', 'visibility', 'none');
  map.setLayoutProperty('landmarks-icon', 'visibility', 'none');
  map.setLayoutProperty('landmarks-label', 'visibility', 'none');
  _brandMarkers.forEach(m => { m.getElement().style.display = 'none'; });
  
  _repositionMarker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat([lng, lat])
    .addTo(map);

  _currentOrbScale = function() {
    const zoom = map.getZoom();
    const scale = Math.max(0.7, Math.min(1, (zoom - 8) / 8));
    el.style.transform = `scale(${scale})`;
    el.style.transformOrigin = 'center';
  };
  
  map.on('move', _currentOrbScale);
  _currentOrbScale();

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
    _repositionMarker.remove(); _repositionMarker = null; 
    _currentOrbScale = null;
  }
  _repositionId = null;
  document.getElementById('reposition-bar').classList.add('hidden');
  
  // Restore landmark visibility
  const vis = landmarksVisible ? 'visible' : 'none';
  map.setLayoutProperty('landmarks-circle', 'visibility', vis);
  map.setLayoutProperty('landmarks-icon', 'visibility', vis);
  map.setLayoutProperty('landmarks-label', 'visibility', vis);
  _brandMarkers.forEach(m => { m.getElement().style.display = landmarksVisible ? '' : 'none'; });
}

window.startReposition = startReposition;
window.saveReposition = saveReposition;
window.cancelReposition = cancelReposition;

// ── Barangay Boundaries ───────────────────────────
let barangaysVisible = false;
let _brgyGlowFrame = null;

function addBarangayLayers() {
  if (!legazpiBarangays || map.getSource('barangays')) return;
  map.addSource('barangays', { type: 'geojson', data: legazpiBarangays });

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
      'text-size': 11,
      'text-anchor': 'center',
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: { 'text-color': '#80FFFF', 'text-halo-color': 'rgba(0,10,30,0.85)', 'text-halo-width': 2 }
  });
}

function toggleBarangays() {
  barangaysVisible = !barangaysVisible;
  const vis = barangaysVisible ? 'visible' : 'none';
  ['brgy-glow-outer', 'brgy-glow-inner', 'brgy-line', 'brgy-label'].forEach(id => {
    try { map.setLayoutProperty(id, 'visibility', vis); } catch {}
  });
  document.getElementById('btn-barangays').classList.toggle('active', barangaysVisible);

  if (barangaysVisible) {
    _brgyGlowFrame = requestAnimationFrame(function tick(ts) {
      const op = 0.14 + 0.10 * Math.sin(ts / 1100);
      try { if (map.getLayer('brgy-glow-outer')) map.setPaintProperty('brgy-glow-outer', 'line-opacity', op); } catch {}
      _brgyGlowFrame = requestAnimationFrame(tick);
    });
  } else {
    if (_brgyGlowFrame) { cancelAnimationFrame(_brgyGlowFrame); _brgyGlowFrame = null; }
  }
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
  const icon  = document.getElementById('es-icon-input').value.trim();
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
window.deleteLandmark = async (id) => {
  if (!confirm('Remove this landmark from the database?')) return;
  await deleteLandmarkFromDB(id);
  if (activePopup) { activePopup.remove(); activePopup = null; }
};

const LANDMARK_COLORS = {
  mall: '#E91E63', hospital: '#F44336', school: '#2196F3', church: '#9C27B0',
  gov: '#607D8B', terminal: '#FF9800', airport: '#00BCD4', port: '#795548',
  bank: '#4CAF50', market: '#FF5722', park: '#8BC34A', landmark: '#673AB7',
  '711': '#00703c', '7eleven': '#00703c',
  factory: '#546E7A', gasstation: '#F57F17',
  fastfood: '#E65100', restaurant: '#6D4C41'
};

const LANDMARK_ICONS = {
  mall: '🛍️', hospital: '🏥', school: '🏫', church: '⛪',
  gov: '🏛️', terminal: '🚌', airport: '✈️', port: '⚓',
  bank: '🏦', market: '🛒', park: '🌳', landmark: '📍',
  '711': '7', '7eleven': '7',
  factory: '🏭', gasstation: '⛽',
  fastfood: '🍔', restaurant: '🍽️'
};

let landmarksVisible = true;
let hiddenLandmarkCategories = new Set();

function toggleLandmarks() {
  landmarksVisible = !landmarksVisible;
  const vis = landmarksVisible ? 'visible' : 'none';
  try {
    map.setLayoutProperty('landmarks-circle', 'visibility', vis);
    map.setLayoutProperty('landmarks-icon', 'visibility', vis);
    map.setLayoutProperty('landmarks-label', 'visibility', vis);
  } catch (e) { console.warn('Toggle error:', e); }
  _brandMarkers.forEach(m => { m.getElement().style.display = landmarksVisible ? '' : 'none'; });
  document.getElementById('btn-landmarks').classList.toggle('active', landmarksVisible);
}

window.toggleLandmarks = toggleLandmarks;

// ── Landmark Category Filter ──────────────────────
const LF_LABELS = {
  mall: 'Mall', hospital: 'Hospital', school: 'School', church: 'Church',
  gov: 'Government', terminal: 'Terminal', airport: 'Airport', port: 'Port',
  bank: 'Bank', market: 'Market', park: 'Park', landmark: 'Landmark',
  '7eleven': '7-Eleven', factory: 'Factory', gasstation: 'Gas Station',
  fastfood: 'Fast Food', restaurant: 'Restaurant'
};

function initLandmarkFilter() {
  const container = document.getElementById('lf-chips');
  if (!container) return;
  container.innerHTML = '';
  Object.entries(LANDMARK_COLORS).forEach(([cat, color]) => {
    if (cat === '711') return; // alias for 7eleven, skip duplicate
    const label = LF_LABELS[cat] || cat;
    const icon = LANDMARK_ICONS[cat] || '📍';
    const chip = document.createElement('button');
    chip.className = 'lf-chip active';
    chip.dataset.cat = cat;
    chip.style.setProperty('--chip-color', color);
    chip.innerHTML = `<span class="lf-chip-dot"></span>${icon} ${label}`;
    chip.addEventListener('click', () => {
      const hidden = hiddenLandmarkCategories.has(cat);
      if (hidden) { hiddenLandmarkCategories.delete(cat); chip.classList.add('active'); }
      else { hiddenLandmarkCategories.add(cat); chip.classList.remove('active'); }
      if (cat === '7eleven') { // keep 711 alias in sync
        if (!hidden) hiddenLandmarkCategories.add('711'); else hiddenLandmarkCategories.delete('711');
      }
      refreshLandmarksLayer();
    });
    container.appendChild(chip);
  });
}

function setAllLandmarkCategories(show) {
  hiddenLandmarkCategories.clear();
  if (!show) Object.keys(LANDMARK_COLORS).forEach(c => hiddenLandmarkCategories.add(c));
  document.querySelectorAll('.lf-chip').forEach(c => c.classList.toggle('active', show));
  refreshLandmarksLayer();
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
        try { if (map.getLayer(id)) map.setPaintProperty(id, 'line-dasharray', dash); } catch {}
      });
      const glowOpacity = 0.13 + 0.07 * Math.sin(ts / 900);
      _glowLayerIds.forEach(id => {
        try { if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', glowOpacity); } catch {}
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

function makeBrandMarkerEl(l, brand) {
  const logoUrl = brand === 'jollibee' ? JOLLIBEE_LOGO_URL : MCDO_LOGO_URL;
  const accent  = brand === 'jollibee' ? '#E31837' : '#ffffff';
  const stroke  = brand === 'jollibee' ? '#E31837' : '#dddddd';
  // McDonald's arches need inset padding; Jollibee icon fills the circle
  const pad = brand === 'mcdonalds' ? 4 : 0;
  const uid = (l.id || `${l.lat}${l.lng}`).toString().replace(/[^a-z0-9]/gi, '');
  const el = document.createElement('div');
  el.style.cssText = 'width:26px;height:26px;cursor:pointer';
  el.innerHTML = `<svg width="26" height="26" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <clipPath id="bc${uid}"><circle cx="13" cy="13" r="11"/></clipPath>
      <filter id="bs${uid}" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="rgba(0,0,0,0.38)"/>
      </filter>
    </defs>
    <circle cx="13" cy="13" r="11" fill="#fff" stroke="${stroke}" stroke-width="1.5" filter="url(#bs${uid})"/>
    <image href="${logoUrl}" x="${2+pad}" y="${2+pad}" width="${22-pad*2}" height="${22-pad*2}"
      clip-path="url(#bc${uid})" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
  return el;
}

function renderBrandMarkers() {
  _brandMarkers.forEach(m => m.remove());
  _brandMarkers = [];
  getAllLandmarks().forEach(l => {
    const brand = getBrand(l.name);
    if (!brand) return;
    if (hiddenLandmarkCategories.has(l.category || 'fastfood')) return;
    const el = makeBrandMarkerEl(l, brand);
    el.addEventListener('click', () => {
      const pinIcon = brand === 'jollibee' ? '🐝' : '🍔';
      const category = l.category || 'fastfood';
      const dbBtns = l.id ? `
        <div class="lm-db-actions">
          <button class="lm-reposition-btn" onclick="startReposition('${escHtml(l.id)}','${escHtml(l.name)}',${l.lat},${l.lng},'${escHtml(category)}')">Move Pin</button>
          <button class="lm-delete-btn" onclick="deleteLandmark('${escHtml(l.id)}')">Remove</button>
        </div>` : '';
      if (activePopup) { activePopup.remove(); activePopup = null; }
      activePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: [0, -14] })
        .setLngLat([l.lng, l.lat])
        .setHTML(`<div class="landmark-popup">
          <strong>${escHtml(l.name)}</strong>
          <span class="category">${pinIcon} ${escHtml(category)}</span>
          <span class="coords">${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}</span>
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
}

function addLandmarks() {
  try {
    if (map.getSource('landmarks')) return;

    renderBrandMarkers();

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

    map.addSource('landmarks', { type: 'geojson', data: { type: 'FeatureCollection', features } });

    map.addLayer({
      id: 'landmarks-circle',
      type: 'circle',
      source: 'landmarks',
      filter: ['==', ['get', 'brand'], ''],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 13, 8, 16, 12],
        'circle-color': ['match', ['get', 'category'],
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
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fff',
        'circle-opacity': 0.9
      }
    });

    map.addLayer({
      id: 'landmarks-icon',
      type: 'symbol',
      source: 'landmarks',
      filter: ['==', ['get', 'brand'], ''],
      layout: {
        'text-field': ['match', ['get', 'category'],
          '7eleven', '7',
          '711', '7',
          'hospital', 'H',
          'mall', '🛍️',
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
          'factory', '🏭',
          'gasstation', '⛽',
          'fastfood', '🍔',
          'restaurant', '🍽️',
          '📍'
        ],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 6, 13, 11, 16, 16],
        'text-anchor': 'center',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#fff', 'text-halo-width': 0, 'text-opacity': 0.95 }
    });

    map.addLayer({
      id: 'landmarks-label',
      type: 'symbol',
      source: 'landmarks',
      minzoom: 13,
      layout: { 'text-field': ['get', 'name'], 'text-size': 12, 'text-offset': [0, 1.8], 'text-anchor': 'top' },
      paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 3 }
    });

    map.on('click', 'landmarks-circle', (e) => {
      if (e.features && e.features[0]) {
        const props = e.features[0].properties;
        const lat = parseFloat(props.lat);
        const lng = parseFloat(props.lng);
        const pinIcon = LANDMARK_ICONS[props.category] || '📍';
        const category = props.category || 'landmark';
        const dbBtns = props.dbId ? `
          <div class="lm-db-actions">
            <button class="lm-reposition-btn" onclick="startReposition('${escHtml(props.dbId)}','${escHtml(props.name)}',${lat},${lng},'${escHtml(category)}')">Move Pin</button>
            <button class="lm-delete-btn" onclick="deleteLandmark('${escHtml(props.dbId)}')">Remove</button>
          </div>` : '';
        if (activePopup) { activePopup.remove(); activePopup = null; }
        activePopup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 15 })
          .setLngLat(e.lngLat)
          .setHTML(`<div class="landmark-popup">
            <strong>${escHtml(props.name)}</strong>
            <span class="category">${pinIcon} ${escHtml(props.category)}</span>
            <span class="coords">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>
            ${dbBtns}
          </div>`)
          .addTo(map);
        activePopup.on('close', () => { activePopup = null; });
      }
    });

    map.on('mouseenter', 'landmarks-circle', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'landmarks-circle', () => map.getCanvas().style.cursor = '');
  } catch (e) { console.error('Landmarks error:', e); }
}

// ── OSRM Helpers ─────────────────────────────────
async function getRoadSegment(fromLat, fromLng, toLat, toLng) {
  const url = `${OSRM}/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  const d = await res.json();
  if (d.code === 'Ok' && d.routes?.[0]) {
    return {
      distKm: d.routes[0].distance / 1000,
      coords: d.routes[0].geometry.coordinates
    };
  }
  // straight-line fallback
  return {
    distKm: haversine(fromLat, fromLng, toLat, toLng),
    coords: [[fromLng, fromLat], [toLng, toLat]]
  };
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

  map.addLayer({ id: glowId, type: 'line', source: srcId,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': route.color, 'line-width': 14, 'line-opacity': 0.12, 'line-blur': 6 }
  });
  map.addLayer({ id: lineId, type: 'line', source: srcId,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': route.color, 'line-width': 4, 'line-opacity': 0.9 }
  });
  const flowId = `flow-${route.id}`;
  map.addLayer({ id: flowId, type: 'line', source: srcId,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': 2.5,
      'line-opacity': 0,
      'line-dasharray': _FLOW_DASH_SEQ[0]
    }
  });
  _flowLayerIds.push(flowId);
  _glowLayerIds.push(glowId);
  map.addLayer({ id: arrowsId, type: 'symbol', source: srcId,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 90,
      'icon-image': arrowImgId,
      'icon-size': 1.2,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    }
  });
  const reverseArrowsId = `reverse-arrows-${route.id}`;
  map.addLayer({ id: reverseArrowsId, type: 'symbol', source: srcId,
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
  });
  // All stops except the starting point (rendered as circle dots)
  map.addLayer({ id: stopsId, type: 'circle', source: stopsSrcId,
    filter: ['!=', ['get', 'isStart'], true],
    paint: {
      'circle-radius': ['case', ['get', 'isEnd'], 7, 5],
      'circle-color': route.color,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
      'circle-opacity': 0.95
    }
  });
  // Starting point rendered as a terminal pin icon
  map.addLayer({ id: terminalId, type: 'symbol', source: stopsSrcId,
    filter: ['==', ['get', 'isStart'], true],
    layout: {
      'icon-image': terminalImgId,
      'icon-size': 1,
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': 1 }
  });

  const handleStopClick = (e) => {
    if (builderOpen) return;
    e.preventDefault();
    const props = e.features[0]?.properties;
    const idx = props?.idx;
    const stop = route.stops[idx];
    if (!stop) return;
    showStopPopup(route, stop, e.lngLat);
    showRouteDetail(route.id);
    highlightStopItem(idx);
  };
  map.on('click', stopsId, handleStopClick);
  map.on('click', terminalId, handleStopClick);
  map.on('mouseenter', stopsId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', stopsId, () => { if (!builderOpen) map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', terminalId, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', terminalId, () => { if (!builderOpen) map.getCanvas().style.cursor = ''; });

  map.on('click', lineId, async (e) => {
    if (builderOpen) return;
    const onStop = map.queryRenderedFeatures(e.point, { layers: [stopsId, terminalId] });
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

  routeLayers[route.id] = [glowId, lineId, flowId, arrowsId, reverseArrowsId, stopsId, terminalId];
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
    try { map.setPaintProperty(`line-${r.id}`, 'line-opacity', isActive ? 1 : 0.02); } catch {}
    try { map.setPaintProperty(`line-${r.id}`, 'line-width', isActive ? 5 : 2); } catch {}
    try { map.setPaintProperty(`stops-${r.id}`, 'circle-opacity', isActive ? 0.95 : 0.02); } catch {}
    try { map.setPaintProperty(`glow-${r.id}`, 'line-opacity', isActive ? 0.4 : 0); } catch {}
    try { map.setLayoutProperty(`arrows-${r.id}`, 'visibility', isActive ? 'visible' : 'none'); } catch {}
    try { map.setLayoutProperty(`reverse-arrows-${r.id}`, 'visibility', isActive ? 'visible' : 'none'); } catch {}
    try { map.setPaintProperty(`terminal-${r.id}`, 'icon-opacity', isActive ? 1 : 0.02); } catch {}
    try { map.setPaintProperty(`flow-${r.id}`, 'line-opacity', isActive ? 0.5 : 0); } catch {}
  });
  _startRouteAnimation();
}

function showAllRoutes() {
  if (!map || !routes.length) return;
  _stopRouteAnimation();
  routes.forEach(r => {
    try { map.setPaintProperty(`line-${r.id}`, 'line-opacity', 0.9); } catch {}
    try { map.setPaintProperty(`line-${r.id}`, 'line-width', 4); } catch {}
    try { map.setPaintProperty(`stops-${r.id}`, 'circle-opacity', 0.95); } catch {}
    try { map.setPaintProperty(`glow-${r.id}`, 'line-opacity', 0.12); } catch {}
    try { map.setLayoutProperty(`arrows-${r.id}`, 'visibility', 'visible'); } catch {}
    try { map.setLayoutProperty(`reverse-arrows-${r.id}`, 'visibility', 'visible'); } catch {}
    try { map.setPaintProperty(`terminal-${r.id}`, 'icon-opacity', 1); } catch {}
    try { map.setPaintProperty(`flow-${r.id}`, 'line-opacity', 0); } catch {}
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

function findNearestOnRoute(route, lat, lng) {
  const coords = buildSavedRouteCoords(route);
  console.log('findNearestOnRoute:', route.name, 'has', coords?.length, 'coords');
  if (!coords?.length) return { lat, lng, dist: Infinity, idx: -1 };
  
  let minDist = Infinity;
  let nearestIdx = 0;
  let nearestPt = coords[0];
  
  for (let i = 0; i < coords.length; i++) {
    const [cl, ct] = coords[i];
    const d = haversine(lat, lng, ct, cl);
    if (d < minDist) { minDist = d; nearestIdx = i; nearestPt = coords[i]; }
  }
  
  return { lat: nearestPt[1], lng: nearestPt[0], dist: minDist, idx: nearestIdx };
}

function removeRouteFromMap(routeId) {
  const layers = routeLayers[routeId] || [];
  _flowLayerIds = _flowLayerIds.filter(id => !layers.includes(id));
  _glowLayerIds = _glowLayerIds.filter(id => !layers.includes(id));
  layers.forEach(lyr => { try { map.removeLayer(lyr); } catch {} });
  (routeSources[routeId] || []).forEach(src => { try { map.removeSource(src); } catch {} });
  try { if (map.hasImage(`arrow-img-${routeId}`)) map.removeImage(`arrow-img-${routeId}`); } catch {}
  try { if (map.hasImage(`terminal-img-${routeId}`)) map.removeImage(`terminal-img-${routeId}`); } catch {}
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
  });

  document.getElementById('af-barangay').addEventListener('change', e => {
    filterBarangay = e.target.value;
    _syncAreaClearBtn();
    renderRouteList(document.getElementById('route-search').value);
  });

  document.getElementById('af-clear').addEventListener('click', () => {
    filterTown = ''; filterBarangay = '';
    document.getElementById('af-town').value = '';
    document.getElementById('af-barangay').value = '';
    _populateBrgyDropdown();
    _syncAreaClearBtn();
    renderRouteList(document.getElementById('route-search').value);
  });
}

// ── Route List ────────────────────────────────────
function applyMapFilter(visibleIds) {
  if (!map) return;
  const all = visibleIds === null;
  routes.forEach(r => {
    const show = all || visibleIds.has(r.id);
    try { map.setPaintProperty(`line-${r.id}`, 'line-opacity', show ? 0.9 : 0.04); } catch {}
    try { map.setPaintProperty(`line-${r.id}`, 'line-width', show ? 4 : 2); } catch {}
    try { map.setPaintProperty(`stops-${r.id}`, 'circle-opacity', show ? 0.95 : 0.04); } catch {}
    try { map.setPaintProperty(`glow-${r.id}`, 'line-opacity', show ? 0.12 : 0); } catch {}
    try { map.setLayoutProperty(`arrows-${r.id}`, 'visibility', show ? 'visible' : 'none'); } catch {}
    try { map.setLayoutProperty(`reverse-arrows-${r.id}`, 'visibility', show ? 'visible' : 'none'); } catch {}
    try { map.setPaintProperty(`terminal-${r.id}`, 'icon-opacity', show ? 1 : 0.04); } catch {}
  });
}

function renderRouteList(filter = '') {
  const list = document.getElementById('route-list');
  const empty = document.getElementById('empty-state');
  const q = filter.toLowerCase();
  const filtered = routes.filter(r =>
    (!q || r.name.toLowerCase().includes(q) || r.stops.some(s => s.name.toLowerCase().includes(q))) &&
    _routeMatchesArea(r)
  );

  const isFiltered = q || filterTown || filterBarangay;
  if (!activeRouteId) applyMapFilter(isFiltered ? new Set(filtered.map(r => r.id)) : null);

  list.innerHTML = '';
  empty.classList.toggle('hidden', filtered.length > 0);

  filtered.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = `route-item${activeRouteId === r.id ? ' active' : ''}`;
    div.dataset.id = r.id;
    div.style.animationDelay = `${i * 0.05}s`;
    div.innerHTML = `
      <div class="route-item-dot" style="background:${r.color}"></div>
      <div class="route-item-info">
        <div class="route-item-name">${r.name}</div>
        <div class="route-item-meta">${r.stops.length} stops · ${routeTotalDistStr(r)}${r.vehicle_type ? ` · ${vehicleTag(r.vehicle_type)}` : ''}</div>
      </div>
      <div class="route-item-actions">
        <button class="btn-icon-sm" data-action="edit" title="Edit">✎</button>
        <button class="btn-icon-sm delete" data-action="delete" title="Delete">🗑</button>
      </div>`;
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
  renderRouteList(document.getElementById('route-search').value);
  
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
  document.getElementById('route-detail').classList.add('visible');

  if (route.stops.length >= 2) {
    const bounds = new maplibregl.LngLatBounds();
    route.stops.forEach(s => bounds.extend([s.lng, s.lat]));
    map.fitBounds(bounds, { padding: { top: 80, bottom: 80, left: 340, right: 400 }, duration: 1200, maxZoom: 15 });
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
  activeRouteId = null;
  // Show all routes again
  showAllRoutes();
  renderRouteList(document.getElementById('route-search').value);
}

// ── Builder ───────────────────────────────────────
function openBuilder(routeId = null) {
  editingRouteId = routeId;
  builderOpen = true;
  if (activePopup) { activePopup.remove(); activePopup = null; }
  document.getElementById('route-detail').classList.remove('visible');

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

// ── Add Stop — road trace (no snapping) ──────────
async function addDraftStop(lat, lng) {
  isSnapping = true;
  setBuilderInstruction('Placing stop…', true);
  map.getCanvas().style.cursor = 'wait';

  try {
    const address = await getAddressFromCoords(lat, lng);

    let roadDistFromPrev = 0;
    let roadPathFromPrev = [];

    if (draftStops.length > 0) {
      const prev = draftStops[draftStops.length - 1];
      const seg = await getRoadSegment(prev.lat, prev.lng, lat, lng);
      roadDistFromPrev = seg.distKm;
      roadPathFromPrev = seg.coords;
    }

    draftStops.push({
      name: address || `Location ${draftStops.length + 1}`,
      lat, lng,
      address,
      roadDistFromPrev,
      roadPathFromPrev
    });

    refreshDraftMap();
    renderDraftStopsList();
    updateFareSummary();

  } catch (err) {
    // Fallback: straight line if OSRM unavailable
    let roadDistFromPrev = 0, roadPathFromPrev = [];
    if (draftStops.length > 0) {
      const p = draftStops[draftStops.length - 1];
      roadDistFromPrev = haversine(p.lat, p.lng, lat, lng);
      roadPathFromPrev = [[p.lng, p.lat], [lng, lat]];
    }
    const address = await getAddressFromCoords(lat, lng);
    draftStops.push({ name: address || `Location ${draftStops.length + 1}`, lat, lng, address, roadDistFromPrev, roadPathFromPrev });
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
  const last  = draftStops[draftStops.length - 1];
  if (Math.abs(first.lat - last.lat) < 0.00001 && Math.abs(first.lng - last.lng) < 0.00001) return;

  setBuilderInstruction('Closing loop…', true);
  map.getCanvas().style.cursor = 'wait';
  try {
    const seg = await getRoadSegment(last.lat, last.lng, first.lat, first.lng);
    draftStops.push({ name: first.name, lat: first.lat, lng: first.lng, address: first.address,
      roadDistFromPrev: seg.distKm, roadPathFromPrev: seg.coords });
  } catch {
    draftStops.push({ name: first.name, lat: first.lat, lng: first.lng, address: first.address,
      roadDistFromPrev: haversine(last.lat, last.lng, first.lat, first.lng),
      roadPathFromPrev: [[last.lng, last.lat], [first.lng, first.lat]] });
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
  if (_draftOnDown)  { try { map.off('mousedown',  'draft-stops-lyr', _draftOnDown);  } catch {} _draftOnDown  = null; }
  if (_draftOnEnter) { try { map.off('mouseenter', 'draft-stops-lyr', _draftOnEnter); } catch {} _draftOnEnter = null; }
  if (_draftOnLeave) { try { map.off('mouseleave', 'draft-stops-lyr', _draftOnLeave); } catch {} _draftOnLeave = null; }
  if (_draftOnMove)  { map.off('mousemove', _draftOnMove); _draftOnMove = null; }
  if (_draftOnUp)    { map.off('mouseup',   _draftOnUp);   _draftOnUp   = null; }
  ['draft-stops-lyr', 'draft-arrows-lyr', 'draft-line-lyr', 'draft-glow-lyr'].forEach(id => { try { map.removeLayer(id); } catch {} });
  ['draft-stops-src', 'draft-line-src'].forEach(id => { try { map.removeSource(id); } catch {} });
  try { if (map.hasImage('draft-arrow-img')) map.removeImage('draft-arrow-img'); } catch {}
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
  map.addLayer({ id: 'draft-stops-lyr', type: 'circle', source: 'draft-stops-src',
    paint: {
      'circle-radius': ['case', ['get', 'isEnd'], 9, 7],
      'circle-color': color,
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#ffffff',
    }
  });

  if (draftStops.length >= 2) {
    const lineCoords = buildDraftLineCoords();
    map.addSource('draft-line-src', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords } }
    });
    map.addLayer({ id: 'draft-glow-lyr', type: 'line', source: 'draft-line-src',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': 14, 'line-opacity': 0.14, 'line-blur': 7 }
    }, 'draft-stops-lyr');
    map.addLayer({ id: 'draft-line-lyr', type: 'line', source: 'draft-line-src',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': color, 'line-width': 4, 'line-opacity': 0.9 }
    }, 'draft-stops-lyr');
    map.addImage('draft-arrow-img', makeArrowImage(color));
    map.addLayer({ id: 'draft-arrows-lyr', type: 'symbol', source: 'draft-line-src',
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
      map.off('mouseup',   _draftOnUp);
      _draftOnMove = null;
      _draftOnUp   = null;
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

      draftStops[idx].lat = ll.lat;
      draftStops[idx].lng = ll.lng;

      setBuilderInstruction('Re-routing…', true);
      map.getCanvas().style.cursor = 'wait';
      try {
        if (idx > 0) {
          const prev = draftStops[idx - 1];
          const seg = await getRoadSegment(prev.lat, prev.lng, ll.lat, ll.lng);
          draftStops[idx].roadDistFromPrev = seg.distKm;
          draftStops[idx].roadPathFromPrev = seg.coords;
        }
        if (idx < draftStops.length - 1) {
          const next = draftStops[idx + 1];
          const seg = await getRoadSegment(ll.lat, ll.lng, next.lat, next.lng);
          draftStops[idx + 1].roadDistFromPrev = seg.distKm;
          draftStops[idx + 1].roadPathFromPrev = seg.coords;
        }
        getAddressFromCoords(ll.lat, ll.lng).then(addr => {
          if (addr) { draftStops[idx].address = addr; draftStops[idx].name = addr; }
          renderDraftStopsList();
        });
      } catch {
        if (idx > 0) {
          const prev = draftStops[idx - 1];
          draftStops[idx].roadDistFromPrev = haversine(prev.lat, prev.lng, ll.lat, ll.lng);
          draftStops[idx].roadPathFromPrev = [[prev.lng, prev.lat], [ll.lng, ll.lat]];
        }
        if (idx < draftStops.length - 1) {
          const next = draftStops[idx + 1];
          draftStops[idx + 1].roadDistFromPrev = haversine(ll.lat, ll.lng, next.lat, next.lng);
          draftStops[idx + 1].roadPathFromPrev = [[ll.lng, ll.lat], [next.lng, next.lat]];
        }
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
    map.on('mouseup',   _draftOnUp);
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
      Math.abs(draftStops[0].lat - draftStops[n-1].lat) < 0.00001 &&
      Math.abs(draftStops[0].lng - draftStops[n-1].lng) < 0.00001;
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
    stops: draftStops.map(s => ({ ...s }))
  };

  if (_supabase) {
    const { error } = await _supabase.from('routes').upsert(routeObj, { onConflict: 'id' });
    if (error) { console.error('Route save error:', error); alert('Failed to save route: ' + error.message); btn.disabled = false; btn.textContent = 'Save Route'; return; }
  }

  if (editingRouteId) {
    routes[routes.findIndex(r => r.id === editingRouteId)] = routeObj;
  } else {
    routes.push(routeObj);
  }

  saveRoutes();
  btn.disabled = false; btn.textContent = 'Save Route';
  closeBuilder();
  renderAllRoutesOnMap();
  renderRouteList();
  updateRouteCount();
  showRouteDetail(routeObj.id);
}

// ── Edit / Delete ─────────────────────────────────
function startEdit(routeId) { hideRouteDetail(); openBuilder(routeId); }

function confirmDelete(routeId) {
  const route = routes.find(r => r.id === routeId);
  pendingDelete = routeId;
  document.getElementById('modal-msg').textContent =
    `This will permanently remove "${route?.name || 'this route'}".`;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

async function doDelete() {
  if (!pendingDelete) return;
  if (_supabase) {
    const { error } = await _supabase.from('routes').delete().eq('id', pendingDelete);
    if (error) { console.error('Route delete error:', error); alert('Failed to delete route: ' + error.message); return; }
  }
  removeRouteFromMap(pendingDelete);
  routes = routes.filter(r => r.id !== pendingDelete);
  saveRoutes();
  pendingDelete = null;
  hideRouteDetail();
  renderRouteList();
  updateRouteCount();
  document.getElementById('modal-overlay').classList.add('hidden');
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
const SIM_SPEEDS = [40, 80, 120, 200, 400, 800];

function _bearingBetween([lng1, lat1], [lng2, lat2]) {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function _posAtProgress(prog) {
  if (prog <= 0) return { lngLat: simCoords[0], bearing: 0 };
  if (prog >= simTotalKm) return { lngLat: simCoords[simCoords.length - 1], bearing: 0 };
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
  simMarker.setLngLat(lngLat);
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
    simCumDist.push(simCumDist[i-1] + haversine(simCoords[i-1][1], simCoords[i-1][0], simCoords[i][1], simCoords[i][0]));
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
  simMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(simCoords[0]).addTo(map);
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
  hideOtherRoutes(routeId);
  map.flyTo({ center: simCoords[0], zoom: 15.5, duration: 800 });
  simAnimFrame = requestAnimationFrame(_simTick);
}

function stopSimulation() {
  simActive = false; simPaused = false;
  if (simAnimFrame) { cancelAnimationFrame(simAnimFrame); simAnimFrame = null; }
  if (simMarker) { simMarker.remove(); simMarker = null; }
  document.getElementById('sim-panel')?.classList.add('hidden');
  simCoords = []; simCumDist = []; simTotalKm = 0; simProgress = 0; simLastTs = null;
  showAllRoutes();
  if (simRouteId) showRouteDetail(simRouteId); // restore detail panel
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
let is3D = true;
function toggle3D() {
  const btn = document.getElementById('btn-3d');
  is3D = !is3D;
  map.easeTo({ pitch: is3D ? 55 : 0, duration: 700 });
  btn.classList.toggle('active', is3D);
}

// ── Ride Mode ─────────────────────────────────────
function _rideMarker(label, color) {
  const el = document.createElement('div');
  el.className = 'ride-map-marker';
  el.style.background = color;
  el.innerHTML = `<span>${label}</span>`;
  return el;
}

function _updateRideStep() {
  const msgs = [
    '📍 Tap your pickup point on the map',
    '🏁 Now tap your drop-off point',
    '✓ Fare calculated'
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
      finalLat = snap.lat; finalLng = snap.lng; snapped = true; snapIdx = snap.idx;
    }
  }

  if (isPickup) {
    if (_ridePickupMarker) _ridePickupMarker.remove();
    _ridePickupMarker = new maplibregl.Marker({ element: _rideMarker('A', '#22c55e'), anchor: 'bottom-left' })
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
        marker.setLngLat([snap.lng, snap.lat]);
        _rideDropoffCoords = { lat: snap.lat, lng: snap.lng, snapped: true, snapIdx: snap.idx };
        _setRideAddress('ride-dropoff-addr', `Stop ${snap.idx + 1}`);
        _drawRidePathAlongRoute();
      });
    }
  }

  const address = await getAddressFromCoords(finalLat, finalLng);
  _setRideAddress(isPickup ? 'ride-pickup-addr' : 'ride-dropoff-addr',
    (address || `${finalLat.toFixed(5)}, ${finalLng.toFixed(5)}`) + (snapped ? ' ✓' : ''));
}

function _drawRidePathAlongRoute() {
  if (!_ridePickupCoords || !_rideDropoffCoords || !activeRouteId || !_rideRouteCoords.length) return;
  
  const route = routes.find(r => r.id === activeRouteId);
  if (!route) return;
  
  const allCoords = buildSavedRouteCoords(route);
  const p1Idx = _rideStartIdx;
  const p2Idx = _rideDropoffCoords.snapIdx || 0;
  let fromIdx = Math.min(p1Idx, p2Idx);
  let toIdx = Math.max(p1Idx, p2Idx);
  
  const coords = allCoords.slice(fromIdx, toIdx + 1);
  let distKm = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    distKm += haversine(lat1, lng1, lat2, lng2);
  }
  
  _lastRideDistKm = distKm;
  document.getElementById('ride-dist-val').textContent = `${distKm.toFixed(2)} km`;
  
  const hasDiscount = document.getElementById('ride-discount-cb')?.checked || false;
  const rideVt = routes.find(r => r.id === activeRouteId)?.vehicle_type || 'puj';
  const fare = calcFare(distKm, rideVt);
  const finalFare = hasDiscount ? fare * 0.8 : fare;
  const fareDisplay = hasDiscount
    ? `₱${finalFare.toFixed(2)} <s style="opacity:0.5;font-size:0.7em">₱${fare.toFixed(2)}</s>`
    : `₱${fare.toFixed(2)}`;
  document.getElementById('ride-fare-val').innerHTML = fareDisplay;

  // Draw yellow path
  const geoLine = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
  try { map.removeLayer('ride-ab-glow'); } catch {}
  try { map.removeLayer('ride-ab-line'); } catch {}
  try { map.removeSource('ride-ab-src'); } catch {}
  map.addSource('ride-ab-src', { type: 'geojson', data: geoLine });
  map.addLayer({ id: 'ride-ab-glow', type: 'line', source: 'ride-ab-src',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FACC15', 'line-width': 10, 'line-opacity': 0.5, 'line-blur': 3 }
  });
  map.addLayer({ id: 'ride-ab-line', type: 'line', source: 'ride-ab-src',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#FACC15', 'line-width': 4, 'line-opacity': 1 }
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
      let fromIdx = Math.min(p1Idx, p2Idx);
      let toIdx = Math.max(p1Idx, p2Idx);
      coords = allCoords.slice(fromIdx, toIdx + 1);
      distKm = 0;
      for (let i = 1; i < coords.length; i++) {
        const [lng1, lat1] = coords[i - 1];
        const [lng2, lat2] = coords[i];
        distKm += haversine(lat1, lng1, lat2, lng2);
      }
      console.log('Route-following:', route.name, 'from idx', fromIdx, 'to', toIdx, '=', distKm.toFixed(2), 'km');
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
  try { map.removeLayer('ride-ab-glow'); } catch {}
  try { map.removeLayer('ride-ab-line'); } catch {}
  try { map.removeSource('ride-ab-src'); } catch {}
  
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
    .extend([_ridePickupCoords.lng,  _ridePickupCoords.lat])
    .extend([_rideDropoffCoords.lng, _rideDropoffCoords.lat]);
  map.fitBounds(bounds, { padding: 100, maxZoom: 16, duration: 1000 });
}

function _clearRideRoute() {
  try { map.removeLayer('ride-ab-glow'); } catch {}
  try { map.removeLayer('ride-ab-line'); } catch {}
  try { map.removeSource('ride-ab-src'); } catch {}
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
  if (_ridePickupMarker)  { _ridePickupMarker.remove();  _ridePickupMarker  = null; }
  if (_rideDropoffMarker) { _rideDropoffMarker.remove(); _rideDropoffMarker = null; }
  _ridePickupCoords = null; _rideDropoffCoords = null; _rideStep = 0;
  _rideRouteCoords = []; _rideStartIdx = 0;
  _clearRideRoute();
  _setRideAddress('ride-pickup-addr',  '—');
  _setRideAddress('ride-dropoff-addr', '—');
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
  document.getElementById('btn-ride-mode').classList.add('active');
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
  if (_ridePickupMarker)  { _ridePickupMarker.remove();  _ridePickupMarker  = null; }
  if (_rideDropoffMarker) { _rideDropoffMarker.remove(); _rideDropoffMarker = null; }
  _ridePickupCoords = null; _rideDropoffCoords = null; _rideStep = 0;
  _clearRideRoute();
  map.getCanvas().style.cursor = '';
  document.getElementById('btn-ride-mode').classList.remove('active');
  document.getElementById('ride-panel').classList.add('hidden');
  document.getElementById('ride-fare-card').classList.add('hidden');
  document.getElementById('ride-reset-btn').classList.add('hidden');
  _setRideAddress('ride-pickup-addr',  '—');
  _setRideAddress('ride-dropoff-addr', '—');
}

// ── Event Bindings ────────────────────────────────
function bindEvents() {
  document.getElementById('btn-new-route').addEventListener('click', () => openBuilder());
  document.getElementById('route-search').addEventListener('input', e => renderRouteList(e.target.value));
  document.getElementById('btn-sync-db').addEventListener('click', syncRoutesToDB);
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
    hideRouteDetail(); closeBuilder();
    map.flyTo({ center: MAP_CENTER, zoom: INITIAL_ZOOM, pitch: INITIAL_PITCH, bearing: INITIAL_BEARING, duration: 1200 });
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
  document.getElementById('sim-end-btn').addEventListener('click', stopSimulation);
  document.getElementById('sim-play-pause').addEventListener('click', _simTogglePause);
  document.getElementById('sim-slower').addEventListener('click', () => _simChangeSpeed(-1));
  document.getElementById('sim-faster').addEventListener('click', () => _simChangeSpeed(1));

  document.getElementById('modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-overlay').classList.add('hidden'); pendingDelete = null;
  });
  document.getElementById('modal-confirm').addEventListener('click', doDelete);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target.id === 'modal-overlay') { document.getElementById('modal-overlay').classList.add('hidden'); pendingDelete = null; }
  });

  document.getElementById('rp-bar-save').addEventListener('click', saveReposition);
  document.getElementById('rp-bar-cancel').addEventListener('click', cancelReposition);
  document.getElementById('btn-add-place').addEventListener('click', openPlaceSearch);
  document.getElementById('ps-close').addEventListener('click', closePlaceSearch);
  document.getElementById('ps-search-btn').addEventListener('click', runPlaceSearch);
  document.getElementById('ps-input').addEventListener('keydown', e => { if (e.key === 'Enter') runPlaceSearch(); });
  document.getElementById('ps-save').addEventListener('click', savePlaceToMap);
  document.getElementById('ps-discard').addEventListener('click', discardPlacePreview);

  // Edit-style bar
  document.getElementById('es-bar-save').addEventListener('click', saveEditStyle);
  document.getElementById('es-bar-cancel').addEventListener('click', cancelEditStyle);

  document.getElementById('btn-ride-mode').addEventListener('click', enterRideMode);
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

  document.getElementById('btn-barangays').addEventListener('click', toggleBarangays);
  document.getElementById('btn-landmarks').addEventListener('click', toggleLandmarks);
  document.getElementById('btn-landmark-filter').addEventListener('click', toggleLandmarkFilter);
  document.getElementById('lf-close').addEventListener('click', toggleLandmarkFilter);
  document.getElementById('lf-show-all').addEventListener('click', () => setAllLandmarkCategories(true));
  document.getElementById('lf-hide-all').addEventListener('click', () => setAllLandmarkCategories(false));
  document.getElementById('btn-3d').addEventListener('click', toggle3D);
  document.getElementById('btn-reset').addEventListener('click', () => {
    hideRouteDetail();
    map.flyTo({ center: MAP_CENTER, zoom: INITIAL_ZOOM, pitch: INITIAL_PITCH, bearing: INITIAL_BEARING, duration: 1200 });
  });

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('collapsed');
    document.getElementById('sidebar-toggle').classList.toggle('visible', sb.classList.contains('collapsed'));
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (rideModeActive) { exitRideMode(); return; }
      if (_repositionId) { cancelReposition(); return; }
      if (document.getElementById('place-search-panel').classList.contains('open')) { closePlaceSearch(); return; }
      if (builderOpen) closeBuilder(); else hideRouteDetail();
    }
  });
}

// ── Google Places Search ──────────────────────────
// One Place.searchByText call per explicit search — no autocomplete, no background requests.
let previewMarker = null;
let previewPlace = null;

function openPlaceSearch() {
  if (!window.googlePlacesReady) {
    alert('Google Places is not ready. Check your GOOGLE_PLACES_API_KEY in config.js.');
    return;
  }
  document.getElementById('place-search-panel').classList.add('open');
  setTimeout(() => document.getElementById('ps-input').focus(), 150);
}

function closePlaceSearch() {
  document.getElementById('place-search-panel').classList.remove('open');
  discardPlacePreview();
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

// Fired by button click or Enter — one API call
async function runPlaceSearch() {
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

function _syncCategoryStyle() {
  const cat = document.getElementById('ps-category').value;
  const colorEl = document.getElementById('ps-color-input');
  const iconEl  = document.getElementById('ps-icon-input');
  if (!colorEl.dataset.userSet) colorEl.value = LANDMARK_COLORS[cat] || '#673AB7';
  if (!iconEl.dataset.userSet)  iconEl.value  = LANDMARK_ICONS[cat]  || '';
}

function showPlacePreview(place) {
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
  map.flyTo({ center: [place.lng, place.lat], zoom: 16, pitch: 0, duration: 900 });

  document.getElementById('ps-name').value = place.name;
  document.getElementById('ps-address').textContent = place.address;
  document.getElementById('ps-coords').textContent = `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`;

  document.getElementById('ps-hint').classList.add('hidden');
  document.getElementById('ps-preview').classList.remove('hidden');
}

async function savePlaceToMap() {
  if (!previewPlace) return;
  const name     = document.getElementById('ps-name').value.trim() || previewPlace.name;
  const category = document.getElementById('ps-category').value;
  const btn = document.getElementById('ps-save');

  btn.disabled = true;
  btn.textContent = 'Saving…';
  const ok = await saveLandmarkToDB({ ...previewPlace, name, category });
  btn.disabled = false;

  if (ok) {
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = 'Save to Map'; }, 2000);
    if (previewMarker) { previewMarker.remove(); previewMarker = null; }
    previewPlace = null;
    document.getElementById('ps-preview').classList.add('hidden');
    if (!landmarksVisible) toggleLandmarks();
  } else {
    btn.textContent = 'Save to Map';
  }
}

// ── Utils ─────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
