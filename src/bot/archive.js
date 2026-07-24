import { InlineKeyboard, InputFile } from 'grammy';
import { getOperators, countOperatorCalls, listOperatorCalls, getCallByGeneralId } from '../core/store.js';
import { getCallRecordUrl } from '../core/binotel.js';
import { operatorListKeyboard, operatorLabel } from './keyboards.js';
import { displayName } from './operators.js';
import { formatDialogue } from './dialogue.js';
import { kyivParts, formatKyiv } from './time.js';
import { sendLong, withProgress, showScreen } from './ui.js';

const PAGE = 8;

// A transcript ingested via ElevenLabs is already a "Менеджер:/Клієнт:" dialogue — show it as is,
// instantly. Only the older/plain (OpenAI-fallback) transcripts need on-demand formatting.
const looksDiarized = (t) => /(^|\n)\s*(Менеджер|Клієнт)\s*:/.test(t || '');

// Non-sales calls (info/other) carry no effectiveness score — the ingest deliberately skips
// scoring them. Show a neutral purpose tag instead of a misleading 👎/бал. Sales calls (and
// legacy rows with a NULL purpose, treated as sales) keep the success/score display.
const isNonSales = (p) => p === 'info' || p === 'other';
const purposeLabel = (p) => (p === 'other' ? 'службовий' : 'інформаційний');

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
  return { text: '🗂 Архів розмов — оберіть менеджера:', kb: operatorListKeyboard(operators, 'arch', { showDates: true }) };
}

function registerArchive(bot) {
  bot.callbackQuery('arch:pick', async (ctx) => {
    const { text, kb } = await archivePicker();
    await ctx.answerCallbackQuery();
    await showScreen(ctx, text, kb);
  });

  // No period-picker step - straight to the (paginated) call list, newest first. The period step
  // only added an extra tap and hid older calls behind a period choice; pagination already handles
  // browsing progressively.
  bot.callbackQuery(/^arch:op:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    await ctx.answerCallbackQuery();
    await showArchivePage(ctx, name, 0);
  });

  bot.callbackQuery(/^arch:go:(\d+):(.+)$/, async (ctx) => {
    const offset = Number(ctx.match[1]);
    const name = ctx.match[2];
    await ctx.answerCallbackQuery();
    await showArchivePage(ctx, name, offset);
  });

  async function showArchivePage(ctx, name, offset) {
    const total = await countOperatorCalls(name);

    if (total === 0) {
      const back = new InlineKeyboard().text('« Менеджери', 'arch:pick').text('« Меню', 'menu');
      await showScreen(ctx, `${operatorLabel(name)}\nНемає оброблених дзвінків.`, back);
      return;
    }

    const calls = await listOperatorCalls(name, PAGE, offset);
    const kb = new InlineKeyboard();
    for (const c of calls) {
      const btn = isNonSales(c.callPurpose)
        ? `${shortKyiv(c.startTime)} ℹ️ ${purposeLabel(c.callPurpose)}`
        : `${shortKyiv(c.startTime)} ${c.isSuccess ? '👍' : '👎'} бал ${c.communicationScore ?? '—'}`;
      kb.text(btn, `arch:call:${c.generalCallId}`).row();
    }
    if (offset > 0) kb.text('◀', `arch:go:${Math.max(0, offset - PAGE)}:${name}`);
    kb.text(`${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}`, 'noop');
    if (offset + PAGE < total) kb.text('▶', `arch:go:${offset + PAGE}:${name}`);
    kb.row().text('« Менеджери', 'arch:pick').text('« Меню', 'menu');

    await showScreen(ctx, `${operatorLabel(name)}\nОберіть дзвінок:`, kb);
  }

  bot.callbackQuery(/^arch:call:(.+)$/, async (ctx) => {
    const gid = ctx.match[1];
    await ctx.answerCallbackQuery();
    const c = await getCallByGeneralId(gid);
    if (!c) {
      await ctx.reply('Дзвінок не знайдено.');
      return;
    }
    const evalLine = isNonSales(c.callPurpose)
      ? `Тип: ${purposeLabel(c.callPurpose)} (без оцінки продажів)`
      : `Успіх: ${c.isSuccess ? 'так' : 'ні'}, бал: ${c.communicationScore ?? '—'}, слабкий етап: ${c.weakestStage ?? '—'}`;
    const header =
      `📞 *Дзвінок* ${gid}\n` +
      `Менеджер: ${displayName(c.managerName) ?? '—'}\n` +
      `Час: ${formatKyiv(new Date(c.startTime))}\n` +
      `Тривалість: ${c.durationSec ?? '—'} с\n` +
      evalLine;
    // sendLong (not ctx.reply) so a manager name with markdown chars falls back to plain text.
    await sendLong(ctx.api, ctx.chat.id, header, { parseMode: 'Markdown' });
    if (looksDiarized(c.transcript)) {
      // Already a dialogue (ElevenLabs diarization at ingest) — show instantly, no extra request.
      await sendLong(ctx.api, ctx.chat.id, `📝 Розмова:\n\n${c.transcript}`);
    } else {
      // Older/plain transcript (pre-ElevenLabs or OpenAI fallback): format on-demand (~10-20s).
      // On failure fall back to raw text so the call is always viewable.
      let dialogue;
      try {
        dialogue = await withProgress(
          ctx.api,
          ctx.chat.id,
          'typing',
          () => formatDialogue(c.transcript),
          { notice: '⏳ Форматую розмову у діалог…' }
        );
      } catch (err) {
        console.error(`[bot] dialogue format ${gid} failed: ${err.message}`);
        dialogue = c.transcript || '(порожньо)';
      }
      await sendLong(ctx.api, ctx.chat.id, `📝 Розмова:\n\n${dialogue}`);
    }
    await ctx.reply('Аудіо запису:', {
      reply_markup: new InlineKeyboard().text('🎧 Прослухати запис', `arch:play:${gid}`).row().text('« Меню', 'menu'),
    });
  });

  bot.callbackQuery(/^arch:play:(.+)$/, async (ctx) => {
    const gid = ctx.match[1];
    await ctx.answerCallbackQuery({ text: 'Готую аудіо…' });
    try {
      // Fetch record URL from Binotel + download the mp3 + upload to Telegram can take 10-30s;
      // keep an "надсилає аудіо" indicator alive the whole time.
      await withProgress(ctx.api, ctx.chat.id, 'upload_voice', async () => {
        const url = await getCallRecordUrl(gid);
        if (!url) throw new Error('немає URL запису');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        await ctx.replyWithAudio(new InputFile(buf, `call-${gid}.mp3`), { caption: `Запис дзвінка ${gid}` });
      });
    } catch (err) {
      console.error(`[bot] audio for ${gid} failed: ${err.message}`);
      await ctx.reply(`Не вдалося надіслати аудіо: ${err.message}`);
    }
  });

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());
}

export { registerArchive, archivePicker };
