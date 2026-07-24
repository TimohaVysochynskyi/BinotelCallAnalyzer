import 'dotenv/config';
import { Bot, session } from 'grammy';
import {
  migrate,
  migrateKb,
  activatePendingByPhone,
  setBotUserPhone,
  normalizePhone,
} from '../core/store.js';
import { mainMenu } from './keyboards.js';
import { registerStats, statsPicker, openMyReport } from './stats.js';
import { registerArchive, archivePicker } from './archive.js';
import { registerKnowledgeBase, answerQuestion, promptQuestion, openFiles, openKbDocById } from './kb.js';
import { sendManualReport, startScheduler } from './report.js';
import { registerPrompt, openPromptMenu } from './prompt.js';
import { registerRubric, openRubricMenu } from './rubric.js';
import { registerRoles, openRolesMenu, addByPhoneText } from './roles.js';
import { registerSettings, openSettings, addRecipientByIdText } from './settings.js';
import { setAnalyzePrompt } from './analyze.js';
import { setScoreRubric } from '../core/classifyCall.js';
import { formatPhone } from './operators.js';
import {
  getUser,
  canAccess,
  featureOf,
  isAdmin,
  ROLES,
  ROLE_LABELS,
  invalidateRole,
  seedDirectors,
} from './access.js';
import { sendLong, withProgress, showScreen, installMessageTracker } from './ui.js';

// Knowledge base needs pgvector; migrateKb() at startup flips this on. Handlers degrade
// gracefully when it's false.
const kbState = { ready: false };

// One Telegram bot serves everything: the interactive report bot here AND the ingest's
// outbound alerts (core/telegram.js) - same token. sendMessage (alerts) does not conflict with
// getUpdates (this bot). Must be a clean bot with no webhook (NOT @obvcarservicebot).
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set - put the token of the clean bot from @BotFather there');
}

const bot = new Bot(token);
// Track outgoing message ids so showScreen knows whether a tapped menu is still at the bottom.
installMessageTracker(bot);

// Session first, so ctx.session is available to the auth middleware (self-claim / menus).
bot.use(session({ initial: () => ({ awaiting: null, screenId: null }) }));

const cancelKeyboard = () => ({ remove_keyboard: true });
const isCancel = (t) => /^\s*(✖️|❌)?\s*скасувати\b/i.test(t || '');

// --- Access control (role lookup + per-feature gate + self-claim) ---------------------------
bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  const user = await getUser(id);

  if (user && user.status === 'active') {
    ctx.botUser = user;
    ctx.role = user.role;
    const feature = featureOf(ctx);
    if (feature && !canAccess(user.role, feature)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '⛔ Немає доступу до цієї функції', show_alert: true }).catch(() => {});
      else await ctx.reply('⛔ Ця функція недоступна для вашої ролі.').catch(() => {});
      return;
    }
    return next();
  }

  // Unknown user. Allow self-claim: if they share THEIR OWN contact and a pending invite matches
  // their phone, activate it. Otherwise deny and offer the share-contact button.
  const contact = ctx.message?.contact;
  if (contact && (contact.user_id == null || contact.user_id === id)) {
    const activated = await activatePendingByPhone(contact.phone_number, {
      telegramId: id,
      username: ctx.from?.username,
      displayName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null,
    });
    if (activated) {
      invalidateRole(id);
      await ctx.reply(`✅ Доступ надано. Ваша роль: ${ROLE_LABELS[activated.role]}.`, { reply_markup: cancelKeyboard() });
      await setCommandsForRole(ctx.api, id, activated.role);
      await showScreen(ctx, 'Оберіть дію:', mainMenu(activated.role));
      return;
    }
    await ctx.reply('Вашого номера немає серед запрошених. Зверніться до директора, щоб він вас додав.', {
      reply_markup: cancelKeyboard(),
    });
    return;
  }

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: '⛔ Немає доступу', show_alert: true }).catch(() => {});
  } else {
    await ctx
      .reply(
        `⛔ Немає доступу до цього бота.\nВаш ID: ${id ?? '—'}\n\n` +
          'Якщо ви співробітник — поділіться своїм номером кнопкою нижче, щоб увійти (директор має вас попередньо додати).',
        { reply_markup: { keyboard: [[{ text: '📱 Поділитися номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
      )
      .catch(() => {});
  }
});

// --- Per-role native command list -----------------------------------------------------------
const CMD = {
  menu: { command: 'menu', description: '☰ Головне меню' },
  stats: { command: 'stats', description: '📊 Статистика менеджера' },
  archive: { command: 'archive', description: '🗂 Архів розмов' },
  ask: { command: 'ask', description: '📚 База знань' },
  files: { command: 'files', description: '📁 Файли (база знань)' },
  report: { command: 'report', description: '🔄 Звіт зараз' },
  prompt: { command: 'prompt', description: '🧠 Промпт аналізу' },
  rubric: { command: 'rubric', description: '⭐ Рубрика оцінки' },
  roles: { command: 'roles', description: '👥 Ролі' },
  settings: { command: 'settings', description: '⚙️ Налаштування' },
  myreport: { command: 'myreport', description: '📊 Моя статистика' },
};

function commandsForRole(role) {
  if (isAdmin(role)) return [CMD.menu, CMD.stats, CMD.archive, CMD.ask, CMD.files, CMD.report, CMD.prompt, CMD.rubric, CMD.roles, CMD.settings];
  if (role === ROLES.MANAGER) return [CMD.menu, CMD.myreport, CMD.ask];
  return [CMD.menu, CMD.ask]; // mechanic
}

async function setCommandsForRole(api, chatId, role) {
  await api
    .setMyCommands(commandsForRole(role), { scope: { type: 'chat', chat_id: chatId } })
    .catch((e) => console.error(`[bot] setMyCommands(chat) failed: ${e.message}`));
}

// --- Main menu / navigation helpers --------------------------------------------------------
async function openMenu(ctx) {
  ctx.session.awaiting = null;
  await setCommandsForRole(ctx.api, ctx.chat.id, ctx.role);
  await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
}

async function openStats(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = await statsPicker();
  await showScreen(ctx, text, kb);
}

async function openArchive(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = await archivePicker();
  await showScreen(ctx, text, kb);
}

async function openAsk(ctx) {
  await promptQuestion(ctx, kbState);
}

async function openFilesMenu(ctx) {
  ctx.session.awaiting = null;
  await openFiles(ctx, kbState);
}

// Report is content, not a screen: after it, bring the menu back to the bottom (in focus).
async function runReport(ctx) {
  await sendManualReport(ctx.api, ctx.chat.id);
  await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
}

// --- Commands (native "Menu" button next to the input lists these) -------------------------
bot.command('start', async (ctx) => {
  // Deep-link from a KB source citation: /start kbdoc_<id> → resend that original file (role-checked
  // inside openKbDocById), then stop — don't show the welcome/menu over it.
  const payload = (ctx.match || '').trim();
  const kbDoc = /^kbdoc_(\d+)$/.exec(payload);
  if (kbDoc) {
    await openKbDocById(ctx, Number(kbDoc[1]), ctx.role);
    return;
  }
  // The persistent quick keyboard was removed; clear it from existing clients once, then menu.
  await ctx.reply('Вітаю! Керування — кнопкою «Menu» біля поля вводу або в меню нижче.', {
    reply_markup: { remove_keyboard: true },
  });
  await openMenu(ctx);
});
bot.command('menu', openMenu);
bot.command('stats', openStats);
bot.command('archive', openArchive);
bot.command('ask', openAsk);
bot.command('files', openFilesMenu);
bot.command('prompt', openPromptMenu);
bot.command('rubric', openRubricMenu);
bot.command('report', runReport);
bot.command('roles', openRolesMenu);
bot.command('settings', openSettings);
bot.command('myreport', openMyReport);

// --- Inline callbacks ----------------------------------------------------------------------
bot.callbackQuery('menu', async (ctx) => {
  ctx.session.awaiting = null;
  await ctx.answerCallbackQuery();
  await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
});

bot.callbackQuery('report:now', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Генерую звіт…' });
  await runReport(ctx);
});

// --- Feature modules -----------------------------------------------------------------------
registerStats(bot);
registerArchive(bot);
registerKnowledgeBase(bot, kbState);
registerPrompt(bot);
registerRubric(bot);
registerRoles(bot);
registerSettings(bot);

// A manager saving their own phone number (request_users doesn't return a phone). Last in the
// contact chain — the roles.js and settings.js contact handlers pass non-add contacts through via
// next() until they reach here.
bot.on('message:contact', async (ctx) => {
  const st = ctx.session.awaiting;
  if (st?.type !== 'save_phone') return;
  const c = ctx.message.contact;
  if (c.user_id != null && c.user_id !== ctx.from.id) {
    await ctx.reply('Поділіться, будь ласка, СВОЇМ номером.');
    return;
  }
  await setBotUserPhone(ctx.from.id, c.phone_number);
  invalidateRole(ctx.from.id);
  ctx.session.awaiting = null;
  await ctx.reply(`✅ Номер збережено: ${formatPhone(c.phone_number)}.`, { reply_markup: { remove_keyboard: true } });
  await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
});

// --- Free-text input: routed by the current "awaiting" step --------------------------------
bot.on('message:text', async (ctx) => {
  const st = ctx.session.awaiting;

  if (st && isCancel(ctx.message.text)) {
    ctx.session.awaiting = null;
    await ctx.reply('Скасовано.', { reply_markup: { remove_keyboard: true } });
    await showScreen(ctx, 'Оберіть дію:', mainMenu(ctx.role));
    return;
  }

  if (st?.type === 'role_add') {
    await addByPhoneText(ctx, st.role);
    return;
  }

  if (st?.type === 'settings_add') {
    await addRecipientByIdText(ctx, st.kind);
    return;
  }

  if (st?.type === 'save_phone') {
    await ctx.reply('Скористайтеся кнопкою «📱 Поділитися моїм номером» нижче, або « Скасувати.');
    return;
  }

  if (st?.type === 'prompt') {
    await setAnalyzePrompt(ctx.message.text);
    ctx.session.awaiting = null;
    await ctx.reply('✅ Промпт оновлено — застосується до наступних аналізів і звітів.', { reply_markup: mainMenu(ctx.role) });
    return;
  }

  if (st?.type === 'rubric') {
    await setScoreRubric(ctx.message.text);
    ctx.session.awaiting = null;
    await ctx.reply('✅ Рубрику оцінки оновлено — застосується до наступних дзвінків.', { reply_markup: mainMenu(ctx.role) });
    return;
  }

  if (st?.type === 'kb_question') {
    // Stay in question mode so follow-up questions keep working. The user leaves by opening the
    // menu (/menu or « Меню).
    try {
      const answer = await withProgress(
        ctx.api,
        ctx.chat.id,
        'typing',
        () => answerQuestion(ctx.message.text, ctx.role, ctx.me?.username),
        { notice: '⏳ Бот обробляє запит, це може зайняти деякий час…' }
      );
      // HTML so the source filenames render as clickable deep-links (Markdown breaks on "_" in names).
      await sendLong(ctx.api, ctx.chat.id, answer, { parseMode: 'HTML' });
    } catch (err) {
      console.error(`[bot] KB answer failed: ${err.message}`);
      await ctx.reply(`❌ Не вдалося відповісти: ${err.message}`);
    }
    await ctx.reply('Ще питання? Напишіть його наступним повідомленням, або відкрийте /menu, щоб вийти.');
    return;
  }

  await ctx.reply('Скористайтеся кнопкою «Menu» біля поля вводу або командою /menu.');
});

bot.catch((err) => {
  console.error(`[bot] handler error: ${err.error?.message || err.message}`);
});

async function main() {
  await migrate();

  const seeded = await seedDirectors();
  console.log(`[bot] seeded ${seeded} director(s) from env`);

  // Knowledge base is optional - if pgvector isn't available, the rest of the bot still runs.
  try {
    await migrateKb();
    kbState.ready = true;
    console.log('[bot] knowledge base ready (pgvector)');
  } catch (err) {
    console.error(`[bot] knowledge base DISABLED: ${err.message}`);
  }

  // Default command list (shown before a role-scoped list is set for a chat). Per-role lists are
  // applied lazily via setCommandsForRole when a user opens the menu.
  await bot.api
    .setMyCommands([CMD.menu, CMD.ask])
    .catch((e) => console.error(`[bot] setMyCommands failed: ${e.message}`));
  await bot.api
    .setChatMenuButton({ menu_button: { type: 'commands' } })
    .catch((e) => console.error(`[bot] setChatMenuButton failed: ${e.message}`));

  // Recipients for the auto-reports are managed in-bot (/settings → "Щоденні звіти"), read from
  // the DB on each slot — so the scheduler always runs and needs no env chat.
  startScheduler(bot.api);

  await bot.start({
    onStart: (info) => console.log(`[bot] @${info.username} started (long polling)`),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
