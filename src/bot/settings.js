import { InlineKeyboard, Keyboard } from 'grammy';
import {
  getRecipients,
  addRecipient,
  removeRecipient,
  getReportTimes,
  addReportTime,
  removeReportTime,
} from '../core/store.js';
import { formatPhone } from './operators.js';
import { showScreen } from './ui.js';

// Admin-only "Налаштування" (/settings, native "Menu" button — deliberately NOT an inline main-menu
// button). Two recipient lists live here, both stored in app_state as JSON { id, name } arrays:
//   alert  — where ingest failure alerts are sent (core/telegram.js sendAlert)
//   report — where the daily PDF auto-reports are sent (report.js scheduler)
// Each list can hold several people, so a message fans out to everyone on it. This replaces the old
// single TELEGRAM_CHAT_ID / BOT_REPORT_CHAT_ID env vars.
const KINDS = {
  alert: { title: 'Сповіщення про поломки', emoji: '⚠️' },
  report: { title: 'Щоденні звіти', emoji: '📊' },
};
const REQUEST_USERS_ID = 2; // distinct from roles.js's request_id (1); intent is tracked via awaiting

// --- Screens -------------------------------------------------------------------------------

function settingsMenu() {
  const kb = new InlineKeyboard()
    .text('⚠️ Отримувачі сповіщень', 'set:list:alert')
    .row()
    .text('📊 Отримувачі звітів', 'set:list:report')
    .row()
    .text('🕒 Час звітів', 'set:times')
    .row()
    .text('« Меню', 'menu');
  return {
    text:
      '⚙️ *Налаштування*\n\n' +
      '• *Отримувачі сповіщень* — кому слати повідомлення про поломки інжесту.\n' +
      '• *Отримувачі звітів* — кому слати щоденні PDF-звіти.\n' +
      '• *Час звітів* — о котрій (за Києвом) надсилати щоденні звіти.',
    kb,
  };
}

// --- Report times (Kyiv) — button picker so the format is always standard --------------------
const MINUTE_STEP = 10; // 00,10,20,30,40,50
const pad2 = (n) => String(n).padStart(2, '0');

async function timesScreen() {
  const times = await getReportTimes();
  const kb = new InlineKeyboard();
  for (const t of times) kb.text(`🗑 ${t}`, `set:timedel:${t.replace(':', '')}`).row();
  kb.text('➕ Додати час', 'set:timeadd').row();
  kb.text('« Назад', 'set');
  const body = times.length ? times.join(', ') : 'порожньо — щоденні звіти НЕ надсилаються.';
  return {
    text: `🕒 Час щоденних звітів (за Києвом):\n${body}\n\nДодайте або приберіть моменти надсилання.`,
    kb,
  };
}

function hourPicker() {
  const kb = new InlineKeyboard();
  for (let h = 0; h < 24; h++) {
    kb.text(pad2(h), `set:timeh:${h}`);
    if (h % 6 === 5) kb.row();
  }
  kb.text('« Назад', 'set:times');
  return kb;
}

function minutePicker(hour) {
  const kb = new InlineKeyboard();
  for (let m = 0; m < 60; m += MINUTE_STEP) kb.text(`${pad2(hour)}:${pad2(m)}`, `set:timem:${hour}:${m}`);
  kb.row().text('« Назад', 'set:timeadd');
  return kb;
}

async function listScreen(kind) {
  const meta = KINDS[kind];
  const list = await getRecipients(kind);
  const kb = new InlineKeyboard();
  for (const r of list) kb.text(`🗑 ${r.name}`, `set:del:${kind}:${r.id}`).row();
  kb.text('➕ Додати', `set:add:${kind}`).row();
  kb.text('« Назад', 'set');
  const body = list.length
    ? list.map((r) => `• ${r.name} (${r.id})`).join('\n')
    : 'поки нікого немає — нічого не надсилається.';
  return { text: `${meta.emoji} ${meta.title}\nКому надсилати:\n${body}`, kb };
}

// Reply keyboard for the add step: pick from contacts (request_users → Telegram id instantly) or
// share a contact card. request_users only works on a normal reply keyboard, not inline.
function addKeyboard() {
  return new Keyboard()
    .requestUsers('👤 Обрати з контактів', REQUEST_USERS_ID, {
      user_is_bot: false,
      request_name: true,
      request_username: true,
      max_quantity: 1,
    })
    .row()
    .requestContact('📱 Поділитися контактом')
    .row()
    .text('✖️ Скасувати')
    .resized()
    .oneTime();
}

// --- Add flow ------------------------------------------------------------------------------

async function afterAdded(ctx, kind, who) {
  await ctx.reply(`✅ Додано отримувача: ${who}.`, { reply_markup: { remove_keyboard: true } });
  const { text, kb } = await listScreen(kind);
  await showScreen(ctx, text, kb, { parseMode: null });
}

// request_users picker: gives us the Telegram id (+ name/username) without the person having opened
// the bot. NOTE: the bot still can't message them until they press Start (Telegram rule).
async function addByUsersShared(ctx, kind) {
  const users = ctx.message.users_shared?.users || [];
  if (!users.length) return;
  const names = [];
  for (const su of users) {
    const name = [su.first_name, su.last_name].filter(Boolean).join(' ') || (su.username ? `@${su.username}` : `id${su.user_id}`);
    await addRecipient(kind, { id: su.user_id, name });
    names.push(name);
  }
  ctx.session.awaiting = null;
  await afterAdded(ctx, kind, names.join(', '));
}

// Shared contact card. We need a Telegram user_id to be able to message them; a phone-only contact
// has no chat we can send to, so it's rejected with an explanation.
async function addByContact(ctx, kind) {
  const c = ctx.message.contact;
  if (!c.user_id) {
    ctx.session.awaiting = null;
    await ctx.reply(
      'ℹ️ Цей контакт не має Telegram-акаунта в спільних, тож бот не зможе йому писати. ' +
        'Оберіть людину, що вже користується ботом, або надішліть числовий ID чату.',
      { reply_markup: { remove_keyboard: true } }
    );
    const { text, kb } = await listScreen(kind);
    await showScreen(ctx, text, kb, { parseMode: null });
    return;
  }
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || formatPhone(c.phone_number);
  await addRecipient(kind, { id: c.user_id, name });
  ctx.session.awaiting = null;
  await afterAdded(ctx, kind, name);
}

// Typed numeric chat id fallback (routed from index.js's text handler). Lets an admin add a chat we
// can't reach via contacts — e.g. a GROUP (negative id) for alerts.
async function addRecipientByIdText(ctx, kind) {
  const raw = ctx.message.text.trim();
  if (!/^-?\d+$/.test(raw)) {
    await ctx.reply(
      'Це не схоже на Telegram ID чату. Надішліть числовий ID (напр. -5426146652 для групи), ' +
        'скористайтесь кнопками вище, або « Скасувати.'
    );
    return;
  }
  ctx.session.awaiting = null;
  await addRecipient(kind, { id: raw, name: `ID ${raw}` });
  await afterAdded(ctx, kind, `ID ${raw}`);
}

// --- Registration --------------------------------------------------------------------------

async function openSettings(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = settingsMenu();
  await showScreen(ctx, text, kb);
}

function registerSettings(bot) {
  bot.callbackQuery('set', async (ctx) => {
    ctx.session.awaiting = null;
    await ctx.answerCallbackQuery();
    const { text, kb } = settingsMenu();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery(/^set:list:(alert|report)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = await listScreen(ctx.match[1]);
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  bot.callbackQuery(/^set:add:(alert|report)$/, async (ctx) => {
    const kind = ctx.match[1];
    await ctx.answerCallbackQuery();
    ctx.session.awaiting = { type: 'settings_add', kind };
    await ctx.reply(
      `➕ Додаємо отримувача (${KINDS[kind].title}).\n\n` +
        '• «Обрати з контактів» — вибрати колегу з ваших Telegram-контактів (найпростіше).\n' +
        '• «Поділитися контактом» — переслати картку контакту.\n' +
        '• Або надішліть числовий ID чату (напр. -5426146652 для групи).\n\n' +
        '⚠️ Бот зможе писати людині лише після того, як вона відкриє бота й натисне Start.',
      { reply_markup: addKeyboard() }
    );
  });

  bot.callbackQuery(/^set:del:(alert|report):(-?\d+)$/, async (ctx) => {
    const kind = ctx.match[1];
    const id = ctx.match[2];
    await removeRecipient(kind, id);
    await ctx.answerCallbackQuery({ text: 'Видалено' });
    const { text, kb } = await listScreen(kind);
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  // --- Report times ---
  bot.callbackQuery('set:times', async (ctx) => {
    ctx.session.awaiting = null;
    await ctx.answerCallbackQuery();
    const { text, kb } = await timesScreen();
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  bot.callbackQuery('set:timeadd', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showScreen(ctx, '🕒 Оберіть годину (за Києвом):', hourPicker(), { parseMode: null });
  });

  bot.callbackQuery(/^set:timeh:(\d{1,2})$/, async (ctx) => {
    const hour = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await showScreen(ctx, `🕒 Година ${pad2(hour)} — оберіть хвилини:`, minutePicker(hour), { parseMode: null });
  });

  bot.callbackQuery(/^set:timem:(\d{1,2}):(\d{1,2})$/, async (ctx) => {
    const hhmm = `${pad2(Number(ctx.match[1]))}:${pad2(Number(ctx.match[2]))}`;
    await addReportTime(hhmm);
    await ctx.answerCallbackQuery({ text: `Додано ${hhmm}` });
    const { text, kb } = await timesScreen();
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  bot.callbackQuery(/^set:timedel:(\d{4})$/, async (ctx) => {
    const raw = ctx.match[1];
    const hhmm = `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
    await removeReportTime(hhmm);
    await ctx.answerCallbackQuery({ text: `Прибрано ${hhmm}` });
    const { text, kb } = await timesScreen();
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  // Adding: request_users picker and shared contacts. Guarded by the awaiting settings_add state;
  // when it's not our flow we pass through (next) so roles.js / the save_phone handler still work.
  bot.on('message:users_shared', async (ctx, next) => {
    const st = ctx.session.awaiting;
    if (st?.type !== 'settings_add') {
      if (next) await next();
      return;
    }
    await addByUsersShared(ctx, st.kind);
  });

  bot.on('message:contact', async (ctx, next) => {
    const st = ctx.session.awaiting;
    if (st?.type !== 'settings_add') {
      if (next) await next();
      return;
    }
    await addByContact(ctx, st.kind);
  });
}

export { registerSettings, openSettings, addRecipientByIdText };
