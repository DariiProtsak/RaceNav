let isSimulationMode = false;
let isAnalysisVisible = false;
let isAutoRotate = false;

// Згортання панелі
window.togglePanel = function() {
    const content = document.getElementById('panelContent');
    const btn = document.getElementById('togglePanelBtn');
    content.classList.toggle('collapsed');
    btn.innerHTML = content.classList.contains('collapsed') ? '🔽' : '━';
}

// Симуляція
window.toggleSimulation = function() {
    isSimulationMode = !isSimulationMode;
    const btn = document.getElementById('simBtn');
    btn.classList.toggle('active');
    btn.innerHTML = `<span class="sim-indicator"></span> Симуляція затору: ${isSimulationMode ? 'Увімк.' : 'Вимк.'}`;
}

// Управління 3D режимом
window.toggleAutoRotate = function() {
    isAutoRotate = !isAutoRotate;
    const btn = document.getElementById('rotateBtn');
    if (isAutoRotate) {
        btn.innerHTML = "Вимкнути 3D-режим";
        btn.classList.add('active');
        map.setPitch(60);
        map.setZoom(17.5);
    } else {
        btn.innerHTML = "Увімкнути 3D-режим";
        btn.classList.remove('active');
        map.resetNorthPitch();
        map.setZoom(13);
    }
}

// Управління аналітикою
window.toggleAnalysis = function() {
    isAnalysisVisible = !isAnalysisVisible;
    const details = document.getElementById('analysisDetails');
    const btn = document.getElementById('analysisBtn');
    if (isAnalysisVisible) {
        details.style.display = 'block';
        btn.innerHTML = "Сховати деталі";
        if (rejectedRouteGeoJSON) drawRejectedRoute(rejectedRouteGeoJSON);
    } else {
        details.style.display = 'none';
        btn.innerHTML = "Деталі маршруту";
        if (map.getLayer('rejected-route-line')) {
            map.removeLayer('rejected-route-line');
            map.removeSource('rejected-route');
        }
    }
}

// --- ДОПОМІЖНІ ФУНКЦІЇ АЛГОРИТМУ ---

function extractWaypoints(coords) {
    const MAX_POINTS = 24;
    if (coords.length <= MAX_POINTS) return coords;
    let waypoints = [coords[0]];
    const step = (coords.length - 2) / (MAX_POINTS - 2);
    for (let i = 1; i < MAX_POINTS - 1; i++) waypoints.push(coords[Math.floor(i * step)]);
    waypoints.push(coords[coords.length - 1]);
    return waypoints;
}

function findCongestionClusters(congestion) {
    const BAD = new Set(['severe', 'heavy']);
    const clusters = [];
    let inCluster = false, startIdx = 0, hasSevere = false;

    for (let i = 0; i < congestion.length; i++) {
        if (BAD.has(congestion[i])) {
            if (!inCluster) { inCluster = true; startIdx = i; hasSevere = false; }
            if (congestion[i] === 'severe') hasSevere = true;
        } else if (inCluster) {
            // Допускаємо невеликий розрив — не розриваємо кластер через 1–2 нормальних сегменти
            const gapEnd = Math.min(i + 2, congestion.length - 1);
            if (!congestion.slice(i, gapEnd + 1).some(c => BAD.has(c))) {
                clusters.push({ startIdx, endIdx: i - 1, hasSevere });
                inCluster = false;
            }
        }
    }
    if (inCluster) clusters.push({ startIdx, endIdx: congestion.length - 1, hasSevere });
    return clusters;
}

async function generateLocalBypasses(startCoord, endCoord, routeCoords, clusters, avoidGeoJSON) {
    if (clusters.length === 0) return [];

    // Беремо тільки 3 найбільших кластери
    const targetClusters = [...clusters]
        .sort((a, b) => (b.endIdx - b.startIdx) - (a.endIdx - a.startIdx))
        .slice(0, 3);

    const allAttempts = [];

    for (const cluster of targetClusters) {
        const entryIdx = Math.max(0, cluster.startIdx - 3);
        const exitIdx  = Math.min(routeCoords.length - 1, cluster.endIdx + 3);

        // Пропускаємо кластери де вхід і вихід занадто близько
        if (exitIdx - entryIdx < 3) continue;

        const entryCoord = routeCoords[entryIdx];
        const exitCoord  = routeCoords[exitIdx];
        const entryNext  = routeCoords[Math.min(entryIdx + 4, routeCoords.length - 1)];
        const exitNext   = routeCoords[Math.min(exitIdx  + 4, routeCoords.length - 1)];

        const bearingEntry = turf.bearing(turf.point(entryCoord), turf.point(entryNext));
        const bearingExit  = turf.bearing(turf.point(exitCoord),  turf.point(exitNext));

        for (const distMeters of [50, 100, 200, 350]) {
            for (const side of ['left', 'right']) {
                const offset = side === 'left' ? -90 : 90;
                const wpEntry = turf.destination(
                    turf.point(entryCoord), distMeters / 1000,
                    (bearingEntry + offset + 360) % 360
                ).geometry.coordinates;
                const wpExit = turf.destination(
                    turf.point(exitCoord), distMeters / 1000,
                    (bearingExit + offset + 360) % 360
                ).geometry.coordinates;
                allAttempts.push({ wpEntry, wpExit, label: `Місцевий об'їзд (${distMeters}м)` });
            }
        }
    }

    if (allAttempts.length === 0) return [];

    const results = await Promise.allSettled(
        allAttempts.map(async ({ wpEntry, wpExit, label }) => {
            const body = {
                coordinates: [startCoord, wpEntry, wpExit, endCoord],
            };
            // Додаємо avoid_polygons тільки якщо є що уникати
            if (avoidGeoJSON?.coordinates?.length > 0) {
                body.options = { avoid_polygons: avoidGeoJSON };
            }
            const resp = await fetch('https://corsproxy.io/?https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
                method: 'POST',
                headers: { 'Authorization': orsKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await resp.json();
            if (data.error || !data.features?.[0]) throw new Error('no route');
            return { coords: data.features[0].geometry.coordinates, label, wpEntry, wpExit };
        })
    );

    return deduplicateRoutes(
        results.filter(r => r.status === 'fulfilled').map(r => r.value)
    );
}

function deduplicateRoutes(routes) {
    const unique = [];
    for (const route of routes) {
        const len = route.coords.length;
        const fractions = [0.25, 0.50, 0.75];
        const pts = fractions.map(f => route.coords[Math.floor(len * f)]);
        const isDupe = unique.some(ex => {
            const el = ex.coords.length;
            return pts.every((pt, i) => {
                const ep = ex.coords[Math.floor(el * fractions[i])];
                return turf.distance(turf.point(pt), turf.point(ep), { units: 'meters' }) < 80;
            });
        });
        if (!isDupe) unique.push(route);
    }
    return unique;
}

// --- ГОЛОВНА ЛОГІКА ---

window.runValidationLoop = async function() {
    const startInput = document.getElementById('startInput');
    const endInput   = document.getElementById('endInput');
    const startStr   = startInput.dataset.coords;
    const endStr     = endInput.dataset.coords;

    if (!startStr || !endStr) {
        alert("Будь ласка, виберіть конкретні місця з випадаючого списку або тицьніть на карту.");
        return;
    }

    const startCoord = startStr.split(',').map(Number);
    const endCoord   = endStr.split(',').map(Number);
    const statsDiv       = document.getElementById('stats');
    const analysisBtn    = document.getElementById('analysisBtn');
    const analysisDetails = document.getElementById('analysisDetails');

    document.getElementById('rotateBtn').style.display = 'block';
    analysisBtn.style.display = 'none';
    isAnalysisVisible = false;
    analysisDetails.style.display = 'none';

    // Очищуємо старий маршрут перед побудовою нового
    clearRoute();

    try {
        statsDiv.innerHTML = "Аналіз маршруту...";
        let logHTML = `<div class="log-section-title">Аналіз трафіку</div>`;

        const coordStr = `${startCoord[0]},${startCoord[1]};${endCoord[0]},${endCoord[1]}`;

        const baseResp = await fetch(
            `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coordStr}` +
            `?geometries=geojson&overview=full&annotations=congestion,duration&access_token=${mbKey}`
        );
        const baseData = await baseResp.json();
        if (!baseData.routes?.length) throw new Error("Не знайдено маршрут.");

        const baseRoute    = baseData.routes[0];
        const baseDuration = Math.ceil(baseRoute.duration / 60);
        let congestion     = baseRoute.legs[0].annotation.congestion;
        const routeCoords  = baseRoute.geometry.coordinates;

        if (isSimulationMode) {
            congestion = [...congestion];
            const simFrom = Math.floor(congestion.length * 0.25);
            const simTo   = Math.floor(congestion.length * 0.75);
            for (let i = simFrom; i <= simTo; i++) congestion[i] = 'severe';
            logHTML += `<div class="log-item"><span class="log-label">Симуляція затору</span><span class="log-value warning">Активна</span></div>`;
        }

        const effectiveBaseDuration = isSimulationMode
            ? Math.ceil(baseRoute.duration * 1.4 / 60)
            : baseDuration;

        // --- Підрахунок часу в заторах ---
        // durations[i] — час сегменту між routeCoords[i] та routeCoords[i+1]
        // congestion.length може бути на 1 менше ніж routeCoords.length (один елемент на сегмент)
        const durations = baseRoute.legs[0].annotation.duration || [];
        let congestionSec = 0;
        for (let i = 0; i < congestion.length; i++) {
            const segDur = durations[i] ?? 0;
            if (congestion[i] === 'severe' || congestion[i] === 'heavy') {
                congestionSec += segDur;
            } else if (congestion[i] === 'moderate') {
                congestionSec += segDur * 0.4;
            }
        }
        const congestionPenalty = Math.round(congestionSec / 60);

        logHTML += `
            <div class="log-item">
                <span class="log-label">Базовий час</span>
                <span class="log-value">${effectiveBaseDuration} хв</span>
            </div>
            <div class="log-item">
                <span class="log-label">Час у заторах</span>
                <span class="log-value ${congestionPenalty > 0 ? 'warning' : ''}">${congestionPenalty} хв</span>
            </div>
        `;

        // Якщо заторів нема — одразу малюємо базовий маршрут
        if (congestionPenalty < 2) {
            statsDiv.innerHTML = `Час у дорозі: ${baseDuration} хв`;
            logHTML += `<div class="log-item"><span class="log-label">Статус</span><span class="log-value">Дорога вільна</span></div>`;
            analysisDetails.innerHTML = logHTML;
            analysisBtn.style.display = 'block';
            rejectedRouteGeoJSON = null;
            drawFinalRoute(null, baseRoute.geometry);
            // Зберігаємо маршрут в історію тільки після успішної побудови
            saveRouteToHistory(startInput.value, startStr, endInput.value, endStr);
            return;
        }

        // --- Будуємо полігони заторів для обходу ---
        let badPolygonsArray = [];
        for (let i = 0; i < congestion.length; i++) {
            const level = congestion[i];
            if (!['severe', 'heavy', 'moderate'].includes(level)) continue;

            // Перевірка: обидві точки сегменту мають існувати
            if (!routeCoords[i] || !routeCoords[i + 1]) continue;

            const bufferM  = (level === 'moderate') ? 20 : 40;
            const line     = turf.lineString([routeCoords[i], routeCoords[i + 1]]);
            const buffered = turf.buffer(line, bufferM, { units: 'meters' });
            if (!buffered) continue;

            if (buffered.geometry.type === 'Polygon') {
                badPolygonsArray.push(buffered.geometry.coordinates);
            } else if (buffered.geometry.type === 'MultiPolygon') {
                badPolygonsArray.push(...buffered.geometry.coordinates);
            }
        }

        const congestionClusters = findCongestionClusters(congestion);
        statsDiv.innerHTML = "Пошук альтернатив...";

        // avoidGeoJSON тільки якщо є полігони — порожній MultiPolygon може ламати ORS
        const avoidGeoJSON = badPolygonsArray.length > 0
            ? { type: "MultiPolygon", coordinates: badPolygonsArray }
            : null;

        const orsUrl = 'https://corsproxy.io/?https://api.openrouteservice.org/v2/directions/driving-car/geojson';

        // --- Запит до ORS з альтернативами ---
        let orsBody = {
            coordinates: [startCoord, endCoord],
            alternative_routes: { target_count: 3 }
        };
        if (avoidGeoJSON) orsBody.options = { avoid_polygons: avoidGeoJSON };

        let orsResp = await fetch(orsUrl, {
            method: 'POST',
            headers: { 'Authorization': orsKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(orsBody)
        });
        let orsData = await orsResp.json();

        // Якщо alternative_routes не підтримується — повторюємо без нього
        if (orsData.error) {
            orsBody = { coordinates: [startCoord, endCoord] };
            if (avoidGeoJSON) orsBody.options = { avoid_polygons: avoidGeoJSON };
            orsResp = await fetch(orsUrl, {
                method: 'POST',
                headers: { 'Authorization': orsKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(orsBody)
            });
            orsData = await orsResp.json();
        }
        const globalOrsRoutes = (orsData.error || !orsData.features) ? [] : orsData.features;

        // --- Генерація локальних об'їздів ---
        const localBypasses = await generateLocalBypasses(
            startCoord, endCoord, routeCoords, congestionClusters, avoidGeoJSON
        );

        statsDiv.innerHTML = "Розрахунок оптимального шляху...";

        logHTML += `<div class="log-section-title">Альтернативи знайдено</div>`;
        logHTML += `
            <div class="log-item">
                <span class="log-label">Глобальні об'їзди</span>
                <span class="log-value">${globalOrsRoutes.length}</span>
            </div>
            <div class="log-item">
                <span class="log-label">Локальні вулиці</span>
                <span class="log-value">${localBypasses.length}</span>
            </div>
        `;

        // --- Поріг агресивності ---
        // '1.5' Швидкий:   приймаємо об'їзд якщо він не довший ніж базовий + 30% часу заторів
        // '1.2' Баланс:    приймаємо об'їзд тільки якщо він не довший за базовий
        // '1.0' Спокійний: приймаємо об'їзд тільки якщо він коротший мінімум на 50% часу заторів
        const aggressionMode = document.getElementById('aggressionMode').value;
        const toleranceMap   = {
            '1.5': congestionPenalty * 0.3,
            '1.2': 0,
            '1.0': -congestionPenalty * 0.5
        };
        const tolerance      = toleranceMap[aggressionMode] ?? 0;
        const bypassThreshold = effectiveBaseDuration + tolerance;

        // --- Валідація маршрутів через Mapbox (отримуємо реальний час з пробками) ---
        const validateBypass = async (coords) => {
            const wps  = extractWaypoints(coords);
            const url  = `https://api.mapbox.com/directions/v5/mapbox/driving/${wps.map(c => `${c[0]},${c[1]}`).join(';')}?geometries=geojson&overview=full&access_token=${mbKey}`;
            const resp = await fetch(url);
            const data = await resp.json();
            return data.routes?.[0] ?? null;
        };

        const routeCompetition = [{
            name: "Головна дорога",
            duration: effectiveBaseDuration,
            geometry: baseRoute.geometry,
            isBase: true,
            isLocal: false
        }];

        const globalPromises = globalOrsRoutes.map(async (f) => {
            const v = await validateBypass(f.geometry.coordinates);
            if (!v) return null;
            return {
                name: `Глобальний об'їзд`,
                duration: Math.ceil(v.duration / 60),
                geometry: v.geometry,
                isBase: false,
                isLocal: false
            };
        });

        const localPromises = localBypasses.map(async (bypass) => {
            const v = await validateBypass(bypass.coords);
            if (!v) return null;
            return {
                name: bypass.label,
                duration: Math.ceil(v.duration / 60),
                geometry: v.geometry,
                isBase: false,
                isLocal: true,
                wpEntry: bypass.wpEntry,
                wpExit:  bypass.wpExit
            };
        });

        const allValidated = await Promise.all([...globalPromises, ...localPromises]);
        allValidated.forEach(r => { if (r) routeCompetition.push(r); });

        const alternatives = routeCompetition.filter(r => !r.isBase);
        alternatives.sort((a, b) => a.duration - b.duration);
        const bestAlt = alternatives[0];

        logHTML += `<div class="log-section-title">Порівняння</div>`;
        [...routeCompetition].sort((a, b) => a.duration - b.duration).slice(0, 3).forEach(r => {
            const isWinner = (r === bestAlt && !r.isBase);
            logHTML += `
                <div class="log-item">
                    <span class="log-label">${r.name} ${isWinner ? '★' : ''}</span>
                    <span class="log-value">${r.duration} хв</span>
                </div>
            `;
        });

        let winner, finalLogText, speechText;

        if (bestAlt && bestAlt.duration <= bypassThreshold) {
            winner = bestAlt;
            rejectedRouteGeoJSON = baseRoute.geometry;
            const saved    = effectiveBaseDuration - bestAlt.duration;
            const typeTag  = bestAlt.isLocal ? "Місцевий об'їзд" : "Глобальний об'їзд";
            finalLogText   = `${typeTag} (${winner.duration} хв)`;

            if (saved > 0) {
                speechText = `Увага. Попереду затор. Знайдено швидший об'їзд. Економія часу: ${getMinutesString(saved)}.`;
            } else if (saved === 0) {
                speechText = `Попереду затор. Побудовано маршрут в об'їзд. Час у дорозі не зміниться.`;
            } else {
                speechText = `Режим гонщика активовано. Знайдено об'їзд без зупинок.`;
            }
        } else {
            winner = routeCompetition.find(r => r.isBase);
            rejectedRouteGeoJSON = bestAlt?.geometry ?? null;
            finalLogText = `Основний маршрут (${baseDuration} хв)`;
            speechText   = `Побудовано маршрут. Час у дорозі: ${getMinutesString(baseDuration)}.`;
            if (congestionPenalty >= 2) {
                speechText += " На жаль, швидших об'їздів немає. Доведеться постояти в заторах.";
            }
        }

        speakAnnouncement(speechText);

        statsDiv.innerHTML      = finalLogText;
        analysisDetails.innerHTML = logHTML;
        analysisBtn.style.display = 'block';

        drawFinalRoute(avoidGeoJSON, winner.geometry);

        if (winner.isLocal && winner.wpEntry && winner.wpExit) {
            drawLocalBypassSegment(winner.wpEntry, winner.wpExit, winner.geometry);
            drawSavingsMarker(winner.wpEntry, winner.wpExit, winner.geometry, effectiveBaseDuration - winner.duration);
        }

        if (isAnalysisVisible && rejectedRouteGeoJSON) drawRejectedRoute(rejectedRouteGeoJSON);

        // Зберігаємо в історію тільки після успішної побудови
        saveRouteToHistory(startInput.value, startStr, endInput.value, endStr);

    } catch (error) {
        statsDiv.innerHTML = `Помилка побудови`;
        console.error(error);
    }
}

// --- ІСТОРІЯ МАРШРУТІВ (LocalStorage) ---
const HISTORY_KEY = 'racenav_history';

window.saveRouteToHistory = function(startText, startCoords, endText, endCoords) {
    if (!startText || !endText || !startCoords || !endCoords) return;
    if (startText.includes('Шукаю') || endText.includes('Шукаю')) return;

    let history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    const route = { startText, startCoords, endText, endCoords };

    // Видаляємо дублікати
    history = history.filter(h => !(h.startCoords === startCoords && h.endCoords === endCoords));

    history.unshift(route);
    if (history.length > 3) history.pop();

    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    renderHistory();
}

window.renderHistory = function() {
    const history   = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    const container = document.getElementById('historyContainer');
    const list      = document.getElementById('historyList');

    if (history.length === 0) { container.style.display = 'none'; return; }
    container.style.display = 'block';
    list.innerHTML = '';

    history.forEach(route => {
        const btn = document.createElement('div');
        btn.className = 'history-item';
        const sName = route.startText.split(',')[0];
        const eName = route.endText.split(',')[0];
        btn.innerHTML = `📍 ${sName} → 🏁 ${eName}`;
        btn.title = `${route.startText} → ${route.endText}`;

        btn.onclick = () => {
            const sInput = document.getElementById('startInput');
            const eInput = document.getElementById('endInput');
            sInput.value = route.startText;
            sInput.dataset.coords = route.startCoords;
            eInput.value = route.endText;
            eInput.dataset.coords = route.endCoords;
            updateMarker('start', route.startCoords.split(',').map(Number));
            updateMarker('end',   route.endCoords.split(',').map(Number));
            runValidationLoop();
        };
        list.appendChild(btn);
    });
}

document.addEventListener('DOMContentLoaded', renderHistory);

// --- ГОЛОСОВИЙ АСИСТЕНТ (Web Speech API) ---
window.speakAnnouncement = function(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        setTimeout(() => {
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang  = 'uk-UA';
            utterance.rate  = 1.0;
            const voices    = window.speechSynthesis.getVoices();
            const uaVoice   = voices.find(v => v.lang.includes('uk'));
            if (uaVoice) utterance.voice = uaVoice;
            window.speechSynthesis.speak(utterance);
        }, 100);
    }
}

function getMinutesString(n) {
    const r10  = n % 10;
    const r100 = n % 100;
    if (r10 === 1 && r100 !== 11) return `${n} хвилина`;
    if (r10 >= 2 && r10 <= 4 && (r100 < 10 || r100 >= 20)) return `${n} хвилини`;
    return `${n} хвилин`;
}