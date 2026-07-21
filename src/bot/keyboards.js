import { InlineKeyboard } from "grammy";
import { shortDate } from "./time.js";
import { displayName, hasAlias } from "./operators.js";
import { isAdmin, ROLES } from "./access.js";

const PERIODS = [
  ["day", "День"],
  ["week", "Тиждень"],
  ["month", "Місяць"],
  ["quarter", "Квартал"],
];

// The main menu is role-aware: admins (director/marketer) see everything, a manager sees their
// own report + the knowledge base, a mechanic sees only the knowledge base.
function mainMenu(role) {
  const kb = new InlineKeyboard();
  if (isAdmin(role)) {
    // "Файли" is intentionally NOT here — it lives only in the native "Menu" command list (/files).
    kb.text("📊 Статистика менеджера", "stat:pick")
      .row()
      .text("🗂 Архів розмов", "arch:pick")
      .row()
      .text("📚 База знань", "kb:ask")
      .row()
      .text("🔄 Звіт зараз", "report:now")
      .row()
      .text("👥 Ролі", "roles");
    return kb;
  }
  if (role === ROLES.MANAGER) {
    kb.text("📊 Мій звіт", "me:pick").row().text("📚 База знань", "kb:ask");
    return kb;
  }
  // mechanic (and any other limited role)
  kb.text("📚 База знань", "kb:ask");
  return kb;
}

function operatorLabel(name) {
  // Operators in the picker are personal numbers assigned to managers, so a named/aliased operator
  // gets the 📱 (mobile) label (client's request — visually "a personal number"). Only a still
  // unattributed shared handset keeps the ☎️ "Спільний" label.
  if (hasAlias(name)) return `📱 ${displayName(name)}`;
  return /^[0-9]+$/.test(name) ? `☎️ Спільний ${name}` : `📱 ${name}`;
}

// operators: [{ name, n, firstCall? }]. prefix is 'stat' or 'arch'; the operator name is the
// trailing segment of the callback data so it can contain anything except a colon (first names
// don't). With { showDates: true } (Archive) each label gains the operator's active period —
// from their first processed call (proxy for when Binotel first saw the name) to today, e.g.
// "📱 Роман (175) — 01.02.25-01.02.26".
function operatorListKeyboard(operators, prefix, { showDates = false } = {}) {
  const kb = new InlineKeyboard();
  const today = new Date();
  for (const o of operators) {
    let label = `${operatorLabel(o.name)} (${o.n})`;
    if (showDates && o.firstCall) label += ` — ${shortDate(o.firstCall)}-${shortDate(today)}`;
    kb.text(label, `${prefix}:op:${o.name}`).row();
  }
  kb.text("« Меню", "menu");
  return kb;
}

// makeData(period) -> callback_data; backData -> the "back" button callback.
function periodKeyboard(makeData, backData) {
  const kb = new InlineKeyboard();
  for (const [p, label] of PERIODS) kb.text(label, makeData(p));
  kb.row().text("« Назад", backData);
  return kb;
}

export { mainMenu, operatorListKeyboard, periodKeyboard, operatorLabel, PERIODS };
