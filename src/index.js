/**
 * Точка входа: Telegraf, сессии в памяти, команды и ввод города.
 */

const path = require('path');

// Загружаем .env из папки проекта, а не из текущей директории терминала — иначе токен не найдётся.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Telegraf } = require('telegraf');
const { MESSAGES, SERVICES, MASTERS } = require('./data');
const { geocodeRussia, fetchTodayForecast } = require('./weather');

// Карта chatId → объект сессии: храним состояние FSM в памяти процесса.
const sessionStore = new Map();

/** FSM: одно состояние ожидания города (idle) — расширяемо при необходимости. */
const STATES = { IDLE: 'idle' };

/**
 * Возвращает сессию чата, создавая запись при первом обращении.
 * @param {import('telegraf').Context} ctx
 */
function getSession(ctx) {
  const id = ctx.chat?.id;
  if (id == null) return { state: STATES.IDLE };
  if (!sessionStore.has(id)) {
    sessionStore.set(id, { state: STATES.IDLE });
  }
  return sessionStore.get(id);
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

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Задайте BOT_TOKEN в файле .env');
  process.exit(1);
}

const bot = new Telegraf(token);

// Регистрируем команды в меню Telegram (видны при вводе /); ошибки только в лог, не роняем процесс.
bot.telegram
  .setMyCommands([
    { command: 'start', description: 'Начать' },
    { command: 'info', description: 'Услуги и мастера' },
    { command: 'help', description: 'Помощь' },
  ])
  .catch((e) => console.error('setMyCommands:', e.message));

// /start — короткое приветствие без блока про студию и услуги.
bot.start((ctx) => {
  getSession(ctx).state = STATES.IDLE;
  return ctx.reply(MESSAGES.welcome);
});

// /info — вывод захардкоженных услуг и мастеров (бизнес-данные).
bot.command('info', (ctx) => {
  getSession(ctx).state = STATES.IDLE;
  return ctx.reply(formatInfoText());
});

// /help — краткая справка по сценарию погоды.
bot.command('help', (ctx) => {
  getSession(ctx).state = STATES.IDLE;
  return ctx.reply(
    'Напиши название города в России (например: Москва, Казань).\n' +
      'Пришлю прогноз на сегодня: утро, день, вечер, ветер и условия (осадки, облачность).\n' +
      'Команда /info — услуги и мастера.'
  );
});

/**
 * Обрабатывает текст как запрос погоды по городу (состояние idle).
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

// Текстовые сообщения: в состоянии idle трактуем как название города.
bot.on('text', async (ctx, next) => {
  const s = getSession(ctx);
  if (s.state !== STATES.IDLE) {
    return next();
  }
  const t = ctx.message.text;
  if (t.startsWith('/')) {
    return next();
  }
  // Оборачиваем в try/catch: при сбое сети/API пользователь всё равно получит ответ, а не тишину.
  try {
    await handleCityText(ctx, t);
  } catch (e) {
    console.error('handleCityText:', e);
    await ctx.reply(MESSAGES.weatherFailed);
  }
});

// Если прислали не текст (стикер, геолокация со скрепки и т.д.) — короткая подсказка.
bot.on('message', async (ctx, next) => {
  if (ctx.message.text != null) {
    return next();
  }
  await ctx.reply(
    'Чтобы узнать погоду, напиши название города текстом в поле ввода и нажми «Отправить».'
  );
});

bot.catch((err, ctx) => {
  console.error('Ошибка Telegraf:', err);
  if (ctx?.reply) {
    ctx.reply('Произошла ошибка. Попробуй ещё раз позже.');
  }
});

// Запуск long polling: сброс webhook внутри launch + явное сообщение, какой бот слушает чат.
bot
  .launch(() => {
    const u = bot.botInfo?.username;
    console.log('---');
    console.log(`Ок, бот подключён: @${u}`);
    console.log('Открой в Telegram именно этого бота и отправь /start');
    console.log('Не закрывай это окно — пока оно открыто, бот отвечает.');
    console.log('---');
  })
  .catch((err) => {
    console.error('Ошибка запуска (проверь BOT_TOKEN в .env):', err.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
