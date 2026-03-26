/**
 * Константы FSM и простая валидация текста для сценария профиля.
 */

/** Именованные состояния: минимум три (idle + два шага онбординга). */
const STATES = {
  IDLE: 'idle',
  ONBOARDING_NAME: 'onboarding_name',
  ONBOARDING_CITY: 'onboarding_city',
};

const MAX_NAME_LEN = 80;
const MAX_CITY_LEN = 100;

/**
 * Обрезка пробелов; для пустой строки — null (невалидно как ввод).
 * @param {string} text
 */
function normalizeText(text) {
  return String(text ?? '').trim();
}

/**
 * Проверка имени для шага онбординга.
 * @param {string} text
 * @returns {{ ok: true, value: string } | { ok: false, reason: string }}
 */
function validateDisplayName(text) {
  const v = normalizeText(text);
  if (!v) {
    return { ok: false, reason: 'empty' };
  }
  if (v.length > MAX_NAME_LEN) {
    return { ok: false, reason: 'long' };
  }
  return { ok: true, value: v };
}

/**
 * Проверка строки города до геокодинга.
 * @param {string} text
 */
function validateCityInput(text) {
  const v = normalizeText(text);
  if (!v) {
    return { ok: false, reason: 'empty' };
  }
  if (v.length > MAX_CITY_LEN) {
    return { ok: false, reason: 'long' };
  }
  return { ok: true, value: v };
}

module.exports = {
  STATES,
  MAX_NAME_LEN,
  MAX_CITY_LEN,
  validateDisplayName,
  validateCityInput,
  normalizeText,
};
