import { InlineKeyboard, Keyboard } from 'grammy';
import {
  getBotUsersByRole,
  getBotUserById,
  upsertBotUserByTelegram,
  addPendingBotUser,
  setBotUserOperator,
  deleteBotUser,
  getOperators,
} from '../core/store.js';
import { ROLES, ROLE_LABELS, invalidateRole } from './access.js';
import { operatorLabel } from './keyboards.js';
import { displayName } from './operators.js';
import { showScreen } from './ui.js';

// Only these three roles are managed from the UI (directors are seeded from env / promoted in DB;
// there's deliberately no "add role" and no way to create/remove a director from the buttons, so
// a marketer can't delete the seed owner). Order = how the buttons appear.
const MANAGEABLE_ROLES = [ROLES.MARKETER, ROLES.MANAGER, ROLES.MECHANIC];
const REQUEST_USERS_ID = 1; // request_id echoed back in users_shared; intent is tracked via awaiting

function fullName(ctx) {
  return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null;
}

// A short human line describing a member for the list / detail screens.
function memberLine(u) {
  const name = u.displayName || (u.username ? `@${u.username}` : null) || (u.phone ? `+${u.phone}` : `id${u.telegramId ?? '—'}`);
  const bits = [];
  if (u.username) bits.push(`@${u.username}`);
  if (u.phone) bits.push(`+${u.phone}`);
  if (u.operatorName) bits.push(`оператор: ${displayName(u.operatorName)}`);
  if (u.status === 'pending') bits.push('⏳ очікує входу');
  return bits.length ? `${name} (${bits.join(', ')})` : name;
}

// --- Screens -------------------------------------------------------------------------------

function rolesMenu() {
  const kb = new InlineKeyboard();
  for (const r of MANAGEABLE_ROLES) kb.text(`${ROLE_LABELS[r]}`, `roles:list:${r}`).row();
  kb.text('« Меню', 'menu');
  return { text: '👥 *Ролі*\nОберіть роль, щоб переглянути / додати людей:', kb };
}

async function roleListScreen(role) {
  const users = await getBotUsersByRole(role);
  const kb = new InlineKeyboard();
  for (const u of users) {
    const label = u.displayName || (u.username ? `@${u.username}` : null) || (u.phone ? `+${u.phone}` : `id${u.telegramId}`);
    kb.text(`${u.status === 'pending' ? '⏳ ' : ''}${label}`, `roles:u:${u.id}`).row();
  }
  kb.text('➕ Додати', `roles:add:${role}`).row();
  kb.text('« Ролі', 'roles');
  const list = users.length
    ? users.map((u) => `• ${memberLine(u)}`).join('\n')
    : 'поки нікого немає.';
  return { text: `${ROLE_LABELS[role]} — люди на ролі:\n${list}`, kb };
}

async function memberScreen(id) {
  const u = await getBotUserById(id);
  if (!u) return null;
  const kb = new InlineKeyboard();
  if (u.role === ROLES.MANAGER) kb.text('🔗 Змінити оператора', `roles:oppick:${u.id}`).row();
  kb.text('🗑 Видалити', `roles:del:${u.id}`).row().text('« Назад', `roles:list:${u.role}`);
  const text =
    `${ROLE_LABELS[u.role]}\n${memberLine(u)}\n\n` +
    'Дії з людиною:';
  return { text, kb };
}

// Roster of known operators (names Binotel gave) so a director can link a manager to their calls.
async function operatorPickScreen(memberId) {
  const operators = await getOperators();
  const kb = new InlineKeyboard();
  for (const o of operators) kb.text(`${operatorLabel(o.name)} (${o.n})`, `roles:setop:${memberId}:${o.name}`).row();
  kb.text('« Пропустити', `roles:u:${memberId}`);
  return {
    text: 'Оберіть, ЯКИЙ оператор (за даними Binotel) — це ця людина, щоб вона бачила статистику по собі:',
    kb,
  };
}

// Reply keyboard for the "add person" step: pick from contacts (request_users, gives us their
// Telegram id instantly) or share/enter a phone. Sent as a normal reply keyboard because
// request_users only works there, not on inline keyboards.
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

// After a person is added: managers need an operator link (offer the roster), others go straight
// back to the role list. Always clears the reply keyboard first.
async function afterAdded(ctx, role, memberId, who) {
  await ctx.reply(`✅ Додано на роль «${ROLE_LABELS[role]}»: ${who}.`, { reply_markup: { remove_keyboard: true } });
  if (role === ROLES.MANAGER) {
    const { text, kb } = await operatorPickScreen(memberId);
    await showScreen(ctx, text, kb, { parseMode: null });
    return;
  }
  const { text, kb } = await roleListScreen(role);
  await showScreen(ctx, text, kb, { parseMode: null });
}

// Add via the request_users picker: we get the Telegram id (+ name/username) with no need for the
// person to have opened the bot first.
async function addByUsersShared(ctx, role) {
  const shared = ctx.message.users_shared;
  const users = shared?.users || [];
  if (!users.length) return;
  let lastId = null;
  let who = '';
  for (const su of users) {
    const name = [su.first_name, su.last_name].filter(Boolean).join(' ') || (su.username ? `@${su.username}` : `id${su.user_id}`);
    lastId = await upsertBotUserByTelegram({
      telegramId: su.user_id,
      role,
      username: su.username,
      displayName: name,
      addedBy: ctx.from.id,
    });
    invalidateRole(su.user_id);
    who = name;
  }
  ctx.session.awaiting = null;
  await afterAdded(ctx, role, lastId, who);
}

// Add via a shared contact card. If the contact is a Telegram user we get user_id → active
// immediately; otherwise we only have a phone → store a pending invite the person claims on /start.
async function addByContact(ctx, role) {
  const c = ctx.message.contact;
  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.phone_number ? `+${c.phone_number}` : 'контакт');
  ctx.session.awaiting = null;
  let memberId;
  if (c.user_id) {
    memberId = await upsertBotUserByTelegram({
      telegramId: c.user_id,
      role,
      phone: c.phone_number,
      displayName: name,
      addedBy: ctx.from.id,
    });
    invalidateRole(c.user_id);
  } else {
    memberId = await addPendingBotUser({ phone: c.phone_number, role, displayName: name, addedBy: ctx.from.id });
    await ctx.reply('ℹ️ Це контакт без Telegram-акаунта в спільних. Додав як запрошення — людина увійде, поділившись своїм номером боту.');
  }
  await afterAdded(ctx, role, memberId, name);
}

// Add by a typed phone number (fallback): always a pending invite, claimed when the person shares
// their contact on /start.
async function addByPhoneText(ctx, role) {
  const phone = ctx.message.text.replace(/\D/g, '');
  if (phone.length < 9) {
    await ctx.reply('Це не схоже на номер телефону. Надішліть номер (напр. 0674738200) або « Скасувати.');
    return;
  }
  ctx.session.awaiting = null;
  const memberId = await addPendingBotUser({ phone, role, addedBy: ctx.from.id });
  await ctx.reply('ℹ️ Додав як запрошення за номером. Людина увійде, коли відкриє бота й поділиться своїм контактом.', {
    reply_markup: { remove_keyboard: true },
  });
  await afterAdded(ctx, role, memberId, `+${phone}`);
}

// --- Registration --------------------------------------------------------------------------

async function openRolesMenu(ctx) {
  ctx.session.awaiting = null;
  const { text, kb } = rolesMenu();
  await showScreen(ctx, text, kb);
}

function registerRoles(bot) {
  bot.callbackQuery('roles', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = rolesMenu();
    await showScreen(ctx, text, kb);
  });

  bot.callbackQuery(/^roles:list:(director|marketer|manager|mechanic)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = await roleListScreen(ctx.match[1]);
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  bot.callbackQuery(/^roles:u:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const screen = await memberScreen(Number(ctx.match[1]));
    if (!screen) {
      await ctx.reply('Запис не знайдено (можливо, вже видалено).');
      return;
    }
    await showScreen(ctx, screen.text, screen.kb, { parseMode: null });
  });

  bot.callbackQuery(/^roles:add:(marketer|manager|mechanic)$/, async (ctx) => {
    const role = ctx.match[1];
    await ctx.answerCallbackQuery();
    ctx.session.awaiting = { type: 'role_add', role };
    await ctx.reply(
      `➕ Додаємо людину на роль «${ROLE_LABELS[role]}».\n\n` +
        '• «Обрати з контактів» — вибрати колегу з ваших Telegram-контактів (найпростіше).\n' +
        '• «Поділитися контактом» — переслати картку контакту.\n' +
        '• Або просто напишіть номер телефону повідомленням.\n\n' +
        'Тег (@username) Telegram не дозволяє знаходити людей ботам — користуйтесь контактом або номером.',
      { reply_markup: addKeyboard() }
    );
  });

  bot.callbackQuery(/^roles:del:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const u = await getBotUserById(Number(ctx.match[1]));
    if (!u) {
      await ctx.reply('Запис не знайдено.');
      return;
    }
    const kb = new InlineKeyboard()
      .text('✅ Так, видалити', `roles:delok:${u.id}`)
      .row()
      .text('« Ні, назад', `roles:u:${u.id}`);
    await showScreen(ctx, `Видалити ${memberLine(u)} з ролі «${ROLE_LABELS[u.role]}»?`, kb, { parseMode: null });
  });

  bot.callbackQuery(/^roles:delok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const u = await getBotUserById(id);
    const removed = await deleteBotUser(id);
    if (removed?.telegramId != null) invalidateRole(removed.telegramId);
    await ctx.answerCallbackQuery({ text: 'Видалено' });
    const role = u?.role || removed?.role;
    if (role) {
      const { text, kb } = await roleListScreen(role);
      await showScreen(ctx, text, kb, { parseMode: null });
    } else {
      const { text, kb } = rolesMenu();
      await showScreen(ctx, text, kb);
    }
  });

  bot.callbackQuery(/^roles:oppick:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const { text, kb } = await operatorPickScreen(Number(ctx.match[1]));
    await showScreen(ctx, text, kb, { parseMode: null });
  });

  bot.callbackQuery(/^roles:setop:(\d+):(.+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const name = ctx.match[2];
    await setBotUserOperator(id, name);
    const u = await getBotUserById(id);
    if (u?.telegramId != null) invalidateRole(u.telegramId);
    await ctx.answerCallbackQuery({ text: 'Прив’язано' });
    const screen = await memberScreen(id);
    if (screen) await showScreen(ctx, screen.text, screen.kb, { parseMode: null });
  });

  // Adding people: request_users picker and shared contacts. Guarded by the awaiting role_add
  // state so a stray shared contact from someone not in the add flow is ignored here.
  bot.on('message:users_shared', async (ctx, next) => {
    const st = ctx.session.awaiting;
    // Not our add flow (e.g. a settings recipient pick) — let later handlers run.
    if (st?.type !== 'role_add') {
      if (next) await next();
      return;
    }
    await addByUsersShared(ctx, st.role);
  });

  bot.on('message:contact', async (ctx, next) => {
    const st = ctx.session.awaiting;
    if (st?.type === 'role_add') {
      await addByContact(ctx, st.role);
      return;
    }
    // Not part of an add flow (e.g. a manager saving their own number) — let other handlers run.
    if (next) await next();
  });
}

export { registerRoles, openRolesMenu, addByPhoneText, MANAGEABLE_ROLES };
