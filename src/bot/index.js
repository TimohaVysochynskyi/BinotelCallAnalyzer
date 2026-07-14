import 'dotenv/config';
import { Bot, session } from 'grammy';
import { migrate, migrateKb, addOperatorNote } from '../core/store.js';
import { mainMenu, quickKeyboard, QUICK } from './keyboards.js';
import { registerStats, statsPicker } from './stats.js';
import { registerArchive, archivePicker } from './archive.js';
import { registerKnowledgeBase, answerQuestion, promptQuestion } from './kb.js';
import { sendManualReport, startScheduler } from './report.js';
import { sendLong } from './ui.js';

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

// Owner-only allowlist; falls back to TELEGRAM_CHAT_ID (the owner/alert chat) so the owner has
// access out of the box. Empty everywhere => nobody is allowed; the bot replies with the user
// id so it can be added to BOT_ALLOWED_CHAT_IDS.
const ALLOWED = new Set(
  (process.env.BOT_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const REPORT_CHAT_ID =
  process.env.BOT_REPORT_CHAT_ID || process.env.TELEGRAM_CHAT_ID || [...ALLOWED][0] || null;

const bot = new Bot(token);

// --- Auth (runs first) ---------------------------------------------------------------------
bot.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (id && ALLOWED.has(String(id))) return next();

  const hint = ALLOWED.size === 0
    ? `Список доступу порожній. Додайте ваш ID у BOT_ALLOWED_CHAT_IDS і перезапустіть бота.\nВаш ID: ${id ?? '—'}`
    : `⛔ Немає доступу до цього бота.\nВаш ID: ${id ?? '—'}`;
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '⛔ Немає доступу', show_alert: true }).catch(() => {});
  else await ctx.reply(hint).catch(() => {});
  // do not call next() -> request stops here
});

bot.use(session({ initial: () => ({ awaiting: null }) }));

// --- Main menu / navigation helpers --------------------------------------------------------
async function openMenu(ctx) {
  ctx.session.awaiting = null;
  // Re-assert the persistent quick keyboard, then show the inline menu.
  await ctx.reply('☰ Головне меню:', { reply_markup: quickKeyboard() });
  await ctx.reply('Оберіть дію:', { reply_markup: mainMenu() });
}

async function openStats(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = await statsPicker();
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function openArchive(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = await archivePicker();
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function openAsk(ctx) {
  await promptQuestion(ctx, kbState);
}

// --- Commands (native "Menu" button next to the input lists these) -------------------------
bot.command(['start', 'menu'], openMenu);
bot.command('stats', openStats);
bot.command('archive', openArchive);
bot.command('ask', openAsk);
bot.command('report', async (ctx) => {
  await sendManualReport(ctx.api, ctx.chat.id);
});

// --- Inline callbacks ----------------------------------------------------------------------
bot.callbackQuery('menu', async (ctx) => {
  ctx.session.awaiting = null;
  await ctx.editMessageText('Оберіть дію:', { reply_markup: mainMenu() }).catch(() => {});
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('report:now', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Генерую звіт…' });
  await sendManualReport(ctx.api, ctx.chat.id);
});

// --- Feature modules -----------------------------------------------------------------------
registerStats(bot);
registerArchive(bot);
registerKnowledgeBase(bot, kbState);

// --- Free-text input: quick-keyboard buttons first, then the "add note" step ---------------
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Persistent quick-keyboard buttons send their label as text - route them (even mid-note).
  if (text === QUICK.menu) return openMenu(ctx);
  if (text === QUICK.stats) return openStats(ctx);
  if (text === QUICK.archive) return openArchive(ctx);
  if (text === QUICK.ask) return openAsk(ctx);
  if (text === QUICK.report) {
    ctx.session.awaiting = null;
    await sendManualReport(ctx.api, ctx.chat.id);
    return;
  }

  const st = ctx.session.awaiting;
  if (st?.type === 'note') {
    const author = ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id);
    await addOperatorNote(st.operator, author, ctx.message.text);
    ctx.session.awaiting = null;
    await ctx.reply(`✅ Нотатку збережено для ${st.operator}.`, { reply_markup: mainMenu() });
    return;
  }

  if (st?.type === 'kb_question') {
    ctx.session.awaiting = null;
    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      const answer = await answerQuestion(ctx.message.text);
      await sendLong(ctx.api, ctx.chat.id, answer);
    } catch (err) {
      console.error(`[bot] KB answer failed: ${err.message}`);
      await ctx.reply(`❌ Не вдалося відповісти: ${err.message}`);
    }
    await ctx.reply('Ще питання? Напишіть його, або скористайтесь меню.', { reply_markup: quickKeyboard() });
    return;
  }

  await ctx.reply('Скористайтеся меню нижче або кнопкою «☰ Меню».', { reply_markup: quickKeyboard() });
});

bot.catch((err) => {
  console.error(`[bot] handler error: ${err.error?.message || err.message}`);
});

async function main() {
  await migrate();

  // Knowledge base is optional - if pgvector isn't available, the rest of the bot still runs.
  try {
    await migrateKb();
    kbState.ready = true;
    console.log('[bot] knowledge base ready (pgvector)');
  } catch (err) {
    console.error(`[bot] knowledge base DISABLED: ${err.message}`);
  }

  // Native "Menu" button next to the input → lists these commands.
  await bot.api.setMyCommands([
    { command: 'menu', description: '☰ Головне меню' },
    { command: 'stats', description: '📊 Статистика менеджера' },
    { command: 'archive', description: '🗂 Архів розмов' },
    { command: 'ask', description: '❓ Поставити питання (база знань)' },
    { command: 'report', description: '🔄 Звіт зараз' },
  ]).catch((e) => console.error(`[bot] setMyCommands failed: ${e.message}`));
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } }).catch((e) => console.error(`[bot] setChatMenuButton failed: ${e.message}`));

  if (REPORT_CHAT_ID) {
    startScheduler(bot.api, REPORT_CHAT_ID);
  } else {
    console.warn('[bot] no BOT_REPORT_CHAT_ID / allowlist set - scheduled reports are OFF until configured');
  }

  await bot.start({
    onStart: (info) => console.log(`[bot] @${info.username} started (long polling), allowlist: ${ALLOWED.size} id(s)`),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
