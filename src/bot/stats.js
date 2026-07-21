import { InlineKeyboard, Keyboard } from 'grammy';
import { getOperators, getOperatorStats, getOperatorCallsWithTranscripts, listOperatorNotes } from '../core/store.js';
import { operatorListKeyboard, periodKeyboard, operatorLabel } from './keyboards.js';
import { displayName } from './operators.js';
import { analyzeManager } from './analyze.js';
import { periodRange, formatKyiv } from './time.js';
import { sendLong, showScreen, withProgress } from './ui.js';

// Runs the per-period AI analysis (same /prompt as the reports) for one manager and sends it as a
// message under the already-shown stats header. Slow + paid (OpenAI, ~20-40s) and generated fresh
// every time — see the "Активне нагадування" in CLAUDE.md about future caching. Returns true when
// something was sent, false when there were no calls to analyse.
async function sendPeriodAnalysis(ctx, name, start, end) {
  const calls = await getOperatorCallsWithTranscripts(name, start, end);
  if (!calls.length) return false;
  const summary = await withProgress(
    ctx.api,
    ctx.chat.id,
    'typing',
    async () => (await analyzeManager(name, calls)).summary,
    { notice: '⏳ Формую розгорнутий аналіз за період… (це може зайняти до хвилини)' }
  );
  await sendLong(ctx.api, ctx.chat.id, summary, { parseMode: 'Markdown' });
  return true;
}

// Content for the "choose a manager" screen - reused by the inline button (edits the message)
// and by the /stats command and the quick-keyboard button (send a new message).
async function statsPicker() {
  const operators = await getOperators();
  if (!operators.length) {
    return { text: 'Поки немає оброблених дзвінків.', kb: new InlineKeyboard().text('« Меню', 'menu') };
  }
  return { text: '📊 Оберіть менеджера:', kb: operatorListKeyboard(operators, 'stat') };
}

function registerStats(bot) {
  bot.callbackQuery('stat:pick', async (ctx) => {
    const { text, kb } = await statsPicker();
    await ctx.answerCallbackQuery();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery(/^stat:op:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    await ctx.answerCallbackQuery();
    await showScreen(ctx, `${operatorLabel(name)} — оберіть період:`, periodKeyboard((p) => `stat:go:${p}:${name}`, 'stat:pick'));
  });

  bot.callbackQuery(/^stat:go:(day|week|month|quarter):(.+)$/, async (ctx) => {
    const period = ctx.match[1];
    const name = ctx.match[2];
    const { start, end, label } = periodRange(period);
    const s = await getOperatorStats(name, start, end);
    const rate = s.callCount ? Math.round((s.successCount / s.callCount) * 100) : 0;
    // The short numeric block always stays on top, regardless of the /prompt used for the analysis.
    const header =
      `${operatorLabel(name)} — ${label}\n` +
      `_${formatKyiv(start)} – ${formatKyiv(end)}_\n\n` +
      `Дзвінків: *${s.callCount}*\n` +
      `Успішних: *${s.successCount}* (${rate}%)\n` +
      `Середній бал: *${s.avgScore ?? '—'}*\n` +
      `Найчастіший слабкий етап: *${s.topWeakStage ?? '—'}*`;
    const kb = new InlineKeyboard()
      .text('📝 Додати нотатку', `note:add:${name}`)
      .text('🗒 Нотатки', `note:list:${name}`)
      .row()
      .text('« Періоди', `stat:op:${name}`)
      .text('« Меню', 'menu');
    await ctx.answerCallbackQuery();
    if (!s.callCount) {
      await showScreen(ctx, `${header}\n\n_Немає дзвінків за період для аналізу._`, kb);
      return;
    }
    // Header first (stays on top), then the AI analysis, then bring the action menu to the bottom.
    await sendLong(ctx.api, ctx.chat.id, header, { parseMode: 'Markdown' });
    await sendPeriodAnalysis(ctx, name, start, end);
    await showScreen(ctx, `${operatorLabel(name)} — дії:`, kb);
  });

  bot.callbackQuery(/^note:add:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    ctx.session.awaiting = { type: 'note', operator: name };
    await ctx.answerCallbackQuery();
    await ctx.reply(`📝 Надішліть текст нотатки для ${displayName(name)} одним повідомленням.`);
  });

  bot.callbackQuery(/^note:list:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    const notes = await listOperatorNotes(name, 10);
    await ctx.answerCallbackQuery();
    if (!notes.length) {
      await ctx.reply(`Нотаток для ${displayName(name)} ще немає.`);
      return;
    }
    const text =
      `🗒 Нотатки — *${displayName(name)}*\n\n` +
      notes
        .map((n) => `• ${formatKyiv(new Date(n.createdAt))}${n.author ? ` (${n.author})` : ''}\n${n.note}`)
        .join('\n\n');
    await sendLong(ctx.api, ctx.chat.id, text, { parseMode: 'Markdown' });
  });

  registerMyReport(bot);
}

// --- Manager self-report ("Мій звіт") -------------------------------------------------------
// A manager sees stats about THEMSELVES only, plus their phone number. Their identity comes from
// bot_users.operator_name (linked by the director when adding them), so it naturally includes any
// shared-handset calls that were attributed to that same name.

// Shared by the "📊 Мій звіт" button (me:pick) and the /myreport command.
async function openMyReport(ctx) {
  ctx.session.awaiting = null;
  if (!ctx.botUser?.operatorName) {
    await ctx.reply('Ваш акаунт ще не звʼязано з оператором. Зверніться до директора, щоб він привʼязав вас.');
    return;
  }
  await showScreen(ctx, '📊 Мій звіт — оберіть період:', periodKeyboard((p) => `me:go:${p}`, 'menu'));
}

function registerMyReport(bot) {
  bot.callbackQuery('me:pick', async (ctx) => {
    await ctx.answerCallbackQuery();
    await openMyReport(ctx);
  });

  bot.callbackQuery(/^me:go:(day|week|month|quarter)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const name = ctx.botUser?.operatorName;
    if (!name) {
      await ctx.reply('Ваш акаунт ще не звʼязано з оператором. Зверніться до директора.');
      return;
    }
    const period = ctx.match[1];
    const { start, end, label } = periodRange(period);
    const s = await getOperatorStats(name, start, end);
    const rate = s.callCount ? Math.round((s.successCount / s.callCount) * 100) : 0;
    const phone = ctx.botUser?.phone ? `+${ctx.botUser.phone}` : 'не збережено';
    // Numeric block stays on top; the AI analysis (same /prompt) follows below.
    const header =
      `📊 *Мій звіт* — ${label}\n` +
      `_${formatKyiv(start)} – ${formatKyiv(end)}_\n\n` +
      `Оператор: *${displayName(name)}*\n` +
      `Телефон: ${phone}\n\n` +
      `Дзвінків: *${s.callCount}*\n` +
      `Успішних: *${s.successCount}* (${rate}%)\n` +
      `Середній бал: *${s.avgScore ?? '—'}*\n` +
      `Найчастіший слабкий етап: *${s.topWeakStage ?? '—'}*`;
    const kb = new InlineKeyboard()
      .text('☎️ Оновити мій номер', 'me:phone')
      .row()
      .text('« Період', 'me:pick')
      .text('« Меню', 'menu');
    if (!s.callCount) {
      await showScreen(ctx, `${header}\n\n_Немає дзвінків за період для аналізу._`, kb);
      return;
    }
    await sendLong(ctx.api, ctx.chat.id, header, { parseMode: 'Markdown' });
    await sendPeriodAnalysis(ctx, name, start, end);
    await showScreen(ctx, '📊 Мій звіт — дії:', kb);
  });

  // Let a manager store their own phone (request_users doesn't return a phone, so a manager added
  // from contacts has none until they share it here).
  bot.callbackQuery('me:phone', async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.awaiting = { type: 'save_phone' };
    await ctx.reply('Натисніть кнопку нижче, щоб зберегти свій номер телефону.', {
      reply_markup: new Keyboard().requestContact('📱 Поділитися моїм номером').row().text('✖️ Скасувати').resized().oneTime(),
    });
  });
}

export { registerStats, statsPicker, openMyReport };
