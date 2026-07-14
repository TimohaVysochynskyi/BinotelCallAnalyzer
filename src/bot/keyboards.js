import { InlineKeyboard, Keyboard } from 'grammy';

// Persistent reply keyboard shown above the input at all times, so the menu never gets "lost"
// while navigating deep into the archive/audio. Buttons send their label as a text message,
// which the bot routes (see index.js message:text handler). Labels are also the nav keys.
const QUICK = {
  stats: '📊 Статистика',
  archive: '🗂 Архів',
  ask: '❓ Питання',
  report: '🔄 Звіт зараз',
  menu: '☰ Меню',
};

function quickKeyboard() {
  return new Keyboard()
    .text(QUICK.stats)
    .text(QUICK.archive)
    .row()
    .text(QUICK.ask)
    .text(QUICK.report)
    .row()
    .text(QUICK.menu)
    .resized()
    .persistent();
}

const PERIODS = [
  ['day', 'День'],
  ['week', 'Тиждень'],
  ['month', 'Місяць'],
  ['quarter', 'Квартал'],
];

function mainMenu() {
  return new InlineKeyboard()
    .text('📊 Статистика менеджера', 'stat:pick')
    .row()
    .text('🗂 Архів розмов', 'arch:pick')
    .row()
    .text('❓ Поставити питання', 'kb:ask')
    .text('📚 Файли', 'kb:menu')
    .row()
    .text('🔄 Звіт зараз', 'report:now');
}

function operatorLabel(name) {
  return /^[0-9]+$/.test(name) ? `☎️ Спільний ${name}` : `👤 ${name}`;
}

// operators: [{ name, n }]. prefix is 'stat' or 'arch'; the operator name is the trailing
// segment of the callback data so it can contain anything except a colon (first names don't).
function operatorListKeyboard(operators, prefix) {
  const kb = new InlineKeyboard();
  for (const o of operators) kb.text(`${operatorLabel(o.name)} (${o.n})`, `${prefix}:op:${o.name}`).row();
  kb.text('« Меню', 'menu');
  return kb;
}

// makeData(period) -> callback_data; backData -> the "back" button callback.
function periodKeyboard(makeData, backData) {
  const kb = new InlineKeyboard();
  for (const [p, label] of PERIODS) kb.text(label, makeData(p));
  kb.row().text('« Назад', backData);
  return kb;
}

export { mainMenu, operatorListKeyboard, periodKeyboard, operatorLabel, quickKeyboard, QUICK, PERIODS };
