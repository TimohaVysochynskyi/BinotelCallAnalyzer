import { InlineKeyboard } from 'grammy';
import { extractText as pdfExtractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import { withRetry } from '../core/retry.js';
import {
  insertKbDoc,
  insertKbChunks,
  searchKbChunks,
  listKbDocs,
  countKbChunks,
  getKbDoc,
  setKbDocAudience,
  deleteKbDoc,
} from '../core/store.js';
import { ROLES } from './access.js';
import { sendLong, withProgress, showScreen } from './ui.js';

const EMBED_MODEL = () => process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // Telegram bot getFile limit

// KB documents have an audience: which role a manual is FOR. mechanic / manager / both.
const AUDIENCE_LABEL = { mechanic: '🔧 Механікам', manager: '💼 Менеджерам', both: '👥 Обом' };

// Which doc audiences a role may read. Manager/mechanic are restricted to their own manuals (+ the
// "both" ones); director/marketer (admin) get null => no filter, they see everything.
function audiencesForRole(role) {
  if (role === ROLES.MANAGER) return ['manager', 'both'];
  if (role === ROLES.MECHANIC) return ['mechanic', 'both'];
  return null;
}

// --- Text extraction -----------------------------------------------------------------------

// Returns pages: [{ page, text }]. For PDF, page is the 1-based page number (so answers can cite
// exact pages); for DOCX/TXT there is no page concept, so a single { page: null, text } is returned.
async function extractPages(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfExtractText(pdf, { mergePages: false }); // string[] — one per page
    const arr = Array.isArray(text) ? text : [text];
    return arr.map((t, i) => ({ page: i + 1, text: t || '' }));
  }
  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return [{ page: null, text: value }];
  }
  if (ext === 'txt' || ext === 'text' || ext === 'md') {
    return [{ page: null, text: buffer.toString('utf8') }];
  }
  throw new Error(`формат .${ext} не підтримується (лише PDF, DOCX, TXT)`);
}

// Merged plain text (backward-compatible helper, e.g. for the exported API / tests).
async function extractText(buffer, filename) {
  const pages = await extractPages(buffer, filename);
  return pages.map((p) => p.text).join('\n\n');
}

// --- Chunking ------------------------------------------------------------------------------

function chunkText(text, { maxChars = 2400, overlap = 300 } = {}) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paras = clean.split(/\n\n+/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur.length + p.length + 2) > maxChars) {
      chunks.push(cur.trim());
      cur = cur.slice(-overlap) + '\n\n' + p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    while (cur.length > maxChars * 1.5) {
      chunks.push(cur.slice(0, maxChars).trim());
      cur = cur.slice(maxChars - overlap);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

// Page-aware chunking. Input: pages [{ page, text }] from extractPages. Output: chunks
// [{ content, pageStart, pageEnd }]. For non-paged input (a single page:null) it falls back to
// plain chunkText with null page range. For PDFs it accumulates page text up to ~maxChars, tracking
// the page range each chunk spans, and splits a single oversized page while keeping its page number.
function chunkDocument(pages, { maxChars = 2400, overlap = 300 } = {}) {
  if (pages.length === 1 && pages[0].page == null) {
    return chunkText(pages[0].text, { maxChars, overlap }).map((content) => ({ content, pageStart: null, pageEnd: null }));
  }
  const clean = (t) => (t || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = [];
  let cur = '';
  let start = null;
  let end = null;
  const flush = () => {
    const t = cur.trim();
    if (t) chunks.push({ content: t, pageStart: start, pageEnd: end });
    cur = '';
    start = null;
    end = null;
  };
  for (const { page, text } of pages) {
    const p = clean(text);
    if (!p) continue;
    if (cur && cur.length + p.length + 2 > maxChars) flush();
    if (start == null) start = page;
    end = page;
    cur = cur ? `${cur}\n\n${p}` : p;
    // A single page bigger than the budget: emit slices, all tagged with this page.
    while (cur.length > maxChars * 1.5) {
      chunks.push({ content: cur.slice(0, maxChars).trim(), pageStart: start, pageEnd: page });
      cur = cur.slice(maxChars - overlap);
      start = page;
      end = page;
    }
  }
  flush();
  return chunks;
}

// --- OpenAI embeddings + chat --------------------------------------------------------------

async function embedTexts(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96);
    const embeddings = await withRetry(
      async () => {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBED_MODEL(), input: batch }),
        });
        if (!res.ok) throw new Error(`OpenAI embeddings failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      },
      { attempts: 3, delayMs: 1500, label: 'OpenAI embeddings' }
    );
    out.push(...embeddings);
  }
  return out;
}

const ANSWER_SYSTEM = `Ти — асистент, що відповідає на запитання працівників автосервісу.

Джерело правди — наведені фрагменти з внутрішніх посібників компанії. Правила:
- Відповідай ПЕРЕДУСІМ на основі наведених фрагментів.
- Якщо фрагменти покривають питання лише частково (або питання загальне, напр. будова/принцип роботи), можеш ДОПОВНИТИ відповідь достовірними загальновідомими знаннями — без вигадок і не суперечачи посібникам. У такому разі постав usedGeneralKnowledge=true.
- Відповідь-заперечення чи заборона (напр. "ми не працюємо з вантажними авто", "неділя — вихідний") — це ТЕЖ повноцінна відповідь, дай її.
- Якщо у фрагментах немає нічого дотичного І ти не можеш дати достовірну загальну відповідь — постав answer="У посібниках немає відповіді на це питання", usedSources=[], usedGeneralKnowledge=false.
- usedSources: номери [N] фрагментів, які РЕАЛЬНО використані у відповіді (лише справді потрібні; не перелічуй усі підряд).
- Пиши ПРОСТИМ текстом (без markdown, без зірочок і решіток), тією ж мовою, що й запитання, стисло й по суті. НЕ додавай список джерел самостійно — його додасть система.`;

const ANSWER_SCHEMA = {
  name: 'kb_answer',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      usedSources: { type: 'array', items: { type: 'integer' } },
      usedGeneralKnowledge: { type: 'boolean' },
    },
    required: ['answer', 'usedSources', 'usedGeneralKnowledge'],
    additionalProperties: false,
  },
};

const QUERIES_SCHEMA = {
  name: 'kb_queries',
  strict: true,
  schema: {
    type: 'object',
    properties: { queries: { type: 'array', items: { type: 'string' } } },
    required: ['queries'],
    additionalProperties: false,
  },
};

const htmlEscape = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- Retrieval: multi-query for recall ------------------------------------------------------
// The same question phrased differently used to miss ("З чого складається двигун" vs "Як працює
// двигун"). We ask the model for a few rephrasings, embed each + the original, search them all and
// merge by chunk id (keeping the best distance). Best-effort: expansion failure falls back to the
// raw question only.
async function expandQueries(question) {
  try {
    const queries = await withRetry(
      async () => {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: CHAT_MODEL(),
            messages: [
              {
                role: 'system',
                content:
                  'Переформулюй запит для пошуку у базі знань 3 різними способами (синоніми, ключові терміни, ширше і вужче формулювання). Тією ж мовою. Поверни JSON {"queries":[...]} лише з переформулюваннями (без пояснень).',
              },
              { role: 'user', content: question },
            ],
            response_format: { type: 'json_schema', json_schema: QUERIES_SCHEMA },
          }),
        });
        if (!res.ok) throw new Error(`OpenAI query expansion failed: ${res.status} ${await res.text()}`);
        const data = await res.json();
        return JSON.parse(data.choices[0].message.content).queries || [];
      },
      { attempts: 2, delayMs: 1000, label: 'OpenAI KB query expansion' }
    );
    return [question, ...queries].map((q) => (q || '').trim()).filter(Boolean);
  } catch (err) {
    console.error(`[kb] query expansion failed, using raw question: ${err.message}`);
    return [question];
  }
}

const RETRIEVE_PER_QUERY = 8;
const RETRIEVE_FINAL = 8;

async function retrieve(question, audiences) {
  const queries = await expandQueries(question);
  const embeddings = await embedTexts(queries);
  const seen = new Map(); // chunkId -> best hit
  for (const emb of embeddings) {
    const hits = await searchKbChunks(emb, RETRIEVE_PER_QUERY, audiences);
    for (const h of hits) {
      const prev = seen.get(h.chunkId);
      if (!prev || h.dist < prev.dist) seen.set(h.chunkId, h);
    }
  }
  return [...seen.values()].sort((a, b) => a.dist - b.dist).slice(0, RETRIEVE_FINAL);
}

// --- Sources footer (deterministic, built from the fragments the model actually used) -------
function pagesLabel(ranges) {
  if (!ranges.length) return '';
  const sorted = ranges.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0]);
  const merged = [sorted[0].slice()];
  for (const [a, b] of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const parts = merged.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  return `стор. ${parts.join(', ')}`;
}

// Deep-link on the filename: tapping it opens the bot with /start kbdoc_<id>, which resends the
// original file (see index.js). Keeps everything in our DB — no external file hosting.
function docDeepLink(botUsername, docId) {
  return botUsername ? `https://t.me/${botUsername}?start=kbdoc_${docId}` : null;
}

function buildSourcesFooter(usedHits, botUsername) {
  const byDoc = new Map();
  for (const h of usedHits) {
    if (!byDoc.has(h.docId)) byDoc.set(h.docId, { docId: h.docId, filename: h.filename, pages: [] });
    if (h.pageStart != null) byDoc.get(h.docId).pages.push([h.pageStart, h.pageEnd ?? h.pageStart]);
  }
  const lines = [];
  for (const d of byDoc.values()) {
    const url = docDeepLink(botUsername, d.docId);
    const name = htmlEscape(d.filename);
    const linked = url ? `<a href="${url}">${name}</a>` : name;
    const pg = pagesLabel(d.pages);
    lines.push(`• ${linked}${pg ? ` — ${pg}` : ''}`);
  }
  const head = lines.length > 1 ? '📎 Джерела:' : '📎 Джерело:';
  return `${head}\n${lines.join('\n')}`;
}

async function answerStructured(question, hits) {
  const context = hits.length
    ? hits
        .map((h, i) => {
          const pg = h.pageStart != null ? ` (стор. ${h.pageStart}${h.pageEnd && h.pageEnd !== h.pageStart ? `–${h.pageEnd}` : ''})` : '';
          return `[${i + 1}] Файл: ${h.filename}${pg}\n${h.content}`;
        })
        .join('\n\n---\n\n')
    : '(релевантних фрагментів не знайдено)';
  return withRetry(
    async () => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CHAT_MODEL(),
          messages: [
            { role: 'system', content: ANSWER_SYSTEM },
            { role: 'user', content: `Питання: ${question}\n\nФрагменти посібників:\n\n${context}` },
          ],
          response_format: { type: 'json_schema', json_schema: ANSWER_SCHEMA },
        }),
      });
      if (!res.ok) throw new Error(`OpenAI answer failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    },
    { attempts: 3, delayMs: 2000, label: 'OpenAI KB answer' }
  );
}

// question -> ready-to-send HTML answer with a mandatory sources block. role limits which docs are
// searched (a mechanic never gets a manager's manual and vice versa; admins search everything).
// botUsername is used to build the deep-link on each source filename.
async function answerQuestion(question, role, botUsername) {
  const hits = await retrieve(question, audiencesForRole(role));
  const { answer, usedSources, usedGeneralKnowledge } = await answerStructured(question, hits);

  const used = (usedSources || []).map((i) => hits[i - 1]).filter(Boolean);
  let footer = '';
  if (used.length) footer = `\n\n${buildSourcesFooter(used, botUsername)}`;
  if (usedGeneralKnowledge) {
    footer +=
      (footer ? '\n\n' : '\n\n') +
      (used.length
        ? 'ℹ️ Частину відповіді доповнено із загальних знань (не з посібників).'
        : 'ℹ️ Відповідь ґрунтується на загальних знаннях — прямої відповіді в посібниках не знайдено.');
  }
  return `${htmlEscape(answer)}${footer}`;
}

// --- Upload ingestion ----------------------------------------------------------------------

async function downloadTelegramFile(ctx, fileId) {
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`не вдалося завантажити файл: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Core ingestion: chunk -> embed -> store. Returns { docId, chunkCount }. Reusable outside the
// Telegram flow (tests, a future folder-import script). fileId/mime let us later resend the
// original document ("open file").
// Core ingestion from page-structured text: chunk (with page ranges) -> embed -> store.
async function ingestPages(filename, pages, uploadedBy, fileId, mime, audience = 'mechanic') {
  const chunks = chunkDocument(pages);
  if (chunks.length === 0) throw new Error('порожній текст');
  const embeddings = await embedTexts(chunks.map((c) => c.content));
  const docId = await insertKbDoc(filename, uploadedBy, fileId, mime, audience);
  await insertKbChunks(
    docId,
    chunks.map((c, ord) => ({ ord, content: c.content, embedding: embeddings[ord], pageStart: c.pageStart, pageEnd: c.pageEnd }))
  );
  return { docId, chunkCount: chunks.length };
}

// Backward-compatible plain-text entry point (no page info — e.g. tests / a future importer).
async function ingestText(filename, text, uploadedBy, fileId, mime, audience = 'mechanic') {
  return ingestPages(filename, [{ page: null, text }], uploadedBy, fileId, mime, audience);
}

// Step 1 of upload: capture the document and ask WHO it's for. The actual ingestion is deferred
// until the audience is chosen (kb:aud:*), so we stash the file reference in the session.
async function askAudienceForUpload(ctx) {
  const doc = ctx.message.document;
  if (!doc) return;
  const name = doc.file_name || `file-${doc.file_unique_id}`;

  if (doc.file_size && doc.file_size > MAX_UPLOAD_BYTES) {
    await ctx.reply(`❌ "${name}" завеликий (${Math.round(doc.file_size / 1024 / 1024)} МБ). Ліміт Telegram для ботів — 20 МБ.`);
    return;
  }

  ctx.session.pendingKbDoc = { fileId: doc.file_id, name, mime: doc.mime_type };
  await ctx.reply(`📎 «${name}» — для кого цей файл у базі знань?`, { reply_markup: audienceKeyboard('kb:aud:') });
}

// Step 2 of upload: run the ingestion for the stashed document with the chosen audience.
async function ingestPendingDoc(ctx, pending, audience) {
  const { fileId, name, mime } = pending;
  await ctx.reply(`⏳ Обробляю «${name}» (${AUDIENCE_LABEL[audience]})… Для великих файлів це може зайняти до хвилини.`);
  try {
    // Download + text extraction + chunking + embeddings can take ~30s; keep a "typing"
    // indicator alive for the whole time so the chat doesn't look frozen.
    const result = await withProgress(ctx.api, ctx.chat.id, 'typing', async () => {
      const buffer = await downloadTelegramFile(ctx, fileId);
      const pages = await extractPages(buffer, name);
      const textLength = pages.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
      if (!textLength || !pages.some((p) => p.text && p.text.trim())) return null;
      const author = ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id);
      const { chunkCount } = await ingestPages(name, pages, author, fileId, mime, audience);
      return { chunkCount, textLength };
    });
    if (!result) {
      await ctx.reply(`⚠️ З "${name}" не вдалося витягти текст. Якщо це сканований PDF/зображення — потрібне розпізнавання (OCR), скажіть.`);
      return;
    }
    await ctx.reply(`✅ Додано «${name}» для ${AUDIENCE_LABEL[audience]} — ${result.chunkCount} фрагм. (~${result.textLength} симв.). Тепер можна ставити питання.`);
  } catch (err) {
    console.error(`[kb] ingest "${name}" failed: ${err.message}`);
    await ctx.reply(`❌ Не вдалося обробити "${name}": ${err.message}`);
  }
}

// --- Menus / handlers ----------------------------------------------------------------------

// All KB screens render as PLAIN text (no parse_mode): filenames routinely contain characters
// that break Telegram Markdown (e.g. "_"), which previously made the "Files" screen silently
// fail to render. Filenames are shown in «guillemets» instead of markdown.

async function filesListContent() {
  const docs = await listKbDocs();
  const kb = new InlineKeyboard();
  for (const d of docs) kb.text(`📄 ${d.filename.slice(0, 40)}`, `kb:doc:${d.id}`).row();
  kb.text('➕ Завантажити новий', 'kb:add').row();
  kb.text('« Меню', 'menu');
  const list = docs.length
    ? docs.map((d) => `• «${d.filename}» — ${d.chunkCount} фрагм. · ${AUDIENCE_LABEL[d.audience] || d.audience}`).join('\n')
    : 'поки порожньо.';
  const text = `📚 Файли посібників:\n${list}\n\nОбери файл (відкрити/змінити для кого/видалити) або завантаж новий.`;
  return { text, kb };
}

async function fileDetailContent(id) {
  const d = await getKbDoc(id);
  if (!d) return null;
  const kb = new InlineKeyboard()
    .text('📄 Відкрити файл', `kb:open:${id}`)
    .row()
    .text('🔁 Змінити для кого', `kb:audset:${id}`)
    .row()
    .text('🗑 Видалити', `kb:del:${id}`)
    .row()
    .text('« Файли', 'kb:menu');
  return { text: `📄 «${d.filename}»\nФрагментів: ${d.chunkCount}\nДля кого: ${AUDIENCE_LABEL[d.audience] || d.audience}`, kb };
}

// Inline keyboard for choosing/changing a doc's audience. cbPrefix builds the callback per option.
function audienceKeyboard(cbPrefix, back) {
  const kb = new InlineKeyboard()
    .text(AUDIENCE_LABEL.mechanic, `${cbPrefix}mechanic`)
    .text(AUDIENCE_LABEL.manager, `${cbPrefix}manager`)
    .row()
    .text(AUDIENCE_LABEL.both, `${cbPrefix}both`);
  if (back) kb.row().text('« Назад', back);
  return kb;
}

// KB screens render as plain text (filenames contain _ etc. that break Markdown). showScreen
// keeps the active screen at the bottom / in focus (edit-in-place when newest, else resend).
async function showPlain(ctx, text, kb) {
  await showScreen(ctx, text, kb, { parseMode: null });
}

// Prompt the user to type a question (shared by the button, command and quick keyboard).
async function promptQuestion(ctx, kbState) {
  if (!kbState.ready) {
    await ctx.reply('База знань тимчасово недоступна.');
    return;
  }
  if ((await countKbChunks()) === 0) {
    await ctx.reply('База знань порожня. Надішліть файл(и) посібника боту (PDF/DOCX/TXT), і я їх проіндексую.');
    return;
  }
  ctx.session.awaiting = { type: 'kb_question' };
  await ctx.reply('📚 База знань. Напишіть ваше питання одним повідомленням.');
}

// Open the files list as a NEW message (used by the /files command so the native Menu button
// matches the inline menu; the kb:menu callback edits the current message instead).
async function openFiles(ctx, kbState) {
  if (!kbState.ready) {
    await ctx.reply('База знань тимчасово недоступна (немає pgvector).');
    return;
  }
  const { text, kb } = await filesListContent();
  await showPlain(ctx, text, kb);
}

// Resend the original file for a deep-link (t.me/bot?start=kbdoc_<id>, from a source citation).
// Enforces the audience: a manager/mechanic can only open docs of their own (or "both") audience,
// even if they somehow got a link to another one; admins can open anything.
async function openKbDocById(ctx, id, role) {
  const d = await getKbDoc(id);
  if (!d) {
    await ctx.reply('Файл не знайдено (можливо, вже видалений).');
    return;
  }
  const allowed = audiencesForRole(role);
  if (allowed && !allowed.includes(d.audience)) {
    await ctx.reply('⛔ Цей файл недоступний для вашої ролі.');
    return;
  }
  if (!d.fileId) {
    await ctx.reply('Оригінал недоступний (файл додано до оновлення). Перезавантажте його, щоб можна було відкривати.');
    return;
  }
  try {
    await ctx.replyWithDocument(d.fileId, { caption: d.filename });
  } catch (err) {
    console.error(`[kb] open ${d.id} via deep-link failed: ${err.message}`);
    await ctx.reply(`Не вдалося надіслати файл: ${err.message}`);
  }
}

function registerKnowledgeBase(bot, kbState) {
  const guard = async (ctx) => {
    if (kbState.ready) return true;
    await ctx.reply('База знань тимчасово недоступна (немає pgvector).');
    return false;
  };

  bot.callbackQuery('kb:ask', async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptQuestion(ctx, kbState);
  });

  bot.callbackQuery('kb:menu', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await guard(ctx))) return;
    const { text, kb } = await filesListContent();
    await showPlain(ctx, text, kb);
  });

  bot.callbackQuery('kb:add', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('📎 Надішліть документ (PDF, DOCX або TXT) — я витягну текст і додам у базу знань. Можна кілька файлів поспіль.');
  });

  bot.callbackQuery(/^kb:doc:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const content = await fileDetailContent(Number(ctx.match[1]));
    if (!content) {
      await ctx.reply('Файл не знайдено (можливо, вже видалений).');
      return;
    }
    await showPlain(ctx, content.text, content.kb);
  });

  bot.callbackQuery(/^kb:open:(\d+)$/, async (ctx) => {
    const d = await getKbDoc(Number(ctx.match[1]));
    await ctx.answerCallbackQuery();
    if (!d) {
      await ctx.reply('Файл не знайдено.');
      return;
    }
    if (!d.fileId) {
      await ctx.reply('Оригінал недоступний (файл додано до оновлення). Перезавантажте його, щоб можна було відкривати.');
      return;
    }
    try {
      await ctx.replyWithDocument(d.fileId, { caption: d.filename });
    } catch (err) {
      console.error(`[kb] open ${d.id} failed: ${err.message}`);
      await ctx.reply(`Не вдалося надіслати файл: ${err.message}`);
    }
  });

  bot.callbackQuery(/^kb:del:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const d = await getKbDoc(id);
    await ctx.answerCallbackQuery();
    if (!d) {
      await ctx.reply('Файл не знайдено.');
      return;
    }
    const kb = new InlineKeyboard()
      .text('✅ Так, видалити', `kb:delok:${id}`)
      .row()
      .text('« Ні, назад', `kb:doc:${id}`);
    await showPlain(ctx, `Видалити «${d.filename}» з бази знань? Це прибере всі його фрагменти.`, kb);
  });

  bot.callbackQuery(/^kb:delok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const d = await getKbDoc(id);
    await deleteKbDoc(id);
    await ctx.answerCallbackQuery({ text: 'Видалено' });
    const { text, kb } = await filesListContent();
    await showPlain(ctx, `🗑 Видалено «${d ? d.filename : id}».\n\n${text}`, kb);
  });

  bot.on('message:document', async (ctx) => {
    if (!(await guard(ctx))) return;
    await askAudienceForUpload(ctx);
  });

  // Audience chosen for a just-uploaded file → run the deferred ingestion.
  bot.callbackQuery(/^kb:aud:(mechanic|manager|both)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const pending = ctx.session.pendingKbDoc;
    if (!pending) {
      await ctx.reply('Немає файлу для додавання — надішліть документ ще раз.');
      return;
    }
    ctx.session.pendingKbDoc = null;
    await ingestPendingDoc(ctx, pending, ctx.match[1]);
  });

  // Change an existing file's audience: show the picker, then apply and return to the file detail.
  bot.callbackQuery(/^kb:audset:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]);
    const d = await getKbDoc(id);
    if (!d) {
      await ctx.reply('Файл не знайдено.');
      return;
    }
    await showPlain(ctx, `«${d.filename}» — для кого цей файл?`, audienceKeyboard(`kb:audput:${id}:`, `kb:doc:${id}`));
  });

  bot.callbackQuery(/^kb:audput:(\d+):(mechanic|manager|both)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await setKbDocAudience(id, ctx.match[2]);
    await ctx.answerCallbackQuery({ text: 'Змінено' });
    const content = await fileDetailContent(id);
    if (content) await showPlain(ctx, content.text, content.kb);
  });
}

export { registerKnowledgeBase, answerQuestion, promptQuestion, openFiles, openKbDocById, ingestText, extractText };
