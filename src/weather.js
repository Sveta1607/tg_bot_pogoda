/**
 * Интеграция с Open-Meteo: геокодинг и прогноз на сегодня (почасовой + суточный).
 * Без API-ключа; коды погоды — WMO Weather interpretation codes (как в документации Open-Meteo).
 */

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';

/**
 * Переводит WMO weathercode в короткое русское описание (солнце / дождь / снег и т.д.).
 * @param {number} code
 */
function weatherCodeToText(code) {
  const c = Number(code);
  if (c === 0) return 'ясно, солнце';
  if (c === 1) return 'преимущественно ясно';
  if (c === 2) return 'переменная облачность';
  if (c === 3) return 'пасмурно';
  if (c === 45 || c === 48) return 'туман';
  if (c >= 51 && c <= 55) return 'морось';
  if (c >= 56 && c <= 57) return 'изморозь';
  if (c >= 61 && c <= 65) return 'дождь';
  if (c === 66 || c === 67) return 'ледяной дождь';
  if (c >= 71 && c <= 75) return 'снег';
  if (c === 77) return 'снежная крупа';
  if (c >= 80 && c <= 82) return 'ливень';
  if (c >= 85 && c <= 86) return 'снегопад';
  if (c >= 95 && c <= 99) return 'гроза';
  return 'смешанные условия';
}

/**
 * Определяет, подразумевает ли код уже осадки (чтобы не дублировать фразу про дождь).
 * @param {number} code
 */
function codeImpliesPrecipitation(code) {
  const c = Number(code);
  return (
    (c >= 51 && c <= 67) ||
    (c >= 71 && c <= 77) ||
    (c >= 80 && c <= 86) ||
    (c >= 95 && c <= 99)
  );
}

/**
 * Собирает текст условий: основной код + при необходимости вероятность осадков.
 * @param {number} code
 * @param {number} maxPrecipProbInBucket — макс. вероятность осадков в интервале, %
 */
function buildConditionsText(code, maxPrecipProbInBucket) {
  const base = weatherCodeToText(code);
  const p = typeof maxPrecipProbInBucket === 'number' ? maxPrecipProbInBucket : 0;
  const wet = codeImpliesPrecipitation(code);
  if (wet && p >= 25) {
    return `${base} (~${Math.round(p)}% осадков)`;
  }
  if (!wet && p >= 45) {
    return `${base}, возможны осадки (~${Math.round(p)}%)`;
  }
  return base;
}

/**
 * Округление температуры для вывода (убираем -0).
 * @param {number} t
 */
function fmtTemp(t) {
  const n = Math.round(Number(t) * 10) / 10;
  return Object.is(n, -0) ? 0 : n;
}

/**
 * Берёт лучшее совпадение геокодера ([0]); погода только если эта точка в РФ.
 * @param {string} query — название города от пользователя
 */
async function geocodeRussia(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'not_found' };
  }

  const url = new URL(GEO_URL);
  url.searchParams.set('name', trimmed);
  url.searchParams.set('count', '10');
  url.searchParams.set('language', 'ru');

  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, reason: 'not_found' };
  }

  const data = await res.json();
  const results = data.results;
  if (!Array.isArray(results) || results.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  const top = results[0];
  if (top.country_code !== 'RU') {
    return { ok: false, reason: 'not_ru' };
  }

  return {
    ok: true,
    name: top.name,
    lat: top.latitude,
    lon: top.longitude,
  };
}

/**
 * Из ответа API вытаскивает почасовые точки только за первые сутки прогноза (локальные даты в строке time).
 * @param {object} data — JSON ответа forecast
 */
function parseFirstDayHourlySlots(data) {
  const times = data.hourly?.time;
  const temps = data.hourly?.temperature_2m;
  const codes = data.hourly?.weathercode;
  const precs = data.hourly?.precipitation_probability;
  if (!Array.isArray(times) || !temps || !codes) {
    return [];
  }
  const dayPrefix = times[0].slice(0, 10);
  const slots = [];
  for (let i = 0; i < times.length; i++) {
    if (!times[i].startsWith(dayPrefix)) break;
    const hour = parseInt(times[i].slice(11, 13), 10);
    const pr = Array.isArray(precs) && typeof precs[i] === 'number' ? precs[i] : 0;
    slots.push({
      hour,
      temperature_2m: temps[i],
      weathercode: codes[i],
      precipitation_probability: pr,
    });
  }
  return slots;
}

/**
 * Усредняет температуру в интервале и берёт «типичный» код погоды из середины интервала.
 * @param {Array<{ hour: number, temperature_2m: number, weathercode: number, precipitation_probability: number }>} bucket
 */
function summarizeBucket(bucket) {
  if (!bucket.length) return null;
  const avgTemp =
    bucket.reduce((s, b) => s + b.temperature_2m, 0) / bucket.length;
  const mid = bucket[Math.floor(bucket.length / 2)];
  const maxP = Math.max(...bucket.map((b) => b.precipitation_probability || 0));
  return {
    tempC: fmtTemp(avgTemp),
    desc: buildConditionsText(mid.weathercode, maxP),
  };
}

/**
 * Прогноз на сегодня: ветер сейчас, min/max за сутки, утро/день/вечер, общая картина по daily.
 * @param {number} lat
 * @param {number} lon
 */
async function fetchTodayForecast(lat, lon) {
  const url = new URL(WEATHER_URL);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('current', 'wind_speed_10m');
  url.searchParams.set('hourly', 'temperature_2m,weathercode,precipitation_probability');
  url.searchParams.set('daily', 'weathercode,temperature_2m_max,temperature_2m_min');
  url.searchParams.set('wind_speed_unit', 'kmh');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '1');

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('weather_http');
  }

  const data = await res.json();
  const wind = data.current?.wind_speed_10m;
  if (typeof wind !== 'number') {
    throw new Error('weather_parse');
  }

  const slots = parseFirstDayHourlySlots(data);
  if (!slots.length) {
    throw new Error('weather_parse');
  }

  // Утро / день / вечер — фиксированные локальные часы (как просили по смыслу суток).
  const morning = summarizeBucket(slots.filter((s) => s.hour >= 6 && s.hour <= 11));
  const day = summarizeBucket(slots.filter((s) => s.hour >= 12 && s.hour <= 17));
  const evening = summarizeBucket(slots.filter((s) => s.hour >= 18 && s.hour <= 23));

  const periods = [];
  if (morning) periods.push({ label: 'Утро', ...morning });
  if (day) periods.push({ label: 'День', ...day });
  if (evening) periods.push({ label: 'Вечер', ...evening });

  const d0 = data.daily?.time?.[0];
  const dCode = data.daily?.weathercode?.[0];
  const tMax = data.daily?.temperature_2m_max?.[0];
  const tMin = data.daily?.temperature_2m_min?.[0];
  if (!d0 || typeof dCode !== 'number' || tMax == null || tMin == null) {
    throw new Error('weather_parse');
  }

  return {
    windKmh: Math.round(wind * 10) / 10,
    tempMin: fmtTemp(tMin),
    tempMax: fmtTemp(tMax),
    periods,
    dayOverview: weatherCodeToText(dCode),
  };
}

module.exports = {
  geocodeRussia,
  fetchTodayForecast,
};
