// Глобальні змінні, доступні для інших файлів
const mbKey = ENV.MAPBOX_KEY;
const orsKey = ENV.ORS_KEY;

mapboxgl.accessToken = mbKey;

let map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [24.0297, 49.8397],
    zoom: 12
});

let geolocate = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true
});
map.addControl(geolocate, 'bottom-right');

map.on('load', () => geolocate.trigger());

let startMarker = null;
let endMarker = null;
let savingsMarker = null;
let rejectedRouteGeoJSON = null;

// --- СЛІДКУВАННЯ ЗА КОРИСТУВАЧЕМ У 3D РЕЖИМІ ---
geolocate.on('geolocate', function(e) {
    if (typeof isAutoRotate !== 'undefined' && isAutoRotate) {
        map.setCenter([e.coords.longitude, e.coords.latitude]);
        if (e.coords.heading !== null && !isNaN(e.coords.heading)) {
            map.setBearing(e.coords.heading);
        }
    }
});

// --- ОЧИЩЕННЯ МАРШРУТУ ---
window.clearRoute = function() {
    ['local-bypass-line', 'route-line', 'traffic-jam-fill', 'rejected-route-line']
        .forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    ['local-bypass-segment', 'route', 'traffic-jam', 'rejected-route']
        .forEach(id => { if (map.getSource(id)) map.removeSource(id); });
    if (savingsMarker) { savingsMarker.remove(); savingsMarker = null; }
    rejectedRouteGeoJSON = null;

    // Скидаємо UI
    const statsDiv = document.getElementById('stats');
    const analysisBtn = document.getElementById('analysisBtn');
    const analysisDetails = document.getElementById('analysisDetails');
    const rotateBtn = document.getElementById('rotateBtn');
    if (statsDiv) statsDiv.innerHTML = 'Оберіть точки маршруту';
    if (analysisBtn) analysisBtn.style.display = 'none';
    if (analysisDetails) { analysisDetails.style.display = 'none'; analysisDetails.innerHTML = ''; }
    if (rotateBtn) rotateBtn.style.display = 'none';
}

// --- РОБОТА З МАРКЕРАМИ ---
window.updateMarker = function(type, lngLat) {
    if (type === 'start') {
        if (startMarker) startMarker.remove();
        startMarker = new mapboxgl.Marker({ color: '#111' }).setLngLat(lngLat).addTo(map);
    } else {
        if (endMarker) endMarker.remove();
        endMarker = new mapboxgl.Marker({ color: '#dc2626' }).setLngLat(lngLat).addTo(map);

        // Масштабуємо карту, щоб вмістити обидва маркери
        const startStr = document.getElementById('startInput').dataset.coords;
        if (startStr) {
            const startCoords = startStr.split(',').map(Number);
            const bounds = new mapboxgl.LngLatBounds(startCoords, lngLat);
            map.fitBounds(bounds, { padding: 80 });
        }
    }
}

// --- ФУНКЦІЇ МАЛЮВАННЯ НА КАРТІ ---

window.drawFinalRoute = function(avoidPolygons, routeGeometry) {
    if (avoidPolygons?.coordinates?.length > 0) {
        if (!map.getSource('traffic-jam')) {
            map.addSource('traffic-jam', { type: 'geojson', data: avoidPolygons });
            map.addLayer({ id: 'traffic-jam-fill', type: 'fill', source: 'traffic-jam',
                paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.2 } });
        } else {
            map.getSource('traffic-jam').setData(avoidPolygons);
        }
    }

    if (!map.getSource('route')) {
        map.addSource('route', { type: 'geojson', data: routeGeometry });
        map.addLayer({ id: 'route-line', type: 'line', source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#3b82f6', 'line-width': 7, 'line-opacity': 0.9 } });
    } else {
        map.getSource('route').setData(routeGeometry);
    }

    if (typeof isAutoRotate !== 'undefined' && !isAutoRotate) {
        const bounds = new mapboxgl.LngLatBounds(
            routeGeometry.coordinates[0],
            routeGeometry.coordinates[0]
        );
        routeGeometry.coordinates.forEach(c => bounds.extend(c));
        map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 60 } });
    }
}

window.drawLocalBypassSegment = function(wpEntry, wpExit, routeGeometry) {
    const coords = routeGeometry.coordinates;
    let eIdx = 0, xIdx = 0, minDE = Infinity, minDX = Infinity;
    coords.forEach((c, i) => {
        const dE = turf.distance(turf.point(wpEntry), turf.point(c), { units: 'meters' });
        const dX = turf.distance(turf.point(wpExit),  turf.point(c), { units: 'meters' });
        if (dE < minDE) { minDE = dE; eIdx = i; }
        if (dX < minDX) { minDX = dX; xIdx = i; }
    });
    const from = Math.min(eIdx, xIdx);
    const to   = Math.max(eIdx, xIdx);
    if (to - from < 2) return;

    const segGeoJSON = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords.slice(from, to + 1) }
    };

    // Видаляємо попередній шар якщо є
    if (map.getLayer('local-bypass-line')) map.removeLayer('local-bypass-line');
    if (map.getSource('local-bypass-segment')) map.removeSource('local-bypass-segment');

    map.addSource('local-bypass-segment', { type: 'geojson', data: segGeoJSON });
    map.addLayer({
        id: 'local-bypass-line', type: 'line', source: 'local-bypass-segment',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#16a34a', 'line-width': 4, 'line-dasharray': [1, 2] }
    });
}

window.drawSavingsMarker = function(wpEntry, wpExit, routeGeometry, timeSaved) {
    const coords = routeGeometry.coordinates;
    let eIdx = 0, xIdx = 0, minDE = Infinity, minDX = Infinity;
    coords.forEach((c, i) => {
        const dE = turf.distance(turf.point(wpEntry), turf.point(c), { units: 'meters' });
        const dX = turf.distance(turf.point(wpExit),  turf.point(c), { units: 'meters' });
        if (dE < minDE) { minDE = dE; eIdx = i; }
        if (dX < minDX) { minDX = dX; xIdx = i; }
    });
    const markerPos = coords[Math.floor((eIdx + xIdx) / 2)];

    const el = document.createElement('div');
    el.style.cssText = `background:#111;color:#fff;border-radius:20px;padding:6px 12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.2);pointer-events:none;white-space:nowrap;`;

    el.innerHTML = timeSaved > 0
        ? `Економія: ${timeSaved} хв`
        : timeSaved === 0
            ? `Той самий час`
            : `+${Math.abs(timeSaved)} хв`;

    if (savingsMarker) savingsMarker.remove();
    savingsMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat(markerPos).addTo(map);
}

window.drawRejectedRoute = function(geoJSON) {
    if (!map.getSource('rejected-route')) {
        map.addSource('rejected-route', { type: 'geojson', data: geoJSON });
        map.addLayer({
            id: 'rejected-route-line', type: 'line', source: 'rejected-route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#888', 'line-width': 4, 'line-dasharray': [2, 2], 'line-opacity': 0.6 }
        }, map.getLayer('route-line') ? 'route-line' : undefined);
    } else {
        map.getSource('rejected-route').setData(geoJSON);
    }
}