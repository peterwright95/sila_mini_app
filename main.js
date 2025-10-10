import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fromUrl, fromArrayBuffer } from 'geotiff';
import proj4 from 'proj4';

// Discover rasters dynamically from server
const RASTER_DIR = import.meta.env.VITE_RASTER_DIR || undefined; // optional override
const FORCE_EPSG = import.meta.env.VITE_FORCE_EPSG ? Number(import.meta.env.VITE_FORCE_EPSG) : undefined; // e.g., 4326
let rasters = [];
const geoCache = new Map();
const activeOverlayDates = new Set();
const cachedBasemapDates = new Set();
const rasterCheckboxes = new Map();
const PARK_BOUNDS = L.latLngBounds([38.9, 16.2], [39.7, 17.1]);
const DEFAULT_RASTER_ISO = undefined;
let fallbackBaseDate = new Date().toISOString().slice(0, 10);
let baseLayerDate = fallbackBaseDate;
let baseLayer;
const loadingOverlay = document.getElementById('loadingOverlay');
let loadingCounter = 0;
const brandLogo = document.getElementById('brandLogo');
const areaPanelEl = document.getElementById('areasPanel');
const toggleAreasBtn = document.getElementById('toggleAreas');
const closeAreasBtn = document.getElementById('closeAreas');
const areasListEl = document.getElementById('areasList');
const areaDrawStartBtn = document.getElementById('areaDrawStart');
const areaDrawFinishBtn = document.getElementById('areaDrawFinish');
const areaDrawCancelBtn = document.getElementById('areaDrawCancel');
const areaDrawHelpEl = document.getElementById('areaDrawHelp');
const areaModules = import.meta.glob('./areas/*.geojson', { eager: true, import: 'default', query: '?raw' });
const areaDefinitions = Object.entries(areaModules).map(([path, raw]) => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn('Failed to parse area GeoJSON', path, err);
    data = null;
  }
  const fileName = path.split('/').pop() || 'Area';
  const baseName = fileName.replace(/\.geojson$/i, '');
  const id = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id,
    label: baseName,
    fileName,
    data,
    isCustom: false
  };
}).filter(area => area.data && typeof area.data === 'object').sort((a, b) => a.label.localeCompare(b.label));
const areaDefinitionById = new Map(areaDefinitions.map(area => [area.id, area]));
const areaLayers = new Map();
const CUSTOM_AREA_STORAGE_KEY = 'sila_custom_areas_v1';
let activeAreaId = null;
let customAreaSequence = 1;
let currentDrawingArea = null;
const defaultAreaDrawHelpText = areaDrawHelpEl?.textContent ?? '';
let areaDrawHelpTimeout = null;

const storedCustomAreas = loadStoredCustomAreas();
if (Array.isArray(storedCustomAreas) && storedCustomAreas.length) {
  storedCustomAreas.forEach((area) => {
    if (!area || !area.id || areaDefinitionById.has(area.id)) return;
    area.isCustom = true;
    areaDefinitions.push(area);
    areaDefinitionById.set(area.id, area);
  });
  sortAreaDefinitions();
  customAreaSequence = Math.max(customAreaSequence, storedCustomAreas.length + 1);
}

const areaDefaultStyle = {
  color: '#2a6fdb',
  weight: 2,
  opacity: 0.85,
  dashArray: '6 4',
  fillColor: '#2a6fdb',
  fillOpacity: 0.08
};

const areaSelectedStyle = {
  color: '#1c4e9f',
  weight: 3,
  opacity: 1,
  dashArray: null,
  fillColor: '#2a6fdb',
  fillOpacity: 0.22
};

function setAreaDrawHelp(text, { temporary = false, duration = 3200 } = {}) {
  if (!areaDrawHelpEl) return;
  if (temporary) {
    if (areaDrawHelpTimeout) window.clearTimeout(areaDrawHelpTimeout);
    areaDrawHelpEl.textContent = text;
    areaDrawHelpTimeout = window.setTimeout(() => {
      areaDrawHelpEl.textContent = defaultAreaDrawHelpText;
      areaDrawHelpTimeout = null;
    }, duration);
  } else {
    if (areaDrawHelpTimeout) {
      window.clearTimeout(areaDrawHelpTimeout);
      areaDrawHelpTimeout = null;
    }
    areaDrawHelpEl.textContent = text;
  }
}

function resetAreaDrawHelp() {
  if (!areaDrawHelpEl) return;
  setAreaDrawHelp(defaultAreaDrawHelpText);
}

function sortAreaDefinitions() {
  areaDefinitions.sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeCustomAreaEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null;
  const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : null;
  const data = entry.data && typeof entry.data === 'object' ? entry.data : null;
  if (!id || !label || !data) return null;
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) return null;
  return {
    id,
    label,
    fileName: `${id}.geojson`,
    data,
    isCustom: true
  };
}

function loadStoredCustomAreas() {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_AREA_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeCustomAreaEntry).filter(Boolean);
  } catch (err) {
    console.warn('Failed to load custom areas', err);
    return [];
  }
}

function persistCustomAreas() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const payload = areaDefinitions
      .filter(area => area.isCustom)
      .map(area => ({
        id: area.id,
        label: area.label,
        data: area.data
      }));
    window.localStorage.setItem(CUSTOM_AREA_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('Failed to save custom areas', err);
  }
}

function updateAreaDrawFinishAvailability() {
  if (!areaDrawFinishBtn) return;
  if (!currentDrawingArea) {
    areaDrawFinishBtn.disabled = true;
    return;
  }
  const ready = currentDrawingArea.vertices.length >= 3;
  areaDrawFinishBtn.disabled = !ready;
}

function setAreaDrawControlsState(mode) {
  const active = mode === 'active';
  if (areaDrawStartBtn) areaDrawStartBtn.disabled = active;
  if (areaDrawCancelBtn) areaDrawCancelBtn.disabled = !active;
  if (active) {
    updateAreaDrawFinishAvailability();
  } else if (areaDrawFinishBtn) {
    areaDrawFinishBtn.disabled = true;
  }
}

function stopAreaDrawingInteraction({ keepHelp = false } = {}) {
  if (!currentDrawingArea) {
    if (!keepHelp) resetAreaDrawHelp();
    setAreaDrawControlsState('idle');
    return;
  }
  map.off('click', handleDrawingClick);
  map.off('mousemove', handleDrawingMouseMove);
  map.off('dblclick', handleDrawingDoubleClick);
  if (currentDrawingArea.layerGroup) {
    map.removeLayer(currentDrawingArea.layerGroup);
  }
  if (currentDrawingArea.doubleClickZoomWasEnabled && map.doubleClickZoom && map.doubleClickZoom.enable) {
    map.doubleClickZoom.enable();
  }
  map.getContainer().style.cursor = '';
  currentDrawingArea = null;
  if (!keepHelp) resetAreaDrawHelp();
  setAreaDrawControlsState('idle');
  updateAreaDrawFinishAvailability();
}

function refreshDrawingPreview(previewLatLng) {
  if (!currentDrawingArea) return;
  const previewPoints = currentDrawingArea.vertices.slice();
  if (previewLatLng && previewPoints.length) {
    previewPoints.push(previewLatLng);
  }
  currentDrawingArea.previewLine.setLatLngs(previewPoints);
  if (currentDrawingArea.vertices.length >= 3) {
    currentDrawingArea.polygon.setLatLngs([currentDrawingArea.vertices]);
  } else {
    currentDrawingArea.polygon.setLatLngs([]);
  }
}

function addDrawingVertex(latlng) {
  if (!currentDrawingArea) return;
  currentDrawingArea.vertices.push(latlng);
  const marker = L.circleMarker(latlng, {
    radius: 5,
    color: areaSelectedStyle.color,
    weight: 2,
    fillColor: '#fff',
    fillOpacity: 0.9,
    interactive: false
  });
  currentDrawingArea.layerGroup.addLayer(marker);
  refreshDrawingPreview(null);
  updateAreaDrawFinishAvailability();
}

function handleDrawingClick(event) {
  if (!currentDrawingArea || !event?.latlng) return;
  const detail = event.originalEvent?.detail;
  if (Number.isFinite(detail) && detail > 1) return;
  addDrawingVertex(event.latlng);
}

function handleDrawingMouseMove(event) {
  if (!currentDrawingArea || !event?.latlng) return;
  if (!currentDrawingArea.vertices.length) return;
  refreshDrawingPreview(event.latlng);
}

function handleDrawingDoubleClick(event) {
  if (!currentDrawingArea) return;
  if (event?.originalEvent) {
    L.DomEvent.stop(event.originalEvent);
  }
  refreshDrawingPreview(null);
  finishAreaDrawing();
}

function startAreaDrawing() {
  stopAreaDrawingInteraction({ keepHelp: false });
  const layerGroup = L.layerGroup().addTo(map);
  const previewLine = L.polyline([], {
    color: areaSelectedStyle.color,
    weight: 2,
    dashArray: '6 6',
    opacity: 0.85,
    interactive: false
  });
  const polygon = L.polygon([], {
    color: areaSelectedStyle.color,
    weight: 2,
    dashArray: '4 4',
    fillColor: areaSelectedStyle.fillColor,
    fillOpacity: 0.18,
    opacity: 0.9,
    interactive: false
  });
  layerGroup.addLayer(previewLine);
  layerGroup.addLayer(polygon);

  const doubleClickZoomHandler = map.doubleClickZoom;
  const doubleClickZoomWasEnabled = !!(doubleClickZoomHandler && doubleClickZoomHandler.enabled());
  if (doubleClickZoomWasEnabled) {
    doubleClickZoomHandler.disable();
  }

  currentDrawingArea = {
    vertices: [],
    layerGroup,
    polygon,
    previewLine,
    doubleClickZoomWasEnabled
  };

  map.on('click', handleDrawingClick);
  map.on('mousemove', handleDrawingMouseMove);
  map.on('dblclick', handleDrawingDoubleClick);
  map.getContainer().style.cursor = 'crosshair';

  setAreaDrawControlsState('active');
  setAreaDrawHelp('Drawing mode: click to add vertices, double-click or press Finish to save.');
  updateAreaDrawFinishAvailability();
}

function generateUniqueAreaId(label) {
  const base = (label || 'area').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'area';
  let candidate = base;
  let suffix = 1;
  while (areaDefinitionById.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function finishAreaDrawing() {
  if (!currentDrawingArea) return;
  if (currentDrawingArea.vertices.length < 3) {
    setAreaDrawHelp('Add at least three points to complete the area.', { temporary: true, duration: 3000 });
    return;
  }

  const coords = currentDrawingArea.vertices.map((vertex) => [Number(vertex.lng), Number(vertex.lat)]);
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    coords.push([...first]);
  }

  const defaultLabel = `Custom area ${customAreaSequence}`;
  const inputLabel = window.prompt('Name for the new area:', defaultLabel);
  const label = (inputLabel && inputLabel.trim()) ? inputLabel.trim() : defaultLabel;
  customAreaSequence += 1;
  const id = generateUniqueAreaId(label);
  const feature = {
    type: 'Feature',
    properties: {
      name: label,
      source: 'custom',
      createdAt: new Date().toISOString()
    },
    geometry: {
      type: 'Polygon',
      coordinates: [coords]
    }
  };
  const newArea = {
    id,
    label,
    fileName: `${id}.geojson`,
    data: {
      type: 'FeatureCollection',
      features: [feature]
    },
    isCustom: true
  };

  areaDefinitions.push(newArea);
  areaDefinitionById.set(id, newArea);
  sortAreaDefinitions();
  registerArea(newArea);
  persistCustomAreas();
  stopAreaDrawingInteraction({ keepHelp: true });
  setActiveArea(id);
  openAreasPanel(true);
  setAreaDrawHelp(`Area "${label}" added and selected.`, { temporary: true, duration: 3600 });
}

function cancelAreaDrawing() {
  if (!currentDrawingArea) {
    resetAreaDrawHelp();
    setAreaDrawControlsState('idle');
    return;
  }
  stopAreaDrawingInteraction({ keepHelp: true });
  setAreaDrawHelp('Drawing cancelled.', { temporary: true, duration: 2600 });
}

function deleteCustomArea(id) {
  if (!id) return;
  const area = areaDefinitionById.get(id);
  if (!area || !area.isCustom) return;
  const confirmed = window.confirm(`Delete custom area "${area.label}"?`);
  if (!confirmed) return;

  const index = areaDefinitions.findIndex(entry => entry.id === id);
  if (index !== -1) {
    areaDefinitions.splice(index, 1);
  }
  areaDefinitionById.delete(id);

  const entry = areaLayers.get(id);
  if (entry) {
    if (entry.layer && map.hasLayer(entry.layer)) {
      map.removeLayer(entry.layer);
    }
    areaLayers.delete(id);
  }

  sortAreaDefinitions();
  persistCustomAreas();

  if (activeAreaId === id) {
    setActiveArea(null);
  } else {
    renderAreaList();
  }

  setAreaDrawHelp(`Area "${area.label}" deleted.`, { temporary: true, duration: 2600 });
}

function pushLoading() {
  loadingCounter += 1;
  if (loadingOverlay) {
    loadingOverlay.classList.add('visible');
  }
}

function popLoading() {
  loadingCounter = Math.max(0, loadingCounter - 1);
  if (loadingOverlay && loadingCounter === 0) {
    loadingOverlay.classList.remove('visible');
  }
}

function updateBrandLogo() {
  if (!brandLogo) return;
  if (activeOverlayDates.size > 0) {
    brandLogo.classList.add('overlay-active');
  } else {
    brandLogo.classList.remove('overlay-active');
  }
}

function formatDisplayDate(iso) {
  if (!iso) return undefined;
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d}-${m}-${y}`;
}

function formatRasterLabel(fileName) {
  const base = fileName.replace(/\.(tif|tiff)$/i, '');
  const iso = extractIsoDate(fileName);
  const display = formatDisplayDate(iso);
  if (display) return display;
  return base.replace(/_/g, ' ');
}

function normalizeDate(date) {
  if (!date) return undefined;
  const trimmed = date.slice(0, 10);
  return trimmed.replace(/[^0-9-]/g, '');
}

async function loadGeoTiff(path) {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`Failed to fetch GeoTIFF (${res.status} ${res.statusText})`);
  }
  const buffer = await res.arrayBuffer();
  return await fromArrayBuffer(buffer);
}

async function renderRasterToCanvas({ data, width, height, noData, ctx }) {
  const imgData = ctx.createImageData(width, height);
  const total = data.length;
  const chunkSize = 500_000; // process in blocks to keep UI responsive
  let idx = 0;
  while (idx < total) {
    const end = Math.min(idx + chunkSize, total);
    for (; idx < end; idx++) {
      const v = data[idx];
      const o = idx * 4;
      if (v == null || Number.isNaN(v) || v === noData) {
        imgData.data[o+3] = 0;
        continue;
      }
      const [r,g,b,a] = rampColor(v);
      imgData.data[o] = r; imgData.data[o+1] = g; imgData.data[o+2] = b; imgData.data[o+3] = a;
    }
    await new Promise(requestAnimationFrame);
  }
  ctx.putImageData(imgData, 0, 0);
}

async function computeValueRange(data, noData) {
  let obsMin = Infinity;
  let obsMax = -Infinity;
  const chunkSize = 500_000;
  let idx = 0;
  while (idx < data.length) {
    const end = Math.min(idx + chunkSize, data.length);
    for (let i = idx; i < end; i++) {
      const v = data[i];
      if (v == null || Number.isNaN(v) || v === noData) continue;
      if (v < obsMin) obsMin = v;
      if (v > obsMax) obsMax = v;
    }
    idx = end;
    if (idx < data.length) await new Promise(requestAnimationFrame);
  }
  if (!Number.isFinite(obsMin)) obsMin = 0;
  if (!Number.isFinite(obsMax)) obsMax = 1;
  return { obsMin, obsMax };
}

const NASA_TILE_TEMPLATE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg';

function remoteBasemapUrl(date, coords) {
  const safe = normalizeDate(date || fallbackBaseDate || baseLayerDate);
  return NASA_TILE_TEMPLATE
    .replace('{date}', safe)
    .replace('{z}', String(coords.z))
    .replace('{y}', String(coords.y))
    .replace('{x}', String(coords.x));
}

function localBasemapUrl(date, coords) {
  const safe = normalizeDate(date || baseLayerDate);
  return `/basemap/${safe}/${coords.z}/${coords.x}/${coords.y}.png`;
}

function setBaseLayerDate(date) {
  const safe = normalizeDate(date || fallbackBaseDate || baseLayerDate);
  if (!safe) return;
  baseLayerDate = safe;
  if (baseLayer && typeof baseLayer.setDate === 'function') {
    baseLayer.setDate(safe);
  }
}

function updateBaseLayerDate() {
  if (activeOverlayDates.size > 0) {
    const sorted = Array.from(activeOverlayDates).sort();
    const latest = sorted[sorted.length - 1];
    setBaseLayerDate(latest);
  } else {
    setBaseLayerDate(fallbackBaseDate);
  }
}

const CachedBasemapLayer = L.TileLayer.extend({
  initialize(options = {}) {
    const opts = {
      minZoom: 0,
      maxZoom: 9,
      tileSize: 256,
      crossOrigin: 'anonymous',
      attribution: 'Imagery © NASA Blue Marble, MODIS, and VIIRS, hosted by NASA GIBS',
      ...options
    };
    L.TileLayer.prototype.initialize.call(this, '', opts);
    this._currentDate = normalizeDate(options.date) || normalizeDate(fallbackBaseDate);
  },

  setDate(date) {
    const iso = normalizeDate(date || fallbackBaseDate || this._currentDate);
    if (!iso || iso === this._currentDate) return;
    this._currentDate = iso;
    this.redraw();
  },

  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');
    if (this.options.crossOrigin) tile.crossOrigin = this.options.crossOrigin;
    L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
    L.DomEvent.on(tile, 'error', () => this._handleTileError(done, tile, coords));
    this._setTileSrc(tile, coords, false);
    return tile;
  },

  _setTileSrc(tile, coords, forceRemote) {
    const iso = normalizeDate(this._currentDate || baseLayerDate || fallbackBaseDate);
    if (!forceRemote && iso && cachedBasemapDates.has(iso)) {
      tile.dataset.retry = 'local';
      tile.src = localBasemapUrl(iso, coords);
    } else {
      tile.dataset.retry = 'remote';
      tile.src = remoteBasemapUrl(iso, coords);
    }
  },

  _handleTileError(done, tile, coords) {
    const retry = tile.dataset.retry;
    if (retry === 'local') {
      tile.dataset.retry = 'remote';
      tile.src = remoteBasemapUrl(this._currentDate || baseLayerDate || fallbackBaseDate, coords);
    } else {
      tile.dataset.retry = 'failed';
      this._tileOnError(done, tile, coords);
    }
  }
});

function extractIsoDate(fileName) {
  const base = fileName.replace(/\.(tif|tiff)$/i, '');
  const match = base.match(/20\d{6}/);
  if (!match) return undefined;
  const dateStr = match[0];
  return `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
}

const sidebarEl = document.getElementById('sidebar');
const toggleBtn = document.getElementById('toggleSidebar');
const closeBtn = document.getElementById('closeSidebar');
const layersEl = document.getElementById('layers');

function openSidebar(open) {
  sidebarEl.classList.toggle('open', open);
}

toggleBtn.addEventListener('click', () => openSidebar(!sidebarEl.classList.contains('open')));
closeBtn.addEventListener('click', () => openSidebar(false));

function openAreasPanel(open) {
  if (!areaPanelEl) return;
  areaPanelEl.classList.toggle('open', open);
}

if (toggleAreasBtn) {
  toggleAreasBtn.addEventListener('click', () => {
    const shouldOpen = !areaPanelEl?.classList.contains('open');
    openAreasPanel(shouldOpen);
  });
}

if (closeAreasBtn) {
  closeAreasBtn.addEventListener('click', () => openAreasPanel(false));
}

if (areaDrawStartBtn) {
  areaDrawStartBtn.addEventListener('click', () => {
    openAreasPanel(true);
    startAreaDrawing();
  });
}
if (areaDrawFinishBtn) {
  areaDrawFinishBtn.addEventListener('click', () => finishAreaDrawing());
}
if (areaDrawCancelBtn) {
  areaDrawCancelBtn.addEventListener('click', () => cancelAreaDrawing());
}

setAreaDrawControlsState('idle');
updateAreaDrawFinishAvailability();

function renderAreaList() {
  if (!areasListEl) return;
  areasListEl.textContent = '';
  if (!areaDefinitions.length) {
    const msg = document.createElement('p');
    msg.textContent = 'No areas available.';
    msg.style.fontSize = '13px';
    msg.style.color = '#616e7c';
    msg.style.margin = '0';
    areasListEl.appendChild(msg);
    return;
  }

  const optionAll = document.createElement('label');
  optionAll.className = 'areas-option';
  const radioAll = document.createElement('input');
  radioAll.type = 'radio';
  radioAll.name = 'areaSelection';
  radioAll.value = '';
  radioAll.checked = !activeAreaId;
  radioAll.addEventListener('change', () => {
    if (!radioAll.checked) return;
    setActiveArea(null, { focus: false });
  });
  const metaAll = document.createElement('div');
  metaAll.className = 'areas-meta';
  const strongAll = document.createElement('strong');
  strongAll.textContent = 'All areas';
  const spanAll = document.createElement('span');
  spanAll.textContent = 'Show full raster extent';
  metaAll.appendChild(strongAll);
  metaAll.appendChild(spanAll);
  optionAll.appendChild(radioAll);
  optionAll.appendChild(metaAll);
  areasListEl.appendChild(optionAll);

  areaDefinitions.forEach((area) => {
    const option = document.createElement('label');
    option.className = 'areas-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'areaSelection';
    radio.value = area.id;
    radio.checked = activeAreaId === area.id;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setActiveArea(area.id);
    });
    const meta = document.createElement('div');
    meta.className = 'areas-meta';
    const strong = document.createElement('strong');
    strong.textContent = area.label;
    meta.appendChild(strong);
    const span = document.createElement('span');
    span.textContent = 'Focus map & filter rasters';
    meta.appendChild(span);
    option.appendChild(radio);
    option.appendChild(meta);
    if (area.isCustom) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'delete-area-btn';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        deleteCustomArea(area.id);
      });
      option.appendChild(deleteBtn);
    }
    areasListEl.appendChild(option);
  });
}

function registerArea(area) {
  if (!area || !area.id || !area.data) return;
  if (areaLayers.has(area.id)) return;
  const layer = L.geoJSON(area.data, {
    style: () => ({ ...areaDefaultStyle }),
    onEachFeature: (_feature, layerInstance) => {
      layerInstance.on('click', () => {
        setActiveArea(area.id, { focus: false });
      });
    }
  });
  layer.setStyle(areaDefaultStyle);
  const bounds = layer.getBounds && layer.getBounds();
  areaLayers.set(area.id, { layer, bounds });
}

// Base map: NASA GIBS daily MODIS Terra imagery, date-driven
const map = L.map('map', {
  center: [39.2, 16.6],
  zoom: 9,
  worldCopyJump: true,
  maxBounds: PARK_BOUNDS.pad(1.0)
});

L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  minZoom: 0,
  maxZoom: 19,
  attribution: 'Tiles © Esri, Maxar, Earthstar Geographics, GIS User Community'
}).addTo(map);

map.fitBounds(PARK_BOUNDS.pad(0.5));

function initializeAreas() {
  areaDefinitions.forEach(registerArea);
  renderAreaList();
}

function applyAreaMaskForEntry(entry, { force = false } = {}) {
  if (!entry || !entry.layer || !entry.canvas) return;
  const { canvas, layer, bounds } = entry;
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return;

  const area = activeAreaId ? areaDefinitionById.get(activeAreaId) : null;
  const maskKey = area ? area.id : 'ALL';
  if (!force && entry.lastMaskKey === maskKey) return;
  if (!area) {
    const baseUrl = canvas.toDataURL('image/png');
    if (layer.setUrl) layer.setUrl(baseUrl);
    entry.lastMaskKey = maskKey;
    return;
  }

  if (!bounds || !bounds.isValid || !bounds.isValid()) {
    const baseUrl = canvas.toDataURL('image/png');
    if (layer.setUrl) layer.setUrl(baseUrl);
    entry.lastMaskKey = maskKey;
    return;
  }

  const northWest = bounds.getNorthWest();
  const southEast = bounds.getSouthEast();
  const nwProj = map.options.crs.project(northWest);
  const seProj = map.options.crs.project(southEast);
  const widthWorld = seProj.x - nwProj.x;
  const heightWorld = nwProj.y - seProj.y;
  if (!Number.isFinite(widthWorld) || !Number.isFinite(heightWorld) || Math.abs(widthWorld) < 1e-6 || Math.abs(heightWorld) < 1e-6) {
    const baseUrl = canvas.toDataURL('image/png');
    if (layer.setUrl) layer.setUrl(baseUrl);
    entry.lastMaskKey = maskKey;
    return;
  }

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = maskCanvas.getContext('2d');
  if (!maskCtx) {
    const baseUrl = canvas.toDataURL('image/png');
    if (layer.setUrl) layer.setUrl(baseUrl);
    entry.lastMaskKey = maskKey;
    return;
  }

  maskCtx.imageSmoothingEnabled = true;
  maskCtx.drawImage(canvas, 0, 0);
  maskCtx.globalCompositeOperation = 'destination-in';
  maskCtx.beginPath();

  const toCanvas = (lon, lat) => {
    const projected = map.options.crs.project(L.latLng(lat, lon));
    const x = ((projected.x - nwProj.x) / widthWorld) * width;
    const y = ((nwProj.y - projected.y) / heightWorld) * height;
    return [x, y];
  };

  const drawRing = (ring) => {
    if (!Array.isArray(ring) || ring.length === 0) return;
    ring.forEach((coord, idx) => {
      if (!Array.isArray(coord) || coord.length < 2) return;
      const lon = Number(coord[0]);
      const lat = Number(coord[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      const [x, y] = toCanvas(lon, lat);
      if (idx === 0) {
        maskCtx.moveTo(x, y);
      } else {
        maskCtx.lineTo(x, y);
      }
    });
    maskCtx.closePath();
  };

  let hasPath = false;
  const features = Array.isArray(area?.data?.features) ? area.data.features : [];
  features.forEach((feature) => {
    const geom = feature?.geometry;
    if (!geom) return;
    if (geom.type === 'Polygon') {
      const rings = Array.isArray(geom.coordinates) ? geom.coordinates : [];
      rings.forEach((ring) => { drawRing(ring); hasPath = true; });
    } else if (geom.type === 'MultiPolygon') {
      const polys = Array.isArray(geom.coordinates) ? geom.coordinates : [];
      polys.forEach((poly) => {
        const rings = Array.isArray(poly) ? poly : [];
        rings.forEach((ring) => { drawRing(ring); hasPath = true; });
      });
    }
  });

  if (!hasPath) {
    const baseUrl = canvas.toDataURL('image/png');
    if (layer.setUrl) layer.setUrl(baseUrl);
    entry.lastMaskKey = maskKey;
    return;
  }

  maskCtx.fill('evenodd');
  maskCtx.globalCompositeOperation = 'source-over';
  const url = maskCanvas.toDataURL('image/png');
  if (layer.setUrl) layer.setUrl(url);
  entry.lastMaskKey = maskKey;
}

function applyAreaMask() {
  overlayState.forEach((entry) => applyAreaMaskForEntry(entry));
}

function setActiveArea(id, { focus = true } = {}) {
  const normalized = id && areaLayers.has(id) ? id : null;
  if (activeAreaId === normalized) {
    if (focus && normalized) {
      const entry = areaLayers.get(normalized);
      if (entry?.bounds && entry.bounds.isValid && entry.bounds.isValid()) {
        try { map.fitBounds(entry.bounds.pad(0.05)); } catch (_) {}
      }
    }
    return;
  }

  activeAreaId = normalized;
  areaLayers.forEach((entry, key) => {
    if (!entry?.layer) return;
    if (key === normalized) {
      entry.layer.setStyle(areaSelectedStyle);
      if (!map.hasLayer(entry.layer)) entry.layer.addTo(map);
      if (entry.layer.bringToFront) entry.layer.bringToFront();
    } else {
      entry.layer.setStyle(areaDefaultStyle);
      if (map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
    }
  });

  renderAreaList();
  if (normalized && focus) {
    const entry = areaLayers.get(normalized);
    if (entry?.bounds && entry.bounds.isValid && entry.bounds.isValid()) {
      try { map.fitBounds(entry.bounds.pad(0.08)); } catch (_) {}
    }
  }
  if (!normalized) {
    areaLayers.forEach((entry) => {
      if (!entry?.layer) return;
      if (map.hasLayer(entry.layer)) map.removeLayer(entry.layer);
      entry.layer.setStyle(areaDefaultStyle);
    });
  }
  applyAreaMask();
}

initializeAreas();

// Keep references to overlay layers and raw data for re-render
const overlayState = new Map(); // key: url path, value: { layer, canvas, ctx, data, width, height, noData, bounds, added }
let currentRamp = 'grayscale';
let smoothing = true; // default to smooth

// Minimal EPSG support helper: auto-define common UTM codes for proj4
function ensureProjDef(epsgCode) {
  if (!Number.isFinite(epsgCode)) return false;
  const code = Number(epsgCode);
  const key = `EPSG:${code}`;
  try {
    // If already defined, proj4 will return a projection object
    // Attempt a no-op transform to test definition availability
    proj4(key, 'EPSG:4326', [0, 0]);
    return true;
  } catch (_) {
    // Try to define common UTM zones
    const north = code >= 32601 && code <= 32660; // UTM WGS84 North
    const south = code >= 32701 && code <= 32760; // UTM WGS84 South
    if (north || south) {
      const zone = (north ? code - 32600 : code - 32700);
      const def = `+proj=utm +zone=${zone} +datum=WGS84 ${south ? '+south ' : ''}+units=m +no_defs +type=crs`;
      proj4.defs(key, def);
      try { proj4(key, 'EPSG:4326', [0, 0]); return true; } catch { return false; }
    }
    // Add more known projections here if needed
    return false;
  }
}

function computeGeoReference(image) {
  const width = image.getWidth();
  const height = image.getHeight();
  const geoKeys = image.getGeoKeys?.() || {};
  const fd = (typeof image.getFileDirectory === 'function') ? image.getFileDirectory() : {};
  const modelType = geoKeys.GTModelTypeGeoKey;
  let projCode;
  if (Number.isFinite(FORCE_EPSG)) {
    projCode = FORCE_EPSG;
  } else if (modelType === 2 && Number.isFinite(geoKeys.GeographicTypeGeoKey)) {
    projCode = geoKeys.GeographicTypeGeoKey;
  } else if (modelType === 1 && Number.isFinite(geoKeys.ProjectedCSTypeGeoKey)) {
    projCode = geoKeys.ProjectedCSTypeGeoKey;
  } else {
    projCode = geoKeys.GeographicTypeGeoKey ?? geoKeys.ProjectedCSTypeGeoKey;
  }
  const rasterType = geoKeys.GTRasterTypeGeoKey || geoKeys.RasterTypeGeoKey; // 1=PixelIsArea, 2=PixelIsPoint
  const transform = Array.isArray(fd?.ModelTransformation) ? fd.ModelTransformation : null;
  const ties = (typeof image.getTiePoints === 'function') ? image.getTiePoints() : [];
  const scale = fd && Array.isArray(fd.ModelPixelScale) ? fd.ModelPixelScale : null;

  let bbox;
  const libBB = image.getBoundingBox?.();
  if (libBB && libBB.every(v => Number.isFinite(v))) {
    if (rasterType === 2 && Array.isArray(fd?.ModelPixelScale)) {
      const sx = Math.abs(Number(fd.ModelPixelScale[0]) || 0);
      const sy = Math.abs(Number(fd.ModelPixelScale[1]) || 0);
      if (sx > 0 && sy > 0) {
        bbox = [libBB[0] - sx/2, libBB[1] - sy/2, libBB[2] + sx/2, libBB[3] + sy/2];
      } else {
        bbox = libBB;
      }
    } else {
      bbox = libBB;
    }
  } else if (transform && transform.length === 16) {
    const M = transform;
    const half = (rasterType === 2) ? 0.5 : 0.0;
    const corners = [
      [-half, -half],
      [width - half, -half],
      [width - half, height - half],
      [-half, height - half]
    ];
    const tf = (i, j) => {
      const x = M[0]*i + M[1]*j + M[3];
      const y = M[4]*i + M[5]*j + M[7];
      const w = M[12]*i + M[13]*j + M[15];
      return [x/(w||1), y/(w||1)];
    };
    const pts = corners.map(([i,j]) => tf(i, j));
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  } else if (Array.isArray(ties) && ties.length > 0 && scale && scale.length >= 2) {
    const t = ties[0];
    const i0 = Number.isFinite(t.i) ? t.i : 0;
    const j0 = Number.isFinite(t.j) ? t.j : 0;
    const X0 = Number.isFinite(t.x) ? t.x : 0;
    const Y0 = Number.isFinite(t.y) ? t.y : 0;
    const sx = Number(scale[0]) || 1;
    const sy = Number(scale[1]) || 1;
    const half = (rasterType === 2) ? 0.5 : 0.0;
    const corners = [
      [-half, -half],
      [width - half, -half],
      [width - half, height - half],
      [-half, height - half]
    ];
    const world = (i, j) => [
      X0 + (i - i0) * sx,
      Y0 - (j - j0) * sy
    ];
    const pts = corners.map(([i,j]) => world(i, j));
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  } else {
    bbox = [-0.5, -0.5, 0.5, 0.5];
  }

  let bounds;
  let projectionDefined = false;
  let lonMin;
  let lonMax;
  let latMin;
  let latMax;
  if (projCode && Number.isFinite(projCode) && projCode !== 4326) {
    const hasDef = ensureProjDef(projCode);
    projectionDefined = hasDef;
    if (hasDef) {
      const src = `EPSG:${projCode}`;
      const half = (rasterType === 2) ? 0.5 : 0.0;
      const pxCorners = [
        [-half, -half],
        [width - half, -half],
        [width - half, height - half],
        [-half, height - half]
      ];
      const worldFromPixel = (i, j) => {
        if (transform && transform.length === 16) {
          const M = transform;
          const x = M[0]*i + M[1]*j + M[3];
          const y = M[4]*i + M[5]*j + M[7];
          const w = M[12]*i + M[13]*j + M[15];
          return [x/(w||1), y/(w||1)];
        } else if (Array.isArray(ties) && ties.length > 0 && scale && scale.length >= 2) {
          const t = ties[0];
          const i0 = Number.isFinite(t.i) ? t.i : 0;
          const j0 = Number.isFinite(t.j) ? t.j : 0;
          const X0 = Number.isFinite(t.x) ? t.x : bbox[0];
          const Y0 = Number.isFinite(t.y) ? t.y : bbox[3];
          const sx = Number(scale[0]) || ((bbox[2]-bbox[0]) / width);
          const sy = Number(scale[1]) || ((bbox[3]-bbox[1]) / height);
          const X = X0 + (i - i0) * sx;
          const Y = Y0 - (j - j0) * sy;
          return [X, Y];
        }
        const X = bbox[0] + (i / width) * (bbox[2] - bbox[0]);
        const Y = bbox[3] - (j / height) * (bbox[3] - bbox[1]);
        return [X, Y];
      };
      const llPts = pxCorners.map(([i, j]) => {
        const [X, Y] = worldFromPixel(i, j);
        const [lon, lat] = proj4(src, 'EPSG:4326', [X, Y]);
        return [lon, lat];
      });
      const lons = llPts.map(p => p[0]);
      const lats = llPts.map(p => p[1]);
      lonMin = Math.min(...lons);
      lonMax = Math.max(...lons);
      latMin = Math.min(...lats);
      latMax = Math.max(...lats);
      bounds = L.latLngBounds([latMin, lonMin], [latMax, lonMax]);
    } else {
      bounds = L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]);
      lonMin = bounds.getWest();
      lonMax = bounds.getEast();
      latMin = bounds.getSouth();
      latMax = bounds.getNorth();
    }
  } else {
    bounds = L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]);
    lonMin = bounds.getWest();
    lonMax = bounds.getEast();
    latMin = bounds.getSouth();
    latMax = bounds.getNorth();
  }

  return {
    width,
    height,
    geoKeys,
    fileDirectory: fd,
    projCode,
    projectionDefined,
    rasterType,
    transform,
    ties,
    scale,
    bbox,
    bounds,
    lonMin,
    lonMax,
    latMin,
    latMax
  };
}

async function loadRasterList() {
  let json;
  if (import.meta.env.PROD) {
    const res = await fetch('/rasters/manifest.json');
    if (!res.ok) throw new Error('Failed to load raster manifest');
    json = await res.json();
  } else {
    const params = new URLSearchParams();
    if (RASTER_DIR) params.set('dir', RASTER_DIR);
    const res = await fetch(`/api/rasters?${params.toString()}`);
    if (!res.ok) throw new Error('Failed to list rasters');
    json = await res.json();
  }

  const baseDir = json?.dir || (import.meta.env.PROD ? 'rasters' : undefined);
  const items = Array.isArray(json?.items) ? json.items : [];
  rasters = items.map(it => {
    const isoDate = extractIsoDate(it.file);
    return {
      label: formatRasterLabel(it.file),
      file: it.file,
      dir: baseDir,
      isoDate,
      displayDate: formatDisplayDate(isoDate)
    };
  });
  const isoDates = rasters.map(r => r.isoDate).filter(Boolean).sort();
  if (isoDates.length > 0) {
    fallbackBaseDate = normalizeDate(isoDates[isoDates.length - 1]);
  }
  updateBaseLayerDate();
}

async function loadBasemapDates() {
  try {
    const res = await fetch('/api/basemaps');
    if (!res.ok) return;
    const json = await res.json();
    cachedBasemapDates.clear();
    if (Array.isArray(json?.dates)) {
      json.dates.forEach(d => {
        const iso = normalizeDate(String(d));
        if (iso) cachedBasemapDates.add(iso);
      });
    }
    setBaseLayerDate(baseLayerDate);
  } catch (err) {
    console.warn('Failed to load basemap cache list', err);
  }
}

function rasterUrl(dir, file) {
  if (import.meta.env.PROD) {
    // In production, rasters are copied to dist/rasters preserving relative paths
    return `/rasters/${file}`;
  }
  const p = new URLSearchParams();
  if (dir) p.set('dir', dir);
  p.set('file', file);
  return `/rasters?${p.toString()}`;
}

// Color ramps
function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  switch (currentRamp) {
    case 'grayscale': {
      const g = Math.round(255 * t); // 0=black -> 1=white
      return [g, g, g, 255];
    }
    case 'viridis': {
      const r = Math.round(255 * (0.267 + 2.39*t - 2.64*t*t + 0.95*t*t*t));
      const g = Math.round(255 * (0.004 + 1.73*t - 0.89*t*t));
      const b = Math.round(255 * (0.329 + 0.71*t + 0.28*t*t));
      return [Math.max(0,Math.min(255,r)), Math.max(0,Math.min(255,g)), Math.max(0,Math.min(255,b)), 255];
    }
    case 'magma': {
      const r = Math.round(255 * Math.pow(t, 0.4));
      const g = Math.round(255 * Math.pow(t, 2.0) * 0.8);
      const b = Math.round(255 * (0.2 + 0.8*(1 - Math.pow(1-t, 3))));
      return [r, g, b, 255];
    }
    case 'heat': {
      const fourT = 4 * t;
      const r = Math.round(255 * Math.max(0, Math.min(1, fourT - 1.5)));
      const g = Math.round(255 * Math.max(0, Math.min(1, fourT - 0.5)));
      const b = Math.round(255 * Math.max(0, Math.min(1, 1.5 - fourT)));
      return [r, g, b, 255];
    }
    default: {
      const g = Math.round(255 * t);
      return [g, g, g, 255];
    }
  }
}

function drawLegendCanvas() {
  const c = document.getElementById('legendCanvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);
    const [r,g,b,a] = rampColor(t);
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      img.data[o] = r; img.data[o+1] = g; img.data[o+2] = b; img.data[o+3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function createRasterControls() {
  const container = layersEl;
  container.textContent = '';
  rasters.forEach(({ label, dir, file, isoDate, displayDate }) => {
    const path = rasterUrl(dir, file);
    const row = document.createElement('div');
    row.className = 'raster-item';

    const header = document.createElement('div');
    header.className = 'raster-header';

    const left = document.createElement('div');
    left.className = 'raster-info';

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    rasterCheckboxes.set(path, chk);
    const lbl = document.createElement('label');
    const labelText = displayDate || formatDisplayDate(isoDate) || label;
    lbl.textContent = labelText;
    lbl.style.cursor = 'pointer';

    const zoomBtn = document.createElement('button');
    zoomBtn.textContent = 'Zoom';
    zoomBtn.title = 'Zoom to layer';

    left.appendChild(chk);
    left.appendChild(lbl);
    header.appendChild(left);
    header.appendChild(zoomBtn);

    const controls = document.createElement('div');
    controls.className = 'raster-controls';

    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '1';
    opacity.step = '0.01';
    opacity.value = '0.8';
    opacity.className = 'opacity';

    const status = document.createElement('div');
    status.className = 'legend';
    const initialDateText = displayDate || (isoDate ? formatDisplayDate(isoDate) : undefined);
    status.textContent = initialDateText ? `Date • ${initialDateText}` : '';
    status.classList.remove('status-error');

    controls.appendChild(opacity);

    row.appendChild(header);
    row.appendChild(controls);
    row.appendChild(status);
    container.appendChild(row);

    async function ensureLayerLoaded() {
      if (overlayState.has(path)) return overlayState.get(path);
      pushLoading();
      status.classList.remove('status-error');
      status.textContent = 'Loading…';
      const urlPath = path;
      try {
        // Read with geotiff directly, full raster
        const tiff = await loadGeoTiff(urlPath);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        const ras = await image.readRasters({ interleave: false, samples: [0] });
        const data = ras[0];

        // Biodiversity domain is [0,1]; compute observed min/max only for info
        const noData = image.getGDALNoData?.() ?? image.getNoDataValue?.();
        const { obsMin, obsMax } = await computeValueRange(data, noData);

        // Create canvas and a function to render with selected ramp
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');

        const renderToCanvas = async () => {
          await renderRasterToCanvas({ data, width, height, noData, ctx });
        };
        await renderToCanvas();

        let geo = geoCache.get(path);
        if (!geo) {
          geo = computeGeoReference(image);
          geoCache.set(path, geo);
        }
        const {
          geoKeys,
          fileDirectory: fd,
          projCode,
          projectionDefined,
          rasterType,
          transform,
          ties,
          scale,
          bbox,
          bounds,
          lonMin,
          lonMax,
          latMin,
          latMax
        } = geo;
        const ascii = fd && typeof fd.GeoAsciiParams === 'string' ? fd.GeoAsciiParams : undefined;

        // Diagnostics: log CRS info once per layer
        console.groupCollapsed(`GeoTIFF info: ${label}`);
        console.log('GeoKeys:', geoKeys);
        console.log('FileDirectory keys:', Object.keys(fd || {}));
        console.log('RasterType (1=Area,2=Point):', rasterType);
        console.log('Proj code:', projCode);
        if (ascii) console.log('GeoAsciiParams:', ascii);
        if (transform) {
          const rot = Math.abs(transform[1]) > 1e-12 || Math.abs(transform[4]) > 1e-12;
          console.log('Has transform:', true, 'rotation/shear:', rot);
          if (rot) console.warn('Raster has rotation/shear; axis-aligned ImageOverlay may misalign.');
        } else {
          console.log('Has transform:', false);
        }
        if (Array.isArray(ties) && ties.length) console.log('First tiepoint:', ties[0]);
        if (scale) console.log('ModelPixelScale:', scale);
        console.groupEnd();

        if (projCode && Number.isFinite(projCode) && projCode !== 4326 && bounds && projectionDefined) {
          // True reprojection (warp) onto a regular lat/lon grid to remove curvature misalignment
          status.classList.remove('status-error');
          status.textContent = 'Reprojecting…';
          const widthOut = Math.max(2, Math.min(width, 4096));
          const heightOut = Math.max(2, Math.round(height * (widthOut / width)));
          const out = new Float32Array(widthOut * heightOut);
          const src = `EPSG:${projCode}`;
          const toSrc = ([lon, lat]) => proj4('EPSG:4326', src, [lon, lat]);
          // Precompute inverse of transform if available
          let invA = null; let invB = null; let invC = null; let invD = null; let offX = null; let offY = null; let affine = false;
          if (transform && transform.length === 16 && Math.abs(transform[12]) < 1e-12 && Math.abs(transform[13]) < 1e-12) {
            const a = transform[0], b = transform[1], c = transform[3];
            const d = transform[4], e = transform[5], f = transform[7];
            const det = a * e - b * d;
            if (Math.abs(det) > 1e-12) {
              invA = e / det; invB = -b / det; invC = -d / det; invD = a / det;
              offX = - (invA * c + invB * f);
              offY = - (invC * c + invD * f);
              affine = true;
            }
          }
          const t0 = Array.isArray(ties) && ties.length > 0 ? ties[0] : undefined;
          const i0 = t0 && Number.isFinite(t0.i) ? t0.i : 0;
          const j0 = t0 && Number.isFinite(t0.j) ? t0.j : 0;
          const X0 = t0 && Number.isFinite(t0.x) ? t0.x : bbox[0];
          const Y0 = t0 && Number.isFinite(t0.y) ? t0.y : bbox[3];
          const sx = scale && scale.length >= 2 ? (Number(scale[0]) || 1) : ((bbox[2] - bbox[0]) / width);
          const sy = scale && scale.length >= 2 ? (Number(scale[1]) || 1) : ((bbox[3] - bbox[1]) / height);
          const worldToPixel = (X, Y) => {
            if (affine) {
              const i = invA * X + invB * Y + offX;
              const j = invC * X + invD * Y + offY;
              return [i, j];
            } else if (Array.isArray(ties) && ties.length > 0 && scale && scale.length >= 2) {
              const i = (X - X0) / sx + i0;
              const j = (Y0 - Y) / sy + j0;
              return [i, j];
            }
            const i = (X - bbox[0]) / (bbox[2] - bbox[0]) * width;
            const j = (bbox[3] - Y) / (bbox[3] - bbox[1]) * height;
            return [i, j];
          };
          const dLon = (lonMax - lonMin) / widthOut;
          const dLat = (latMax - latMin) / heightOut;
          const useCenter = rasterType === 2; // PixelIsPoint uses center sampling
          const rowChunk = Math.max(1, Math.floor(500_000 / Math.max(1, widthOut)));
          const populateOut = async () => {
            for (let y = 0; y < heightOut; y++) {
              const lat = latMax - (y + 0.5) * dLat;
              const rowOffset = y * widthOut;
              for (let x = 0; x < widthOut; x++) {
                const lon = lonMin + (x + 0.5) * dLon;
                const [X, Y] = toSrc([lon, lat]);
                const [pi, pj] = worldToPixel(X, Y);
                const ii = useCenter ? Math.round(pi) : Math.floor(pi);
                const jj = useCenter ? Math.round(pj) : Math.floor(pj);
                const outIdx = rowOffset + x;
                if (ii >= 0 && ii < width && jj >= 0 && jj < height) {
                  const srcIdx = jj * width + ii;
                  out[outIdx] = data[srcIdx];
                } else {
                  out[outIdx] = Number.NaN;
                }
              }
              if ((y + 1) % rowChunk === 0 && y + 1 < heightOut) {
                await new Promise(requestAnimationFrame);
              }
            }
          };
          await populateOut();
          // Replace data/canvas with reprojected grid
          const outCanvas = document.createElement('canvas');
          outCanvas.width = widthOut; outCanvas.height = heightOut;
          const outCtx = outCanvas.getContext('2d');
          const renderWarped = async () => {
            await renderRasterToCanvas({ data: out, width: widthOut, height: heightOut, noData, ctx: outCtx });
          };
          await renderWarped();
          // Swap references
          canvas.width = outCanvas.width; canvas.height = outCanvas.height;
          const tmpUrl = outCanvas.toDataURL('image/png');
          const layer = L.imageOverlay(tmpUrl, bounds, { opacity: 0, className: smoothing ? 'smooth' : 'pixelated' });
          const rtLabel = (rasterType === 2 ? 'PixelIsPoint' : 'PixelIsArea');
          const crsLabel = Number.isFinite(projCode) ? `EPSG:${projCode}→4326` : 'EPSG:unknown→4326';
          const entryDateLabel = displayDate || (isoDate ? formatDisplayDate(isoDate) : undefined);
          const isoLabel = entryDateLabel ? `${entryDateLabel} • ` : '';
          const entry = {
            layer,
            statusText: `${isoLabel}${crsLabel} • ${rtLabel} • reproj:${width}x${height}→${widthOut}x${heightOut} • obs:[${obsMin.toFixed(3)}, ${obsMax.toFixed(3)}] domain:[0,1]`,
            data: out,
            width: widthOut,
            height: heightOut,
            noData,
            bounds,
            canvas: outCanvas,
            ctx: outCtx,
            renderToCanvas: renderWarped,
            added: false,
            isoDate,
            displayDate
          };
          overlayState.set(path, entry);
          applyAreaMaskForEntry(entry, { force: true });
          status.classList.remove('status-error');
          status.textContent = entry.statusText;
          return entry;
        } else if (projCode && Number.isFinite(projCode) && projCode !== 4326 && !projectionDefined) {
          console.warn(`EPSG:${projCode} has no proj4 definition available; displaying without reprojection.`);
        }

        // Create overlay
        const url = canvas.toDataURL('image/png');
        const layer = L.imageOverlay(url, bounds, { opacity: 0, className: smoothing ? 'smooth' : 'pixelated' });
        const rtLabel = (rasterType === 2 ? 'PixelIsPoint' : 'PixelIsArea');
        const crsLabel = Number.isFinite(projCode) ? `EPSG:${projCode}` : 'EPSG:unknown';
        const entryDateLabel = displayDate || (isoDate ? formatDisplayDate(isoDate) : undefined);
        const isoLabel = entryDateLabel ? `${entryDateLabel} • ` : '';
        const entry = {
          layer,
          statusText: `${isoLabel}${crsLabel} • ${rtLabel} • obs:[${obsMin.toFixed(3)}, ${obsMax.toFixed(3)}] domain:[0,1]`,
          data,
          width,
          height,
          noData,
          bounds,
          canvas,
          ctx,
          renderToCanvas,
          added: false,
          isoDate,
          displayDate
        };
        overlayState.set(path, entry);
        applyAreaMaskForEntry(entry, { force: true });
        status.classList.remove('status-error');
        status.textContent = entry.statusText;
        return entry;
      } catch (err) {
        console.error(err);
        status.classList.add('status-error');
        status.textContent = 'Error: ' + (err?.message || 'failed to load');
        throw err;
      } finally {
        popLoading();
      }
    }

    chk.addEventListener('change', async () => {
      if (chk.checked) {
        try {
          const entry = await ensureLayerLoaded();
          const { layer } = entry;
          status.textContent = 'Rendering…';
          if (!entry.added) { layer.addTo(map); entry.added = true; }
          const val = isNaN(parseFloat(opacity.value)) ? 0.8 : parseFloat(opacity.value);
          if (layer.setOpacity) layer.setOpacity(val);
          // update smoothing class on image overlays
          const el = layer.getElement && layer.getElement();
          if (el) {
            el.classList.toggle('smooth', smoothing);
            el.classList.toggle('pixelated', !smoothing);
          }
          // Auto-zoom to bounds the first time the layer is shown
          if (entry.bounds && entry.bounds.isValid && entry.bounds.isValid() && !entry._zoomedOnce) {
            entry._zoomedOnce = true;
            try { map.fitBounds(entry.bounds.pad(0.02)); } catch (_) {}
          }
          if (entry.isoDate) {
            const iso = normalizeDate(entry.isoDate);
            if (iso) activeOverlayDates.add(iso);
            updateBaseLayerDate();
          }
          updateBrandLogo();
          status.classList.remove('status-error');
          status.textContent = entry.statusText || 'Visible';
        } catch (_) { chk.checked = false; }
      } else {
        const entry = overlayState.get(path);
        if (entry) {
          // Keep in map memory but invisible for instant re-show
          if (entry.layer.setOpacity) entry.layer.setOpacity(0);
          status.classList.remove('status-error');
          const display = entry.displayDate || (entry.isoDate ? formatDisplayDate(entry.isoDate) : undefined);
          status.textContent = display ? `Date • ${display}` : '';
          if (entry.isoDate) {
            const iso = normalizeDate(entry.isoDate);
            if (iso) activeOverlayDates.delete(iso);
            updateBaseLayerDate();
          }
          updateBrandLogo();
        }
      }
    });

    zoomBtn.addEventListener('click', async () => {
      try {
        const entry = await ensureLayerLoaded();
        if (entry && entry.bounds && entry.bounds.isValid && entry.bounds.isValid()) {
          map.fitBounds(entry.bounds.pad(0.05));
        }
      } catch (_) {}
    });

    opacity.addEventListener('input', () => {
      const entry = overlayState.get(path);
      if (entry) {
        const val = parseFloat(opacity.value);
        if (entry.layer.setOpacity) entry.layer.setOpacity(val);
      }
    });
  });
}

async function fitInitialView() {
  const ordered = (() => {
    if (!DEFAULT_RASTER_ISO) return rasters;
    const primary = rasters.filter(r => r.isoDate === DEFAULT_RASTER_ISO);
    if (!primary.length) return rasters;
    const secondary = rasters.filter(r => r.isoDate !== DEFAULT_RASTER_ISO);
    return primary.concat(secondary);
  })();

  for (const { dir, file } of ordered) {
    const path = rasterUrl(dir, file);
    try {
      if (geoCache.has(path)) {
        const cached = geoCache.get(path);
        if (cached?.bounds && cached.bounds.isValid && cached.bounds.isValid()) {
          map.fitBounds(cached.bounds.pad(0.05));
          return;
        }
      }
      const tiff = await loadGeoTiff(path);
      const image = await tiff.getImage();
      const geo = computeGeoReference(image);
      geoCache.set(path, geo);
      if (geo.bounds && geo.bounds.isValid && geo.bounds.isValid()) {
        map.fitBounds(geo.bounds.pad(0.05));
        return;
      }
    } catch (err) {
      console.warn('Failed to derive bounds for', file, err);
    }
  }
}

async function activateDefaultLayers() {
  if (!DEFAULT_RASTER_ISO) return;
  const target = rasters.find(r => r.isoDate === DEFAULT_RASTER_ISO);
  if (!target) return;
  const path = rasterUrl(target.dir, target.file);
  const chk = rasterCheckboxes.get(path);
  if (!chk || chk.checked) return;
  chk.checked = true;
  chk.dispatchEvent(new Event('change', { bubbles: true }));
}

// Build UI after loading raster list
(async () => {
  if (layersEl) {
    const p = document.createElement('div');
    p.textContent = 'Loading raster list…';
    layersEl.appendChild(p);
  }
  try {
    await loadRasterList();
    await loadBasemapDates();
  } catch (e) {
    console.error(e);
  }
  if (layersEl) layersEl.textContent = '';
  createRasterControls();
  try {
    await fitInitialView();
  } catch (e) {
    console.warn('Failed to fit initial view', e);
  }
  try {
    await activateDefaultLayers();
  } catch (e) {
    console.warn('Failed to activate default layers', e);
  }
})();

// Open sidebar by default on load, then close after short hint
openSidebar(true);
setTimeout(() => openSidebar(false), 2500);

// Legend + ramp + smoothing wiring
(() => {
  drawLegendCanvas();
  const select = document.getElementById('rampSelect');
  if (select) {
    select.value = currentRamp;
    select.addEventListener('change', async () => {
      currentRamp = select.value;
      drawLegendCanvas();
      // Re-render canvases (original or reprojected) and update overlay images
      for (const entry of overlayState.values()) {
        if (!entry || !entry.layer) continue;
        if (entry.renderToCanvas && entry.canvas) {
          await entry.renderToCanvas();
          applyAreaMaskForEntry(entry, { force: true });
        }
      }
    });
  }

  const smoothToggle = document.getElementById('smoothToggle');
  if (smoothToggle) {
    smoothToggle.checked = smoothing;
    smoothToggle.addEventListener('change', () => {
      smoothing = smoothToggle.checked;
      overlayState.forEach((entry) => {
        if (!entry || !entry.layer) return;
        const el = entry.layer.getElement && entry.layer.getElement();
        if (el) {
          el.classList.toggle('smooth', smoothing);
          el.classList.toggle('pixelated', !smoothing);
        }
      });
    });
  }
})();
