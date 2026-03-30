// 1. Зворотне геокодування: Координати -> Текст адреси (коли тикаємо на карту)
async function getAddressFromCoords(lng, lat) {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${mbKey}&language=uk`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        return data.features?.[0]?.text_uk || data.features?.[0]?.place_name_uk || "Вибрана точка";
    } catch (e) { return "Вибрана точка"; }
}

// Обробка кліку по карті
map.on('click', async (e) => {
    const lngLat = [e.lngLat.lng.toFixed(6), e.lngLat.lat.toFixed(6)];
    const startInput = document.getElementById('startInput');
    const endInput = document.getElementById('endInput');

    let targetInput, type;

    if (!startInput.dataset.coords) {
        // Перша точка — очищуємо маршрут якщо є
        clearRoute();
        targetInput = startInput;
        type = 'start';
    } else if (!endInput.dataset.coords) {
        // Друга точка — очищуємо маршрут (старий залишався — це і був баг)
        clearRoute();
        targetInput = endInput;
        type = 'end';
    } else {
        // Обидві точки вже є — скидаємо все та починаємо з нової точки старту
        startInput.dataset.coords = '';
        startInput.value = '';
        endInput.dataset.coords = '';
        endInput.value = '';
        if (startMarker) startMarker.remove();
        if (endMarker) endMarker.remove();
        clearRoute();
        targetInput = startInput;
        type = 'start';
    }

    // Зберігаємо координати для алгоритму
    targetInput.dataset.coords = lngLat.join(',');
    targetInput.value = "Шукаю адресу...";
    updateMarker(type, lngLat);

    // Підтягуємо назву місця
    const address = await getAddressFromCoords(lngLat[0], lngLat[1]);
    targetInput.value = address;
});

// 2. Пряме геокодування: Текст -> Список місць (Автокомпліт)
function setupAutocomplete(inputId, listId, markerType) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    let timeout;

    input.addEventListener('input', () => {
        clearTimeout(timeout);
        // Якщо юзер щось вводить — видаляємо старі координати та очищуємо маршрут
        delete input.dataset.coords;
        clearRoute();

        if (input.value.length < 3) { list.style.display = 'none'; return; }

        timeout = setTimeout(async () => {
            // proximity Lviv - щоб шукало спочатку поруч
            const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(input.value)}.json?access_token=${mbKey}&language=uk&proximity=24.0297,49.8397`;
            const res = await fetch(url);
            const data = await res.json();

            list.innerHTML = '';
            if (data.features.length > 0) list.style.display = 'block';

            data.features.forEach(f => {
                const li = document.createElement('li');
                li.textContent = f.place_name_uk || f.place_name;
                li.onclick = () => {
                    input.value = f.text_uk || f.text;
                    input.dataset.coords = f.center.join(',');
                    list.style.display = 'none';
                    updateMarker(markerType, f.center);
                    // Маршрут вже очищено при input-події, маркер оновлено
                };
                list.appendChild(li);
            });
        }, 400);
    });

    // Ховаємо список при кліку поза ним
    document.addEventListener('click', (e) => {
        if (e.target !== input) list.style.display = 'none';
    });
}

setupAutocomplete('startInput', 'startList', 'start');
setupAutocomplete('endInput', 'endList', 'end');

window.setStartToCurrentLocation = function() {
    if (geolocate && geolocate._lastKnownPosition) {
        const coords = [
            geolocate._lastKnownPosition.coords.longitude,
            geolocate._lastKnownPosition.coords.latitude
        ];
        const input = document.getElementById('startInput');
        input.dataset.coords = coords.join(',');
        input.value = "Моя локація";
        clearRoute();
        updateMarker('start', coords);
        map.flyTo({ center: coords, zoom: 15 });
    } else {
        alert("GPS ще не знайдено.");
    }
}