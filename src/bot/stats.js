import { InlineKeyboard } from 'grammy';
import { getOperators, getOperatorStats, listOperatorNotes } from '../core/store.js';
import { operatorListKeyboard, periodKeyboard, operatorLabel } from './keyboards.js';
import { periodRange, formatKyiv } from './time.js';
import { sendLong } from './ui.js';

async function safeEdit(ctx, text, keyboard) {
  await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
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
    await safeEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^stat:op:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    await ctx.answerCallbackQuery();
    await safeEdit(ctx, `${operatorLabel(name)} — оберіть період:`, periodKeyboard((p) => `stat:go:${p}:${name}`, 'stat:pick'));
  });

  bot.callbackQuery(/^stat:go:(day|week|month|quarter):(.+)$/, async (ctx) => {
    const period = ctx.match[1];
    const name = ctx.match[2];
    const { start, end, label } = periodRange(period);
    const s = await getOperatorStats(name, start, end);
    const rate = s.callCount ? Math.round((s.successCount / s.callCount) * 100) : 0;
    const text =
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
    await safeEdit(ctx, text, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^note:add:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    ctx.session.awaiting = { type: 'note', operator: name };
    await ctx.answerCallbackQuery();
    await ctx.reply(`📝 Надішліть текст нотатки для *${name}* одним повідомленням.`, { parse_mode: 'Markdown' });
  });

  bot.callbackQuery(/^note:list:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    const notes = await listOperatorNotes(name, 10);
    await ctx.answerCallbackQuery();
    if (!notes.length) {
      await ctx.reply(`Нотаток для ${name} ще немає.`);
      return;
    }
    const text =
      `🗒 Нотатки — *${name}*\n\n` +
      notes
        .map((n) => `• ${formatKyiv(new Date(n.createdAt))}${n.author ? ` (${n.author})` : ''}\n${n.note}`)
        .join('\n\n');
    await sendLong(ctx.api, ctx.chat.id, text, { parseMode: 'Markdown' });
  });
}

export { registerStats, statsPicker };
