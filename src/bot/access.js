import { getBotUser, seedDirector } from '../core/store.js';

// Roles are a fixed ENUM (no "add role" feature). Director and marketer share the SAME full
// access (the "admin" tier); manager and mechanic are limited.
const ROLES = {
  DIRECTOR: 'director',
  MARKETER: 'marketer',
  MANAGER: 'manager',
  MECHANIC: 'mechanic',
};

const ROLE_LABELS = {
  director: 'Директор',
  marketer: 'Маркетолог',
  manager: 'Менеджер',
  mechanic: 'Механік',
};

const ADMIN_ROLES = new Set([ROLES.DIRECTOR, ROLES.MARKETER]);

function isAdmin(role) {
  return ADMIN_ROLES.has(role);
}

// Feature -> which roles may use it. Admin (director/marketer) may use everything; that's handled
// in canAccess, so this map only needs the non-admin grants.
function canAccess(role, feature) {
  if (!role) return false;
  if (isAdmin(role)) return true;
  if (role === ROLES.MANAGER) return ['menu', 'kb_ask', 'stats_self'].includes(feature);
  if (role === ROLES.MECHANIC) return ['menu', 'kb_ask'].includes(feature);
  return false;
}

// Classify an incoming update into a coarse feature key so the auth middleware can allow/deny it
// centrally. Returns null for updates that are routed by session state (free text, shared
// contacts, users_shared) — those are gated by the flow that set ctx.session.awaiting.
function featureOf(ctx) {
  const cq = ctx.callbackQuery?.data;
  if (cq) {
    if (cq === 'menu' || cq === 'noop') return 'menu';
    if (cq === 'kb:ask') return 'kb_ask';
    if (cq.startsWith('kb:')) return 'kb_edit'; // menu/add/doc/open/del/delok/aud/audset/audput = file mgmt
    if (cq.startsWith('stat:') || cq.startsWith('note:')) return 'stats_all';
    if (cq.startsWith('arch:')) return 'archive';
    if (cq.startsWith('report')) return 'report';
    if (cq.startsWith('prompt')) return 'prompt';
    if (cq.startsWith('roles')) return 'roles';
    if (cq === 'set' || cq.startsWith('set:')) return 'settings';
    if (cq.startsWith('me:')) return 'stats_self';
    return 'menu';
  }
  const text = ctx.message?.text;
  if (text && text.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]/)[0];
    const map = {
      start: 'menu',
      menu: 'menu',
      stats: 'stats_all',
      archive: 'archive',
      ask: 'kb_ask',
      files: 'kb_edit',
      report: 'report',
      prompt: 'prompt',
      roles: 'roles',
      settings: 'settings',
      myreport: 'stats_self',
    };
    return map[cmd] ?? 'menu';
  }
  if (ctx.message?.document) return 'kb_edit'; // uploading a KB file is admin-only
  return null;
}

// --- Role lookup with a small in-memory cache ----------------------------------------------
// Low traffic, but the role is read on every update; cache by telegram id and invalidate on any
// role mutation (invalidateRole) so edits take effect immediately.
const roleCache = new Map(); // telegramId -> bot_user row (or null)

async function getUser(telegramId) {
  if (telegramId == null) return null;
  const key = String(telegramId);
  if (roleCache.has(key)) return roleCache.get(key);
  const user = await getBotUser(telegramId);
  roleCache.set(key, user);
  return user;
}

function invalidateRole(telegramId) {
  if (telegramId == null) roleCache.clear();
  else roleCache.delete(String(telegramId));
}

// Seed the owner user ids (TELEGRAM_BOOTSTRAP_CHAT_IDS) as directors at startup so nobody is
// locked out on a fresh DB; after that, access is managed in-bot via the "Ролі" block. Roles are
// keyed by the USER id (ctx.from.id, always positive), so we skip non-positive (group) ids.
async function seedDirectors() {
  const ids = new Set(
    (process.env.TELEGRAM_BOOTSTRAP_CHAT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s) && Number(s) > 0)
  );
  for (const id of ids) {
    await seedDirector(id);
    invalidateRole(id);
  }
  return ids.size;
}

export {
  ROLES,
  ROLE_LABELS,
  ADMIN_ROLES,
  isAdmin,
  canAccess,
  featureOf,
  getUser,
  invalidateRole,
  seedDirectors,
};
