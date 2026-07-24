import { InlineKeyboard, Keyboard } from 'grammy';
import { getOperators, getOperatorStats, getBucketedTrend } from '../core/store.js';
import { operatorListKeyboard, periodKeyboard, operatorLabel } from './keyboards.js';
import { displayName, formatPhone } from './operators.js';
import { deliverManagerReport } from './report.js';
import { buildDynamicsText } from './dynamics.js';
import { periodRange, formatKyiv } from './time.js';
import { showScreen, withProgress } from './ui.js';

// Content for the "choose a manager" screen - reused by the inline button (edits the message)
// and by the /stats command.
async function statsPicker() {
  const operators = await getOperators();
  if (!operators.length) {
    return { text: 'Поки немає оброблених дзвінків.', kb: new InlineKeyboard().text('« Меню', 'menu') };
  }
  return { text: '📊 Оберіть менеджера:', kb: operatorListKeyboard(operators, 'stat') };
}

// Growth dashboard for a manager — the primary screen. Numeric trajectory + weak-stage evolution +
// growth verdict across the last buckets (weeks or months). Text-only, no LLM (getBucketedTrend is
// one live SQL query), so it's instant. The classic per-period evidence report is a drill-down.
async function showDynamics(ctx, name, bucket) {
  const limit = bucket === 'month' ? 6 : 8;
  const buckets = await getBucketedTrend(name, bucket, limit);
  const text = buildDynamicsText(name, bucket, buckets);
  const tick = (b) => (b === bucket ? ' ✓' : '');
  const kb = new InlineKeyboard()
    .text(`📅 Тижні${tick('week')}`, `stat:dyn:week:${name}`)
    .text(`🗓 Місяці${tick('month')}`, `stat:dyn:month:${name}`)
    .row()
    .text('📊 Звіт за період →', `stat:rep:${name}`)
    .row()
    .text('« Менеджери', 'stat:pick')
    .text('« Меню', 'menu');
  await showScreen(ctx, text, kb);
}

function registerStats(bot) {
  bot.callbackQuery('stat:pick', async (ctx) => {
    const { text, kb } = await statsPicker();
    await ctx.answerCallbackQuery();
    await showScreen(ctx, text, kb);
  });

  // Manager landing = the GROWTH dashboard (numeric trajectory + weak-stage evolution + verdict),
  // not a one-off effectiveness report. The per-period evidence report is one tap away (stat:rep).
  bot.callbackQuery(/^stat:op:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDynamics(ctx, ctx.match[1], 'week');
  });

  // Toggle bucket granularity (weeks ⇄ months).
  bot.callbackQuery(/^stat:dyn:(week|month):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showDynamics(ctx, ctx.match[2], ctx.match[1]);
  });

  // Drill-down: the classic per-period evidence report.
  bot.callbackQuery(/^stat:rep:(.+)$/, async (ctx) => {
    const name = ctx.match[1];
    await ctx.answerCallbackQuery();
    await showScreen(ctx, `${operatorLabel(name)} — звіт за період:`, periodKeyboard((p) => `stat:go:${p}:${name}`, `stat:op:${name}`));
  });

  bot.callbackQuery(/^stat:go:(day|week|month|quarter):(.+)$/, async (ctx) => {
    const period = ctx.match[1];
    const name = ctx.match[2];
    const { start, end } = periodRange(period);
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('« Періоди', `stat:rep:${name}`)
      .text('📈 Динаміка', `stat:op:${name}`)
      .row()
      .text('« Меню', 'menu');
    // The full evidence report (numeric header + findings + audio clips) is admin-only. It's built
    // from the cached per-segment analysis (report.js) and cuts audio for negatives.
    const res = await withProgress(
      ctx.api,
      ctx.chat.id,
      'upload_voice',
      // 'day' → segmented cache (frozen segments + live tail); longer periods → per-day trend +
      // findings of already-frozen segments (reuse only, no costly on-demand recompute of history).
      () => deliverManagerReport(ctx.api, ctx.chat.id, name, start, end, { audio: true, mode: period === 'day' ? 'daily' : 'trend' }),
      { notice: '⏳ Формую доказовий звіт (аналіз + аудіо), це може зайняти деякий час…' }
    );
    if (res.empty) {
      await showScreen(ctx, `${operatorLabel(name)}\n\nНемає оброблених дзвінків за період.`, kb);
      return;
    }
    await showScreen(ctx, `${operatorLabel(name)} — дії:`, kb);
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
