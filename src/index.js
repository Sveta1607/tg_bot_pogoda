/**
 * Точка входа: Telegraf, FSM с сохранением в SQLite, погода и профиль.
 */

const path = require('path');

// Загружаем .env из папки проекта (токен и путь к БД).
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Telegraf } = require('telegraf');
const { MESSAGES, SERVICES, MASTERS } = require('./data');
const { geocodeRussia, fetchTodayForecast } = require('./weather');
const {
  getSessionRow,
  saveSessionRow,
  clearSessionToIdle,
  getUser,
  upsertUser,
} = require('./db');
const {
  STATES,
  validateDisplayName,
  validateCityInput,
} = require('./fsm');

/**
 * Telegram chat id в личке совпадает с пользователем — используем как ключ сессии и БД.
 * @param {import('telegraf').Context} ctx
 */
function chatId(ctx) {
  return ctx.chat?.id;
}

/**
 * Текущая сессия FSM из БД (после перезапуска бота состояние не теряется).
 * @param {import('telegraf').Context} ctx
 */
function getSession(ctx) {
  const id = chatId(ctx);
  if (id == null) {
    return { state: STATES.IDLE, payload: {} };
  }
  const row = getSessionRow(id);
  return { state: row.state, payload: row.payload };
}

/**
 * Текст /info: мастера и услуги из констант.
 */
function formatInfoText() {
  const serviceLines = SERVICES.map(
    (s) => `• ${s.name} — ${s.priceRub} ₽, ${s.durationMin} мин`
  );
  const masterLines = MASTERS.map(
    (m) => `• ${m.name} — ${m.specialty}`
  );
  return (
    `${MESSAGES.infoHeader.replace(/\*/g, '')}` +
    'Услуги:\n' +
    serviceLines.join('\n') +
    '\n\nМастера:\n' +
    masterLines.join('\n')
  );
}

/**
 * Прогноз по строке города (геокодинг РФ + Open-Meteo).
 * @param {import('telegraf').Context} ctx
 * @param {string} text
 */
async function handleCityText(ctx, text) {
  const geo = await geocodeRussia(text);
  if (!geo.ok) {
    if (geo.reason === 'not_ru') {
      return ctx.reply(MESSAGES.notInRussia);
    }
    return ctx.reply(MESSAGES.cityNotFound);
  }

  try {
    const w = await fetchTodayForecast(geo.lat, geo.lon);
    return ctx.reply(
      MESSAGES.weatherOk({
        city: geo.name,
        windKmh: w.windKmh,
        tempMin: w.tempMin,
        tempMax: w.tempMax,
        periods: w.periods,
        dayOverview: w.dayOverview,
      })
    );
  } catch {
    return ctx.reply(MESSAGES.weatherFailed);
  }
}

/**
 * Сброс FSM в idle и ответ пользователю (команда /cancel и «Отмена»).
 * @param {import('telegraf').Context} ctx
 */
function handleCancel(ctx) {
  const id = chatId(ctx);
  if (id != null) {
    clearSessionToIdle(id);
  }
  return ctx.reply(MESSAGES.profileCancelled);
}

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Задайте BOT_TOKEN в файле .env');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.telegram
  .setMyCommands([
    { command: 'start', description: 'Начать' },
    { command: 'profile', description: 'Настроить профиль' },
    { command: 'myweather', description: 'Погода для города из профиля' },
    { command: 'cancel', description: 'Отменить шаг профиля' },
    { command: 'info', description: 'Услуги и мастера' },
    { command: 'help', description: 'Помощь' },
  ])
  .catch((e) => console.error('setMyCommands:', e.message));

// /start — приветствие и сброс FSM в главное меню.
bot.start((ctx) => {
  const id = chatId(ctx);
  if (id != null) {
    clearSessionToIdle(id);
  }
  return ctx.reply(MESSAGES.welcome);
});

// /profile — первый шаг онбординга: спрашиваем имя.
bot.command('profile', (ctx) => {
  const id = chatId(ctx);
  if (id == null) {
    return;
  }
  saveSessionRow(id, STATES.ONBOARDING_NAME, {});
  return ctx.reply(MESSAGES.profileAskName);
});

bot.command('cancel', handleCancel);
bot.hears(/^отмена$/i, handleCancel);

// /myweather — прогноз по городу из БД (если задан).
bot.command('myweather', async (ctx) => {
  const id = chatId(ctx);
  if (id == null) {
    return;
  }
  const u = getUser(id);
  if (!u?.default_city) {
    return ctx.reply(MESSAGES.profileNoDefaultCity);
  }
  try {
    await handleCityText(ctx, u.default_city);
  } catch (e) {
    console.error('myweather:', e);
    await ctx.reply(MESSAGES.weatherFailed);
  }
});

bot.command('info', (ctx) => ctx.reply(formatInfoText()));

bot.command('help', (ctx) =>
  ctx.reply(
    'Напиши город в России — пришлю прогноз на сегодня.\n' +
      '/profile — имя и город по умолчанию.\n' +
      '/myweather — прогноз для сохранённого города.\n' +
      '/cancel или «Отмена» — выйти из настройки профиля.\n' +
      '/info — услуги и мастера.'
  )
);

/**
 * Обработка текста в шагах FSM «имя» и «город», иначе — запрос погоды в idle.
 */
bot.on('text', async (ctx, next) => {
  const t = ctx.message.text;
  if (t.startsWith('/')) {
    return next();
  }

  const id = chatId(ctx);
  if (id == null) {
    return next();
  }

  const s = getSession(ctx);

  // Шаг 1: имя для профиля.
  if (s.state === STATES.ONBOARDING_NAME) {
    const v = validateDisplayName(t);
    if (!v.ok) {
      return ctx.reply(MESSAGES.profileInvalidName);
    }
    upsertUser(id, { display_name: v.value });
    saveSessionRow(id, STATES.ONBOARDING_CITY, { draftName: v.value });
    return ctx.reply(MESSAGES.profileAskCity(v.value));
  }

  // Шаг 2: город по умолчанию (только РФ, как в основном сценарии).
  if (s.state === STATES.ONBOARDING_CITY) {
    const cityCheck = validateCityInput(t);
    if (!cityCheck.ok) {
      if (cityCheck.reason === 'long') {
        return ctx.reply(MESSAGES.profileInvalidCityLen);
      }
      return ctx.reply(MESSAGES.profileCityEmpty);
    }
    const geo = await geocodeRussia(cityCheck.value);
    if (!geo.ok) {
      if (geo.reason === 'not_ru') {
        return ctx.reply(MESSAGES.notInRussia);
      }
      return ctx.reply(MESSAGES.cityNotFound);
    }
    const draftName = s.payload.draftName || 'друг';
    upsertUser(id, { default_city: geo.name });
    clearSessionToIdle(id);
    return ctx.reply(MESSAGES.profileSaved(draftName, geo.name));
  }

  // Главное меню: произвольный город → погода.
  if (s.state === STATES.IDLE) {
    try {
      await handleCityText(ctx, t);
    } catch (e) {
      console.error('handleCityText:', e);
      await ctx.reply(MESSAGES.weatherFailed);
    }
    return;
  }

  return next();
});

/**
 * Неизвестные команды вида /something — не падаем, подсказываем /help.
 */
bot.on('text', (ctx) => {
  const t = ctx.message.text;
  if (!t.startsWith('/')) {
    return;
  }
  return ctx.reply(MESSAGES.unknownCommand);
});

/**
 * Не текст (стикер, фото и т.д.): в онбординге просим текст; в idle — напоминание про город.
 */
bot.on('message', async (ctx, next) => {
  if (ctx.message.text != null) {
    return next();
  }
  const id = chatId(ctx);
  const s = id != null ? getSession(ctx) : { state: STATES.IDLE };
  if (s.state !== STATES.IDLE) {
    return ctx.reply(MESSAGES.needTextForProfile);
  }
  return ctx.reply(
    'Чтобы узнать погоду, напиши название города текстом или настрой профиль: /profile'
  );
});

bot.catch((err, ctx) => {
  console.error('Ошибка Telegraf:', err);
  if (ctx?.reply) {
    ctx.reply('Произошла ошибка. Попробуй ещё раз позже.');
  }
});

bot
  .launch(() => {
    const u = bot.botInfo?.username;
    console.log('---');
    console.log(`Ок, бот подключён: @${u}`);
    console.log(`БД: ${process.env.DATABASE_PATH || 'data/bot.sqlite'}`);
    console.log('Не закрывай это окно — пока оно открыто, бот отвечает.');
    console.log('---');
  })
  .catch((err) => {
    console.error('Ошибка запуска (проверь BOT_TOKEN в .env):', err.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
