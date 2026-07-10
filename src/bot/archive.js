import { InlineKeyboard, InputFile } from 'grammy';
import { getOperators, countOperatorCalls, listOperatorCalls, getCallByGeneralId } from '../core/store.js';
import { getCallRecordUrl } from '../core/binotel.js';
import { operatorListKeyboard, periodKeyboard, operatorLabel } from './keyboards.js';
import { periodRange, kyivParts, formatKyiv } from './time.js';
import { sendLong } from './ui.js';

const PAGE = 8;

async function safeEdit(ctx, text, keyboard) {
  await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => {});
}

function shortKyiv(date) {
  const p = kyivParts(new Date(date));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.day)}.${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
}

// Content for the "choose a manager" screen - reused by the inline button, the /archive
// command, and the quick-keyboard button.
async function archivePicker() {
  const operators = await getOperators();
  if (!operators.length) {
    return { text: 'Поки немає оброблених дзвінків.', kb: new InlineKeyboard().text('« Меню', 'menu') };
  }
  return { text: '🗂 Архів розмов — оберіть менеджера:', kb: operatorListKeyboard(operators, 'arch') };
}

function registerArchive(bot) {
  bot.callbackQuery('arch:pick', async (ctx) => {
    const { text, kb } = await archivePicker();
    await ctx.answerCallbackQuery();
    await safeEdit(ctx, text, kb);
  });

  bot.callbackQuery(/^arch:op:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    await ctx.answerCallbackQuery();
    await safeEdit(ctx, `${operatorLabel(name)} — оберіть період:`, periodKeyboard((p) => `arch:go:${p}:0:${name}`, 'arch:pick'));
  });

  bot.callbackQuery(/^arch:go:(day|week|month|quarter):(\d+):(.+)$/, async (ctx) => {
    const period = ctx.match[1];
    const offset = Number(ctx.match[2]);
    const name = ctx.match[3];
    const { start, end, label } = periodRange(period);
    const total = await countOperatorCalls(name, start, end);

    if (total === 0) {
      const back = new InlineKeyboard().text('« Періоди', `arch:op:${name}`).text('« Меню', 'menu');
      await safeEdit(ctx, `${operatorLabel(name)} — ${label}\nНемає оброблених дзвінків за період.`, back);
      await ctx.answerCallbackQuery();
      return;
    }

    const calls = await listOperatorCalls(name, start, end, PAGE, offset);
    const kb = new InlineKeyboard();
    for (const c of calls) {
      const btn = `${shortKyiv(c.startTime)} ${c.isSuccess ? '✅' : '❌'} бал ${c.communicationScore ?? '—'}`;
      kb.text(btn, `arch:call:${c.generalCallId}`).row();
    }
    if (offset > 0) kb.text('◀', `arch:go:${period}:${Math.max(0, offset - PAGE)}:${name}`);
    kb.text(`${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}`, 'noop');
    if (offset + PAGE < total) kb.text('▶', `arch:go:${period}:${offset + PAGE}:${name}`);
    kb.row().text('« Періоди', `arch:op:${name}`).text('« Меню', 'menu');

    await safeEdit(ctx, `${operatorLabel(name)} — ${label}\nОберіть дзвінок:`, kb);
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^arch:call:(.+)$/, async (ctx) => {
    const gid = ctx.match[1];
    await ctx.answerCallbackQuery();
    const c = await getCallByGeneralId(gid);
    if (!c) {
      await ctx.reply('Дзвінок не знайдено.');
      return;
    }
    const header =
      `📞 *Дзвінок* ${gid}\n` +
      `Менеджер: ${c.managerName ?? '—'}\n` +
      `Час: ${formatKyiv(new Date(c.startTime))}\n` +
      `Тип: ${c.callType ?? '—'}, тривалість: ${c.durationSec ?? '—'} с\n` +
      `Успіх: ${c.isSuccess ? 'так' : 'ні'}, бал: ${c.communicationScore ?? '—'}, слабкий етап: ${c.weakestStage ?? '—'}`;
    await ctx.reply(header, { parse_mode: 'Markdown' });
    // Transcript as plain text - it can contain characters that break markdown entities.
    await sendLong(ctx.api, ctx.chat.id, `📝 Розшифровка:\n\n${c.transcript || '(порожньо)'}`);
    await ctx.reply('Аудіо запису:', {
      reply_markup: new InlineKeyboard().text('🎧 Прослухати запис', `arch:play:${gid}`).row().text('« Меню', 'menu'),
    });
  });

  bot.callbackQuery(/^arch:play:(.+)$/, async (ctx) => {
    const gid = ctx.match[1];
    await ctx.answerCallbackQuery({ text: 'Готую аудіо…' });
    try {
      const url = await getCallRecordUrl(gid);
      if (!url) throw new Error('немає URL запису');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await ctx.replyWithAudio(new InputFile(buf, `call-${gid}.mp3`), { caption: `Запис дзвінка ${gid}` });
    } catch (err) {
      console.error(`[bot] audio for ${gid} failed: ${err.message}`);
      await ctx.reply(`Не вдалося надіслати аудіо: ${err.message}`);
    }
  });

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());
}

export { registerArchive, archivePicker };
