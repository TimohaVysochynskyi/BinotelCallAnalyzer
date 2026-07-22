import { InlineKeyboard, Keyboard } from 'grammy';
import { getOperators, getOperatorStats, listOperatorNotes } from '../core/store.js';
import { operatorListKeyboard, periodKeyboard, operatorLabel } from './keyboards.js';
import { displayName, formatPhone } from './operators.js';
import { deliverManagerReport } from './report.js';
import { periodRange, formatKyiv } from './time.js';
import { sendLong, showScreen, withProgress } from './ui.js';

// Content for the "choose a manager" screen - reused by the inline button (edits the message)
// and by the /stats command.
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
    const { start, end } = periodRange(period);
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('📝 Додати нотатку', `note:add:${name}`)
      .text('🗒 Нотатки', `note:list:${name}`)
      .row()
      .text('« Періоди', `stat:op:${name}`)
      .text('« Меню', 'menu');
    // The full evidence report (numeric header + findings + audio clips) is admin-only. It's built
    // from the cached per-call analysis (analyze.reduceFindings) and cuts audio for negatives.
    const res = await withProgress(
      ctx.api,
      ctx.chat.id,
      'upload_voice',
      () => deliverManagerReport(ctx.api, ctx.chat.id, name, start, end, { audio: true }),
      { notice: '⏳ Формую доказовий звіт (аналіз + аудіо), це може зайняти деякий час…' }
    );
    if (res.empty) {
      await showScreen(ctx, `${operatorLabel(name)}\n\nНемає оброблених дзвінків за період.`, kb);
      return;
    }
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

  registerMyStats(bot);
}

// --- Manager self-view ("Моя статистика") ---------------------------------------------------
// A manager sees ONLY their own numeric statistics (calls / conversion / score / weakest stage) +
// their phone. NOT the evidence report — that is an admin (director/marketer) tool. Their identity
// comes from bot_users.operator_name (linked by the director when adding them).

// Shared by the "📊 Моя статистика" button (me:pick) and the /myreport command.
async function openMyReport(ctx) {
  ctx.session.awaiting = null;
  if (!ctx.botUser?.operatorName) {
    await ctx.reply('Ваш акаунт ще не звʼязано з оператором. Зверніться до директора, щоб він привʼязав вас.');
    return;
  }
  await showScreen(ctx, '📊 Моя статистика — оберіть період:', periodKeyboard((p) => `me:go:${p}`, 'menu'));
}

function registerMyStats(bot) {
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
    const sales = s.salesCount ?? 0;
    const info = s.infoCount ?? 0;
    const rate = sales ? Math.round((s.successCount / sales) * 100) : 0;
    const phone = ctx.botUser?.phone ? formatPhone(ctx.botUser.phone) : 'не збережено';
    const header =
      `📊 *Моя статистика* — ${label}\n` +
      `_${formatKyiv(start)} – ${formatKyiv(end)}_\n\n` +
      `Оператор: *${displayName(name)}*\n` +
      `Телефон: ${phone}\n\n` +
      `Дзвінків: *${s.callCount}* (продажних: ${sales}, інформаційних: ${info})\n` +
      `Записів: *${s.successCount}* з ${sales} продажних (${rate}%)\n` +
      `Середній бал (продажні): *${s.avgScore ?? '—'}*\n` +
      `Найслабший етап (продажні): *${s.topWeakStage ?? '—'}*`;
    const kb = new InlineKeyboard()
      .text('☎️ Оновити мій номер', 'me:phone')
      .row()
      .text('« Період', 'me:pick')
      .text('« Меню', 'menu');
    const body = s.callCount ? header : `${header}\n\n_Немає дзвінків за період._`;
    await showScreen(ctx, body, kb);
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
