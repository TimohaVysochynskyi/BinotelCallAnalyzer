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
  deleteKbDoc,
} from '../core/store.js';
import { sendLong } from './ui.js';

const EMBED_MODEL = () => process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const CHAT_MODEL = () => process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // Telegram bot getFile limit

// --- Text extraction -----------------------------------------------------------------------

async function extractText(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfExtractText(pdf, { mergePages: true });
    return text;
  }
  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  if (ext === 'txt' || ext === 'text' || ext === 'md') {
    return buffer.toString('utf8');
  }
  throw new Error(`формат .${ext} не підтримується (лише PDF, DOCX, TXT)`);
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

const ANSWER_SYSTEM = `Ти — асистент, що відповідає на запитання працівників компанії ВИКЛЮЧНО на основі наданих фрагментів з внутрішніх посібників.

Правила:
- Використовуй лише інформацію з наведених фрагментів. Нічого не вигадуй.
- Відповідь може бути сформульована як заперечення чи заборона (напр. "ми не надаємо евакуатор", "не працюємо з вантажними авто", "неділя — вихідний") — це ТЕЖ повноцінна відповідь, дай її.
- Пиши "У посібниках немає відповіді на це питання" ЛИШЕ коли у фрагментах справді немає нічого дотичного до запитання.
- Відповідай тією ж мовою, що й запитання, стисло й по суті.
- Якщо доречно — зазнач, з якого файлу взято відповідь.`;

async function answerFromContext(question, hits) {
  const context = hits.map((h, i) => `[${i + 1}] Файл: ${h.filename}\n${h.content}`).join('\n\n---\n\n');
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
        }),
      });
      if (!res.ok) throw new Error(`OpenAI answer failed: ${res.status} ${await res.text()}`);
      const data = await res.json();
      return data.choices[0].message.content;
    },
    { attempts: 3, delayMs: 2000, label: 'OpenAI KB answer' }
  );
}

// question -> answer text (retrieves relevant chunks first).
async function answerQuestion(question) {
  const qEmb = (await embedTexts([question]))[0];
  const hits = await searchKbChunks(qEmb, 6);
  if (!hits.length) return 'База знань порожня — спершу додайте файли посібників.';
  return answerFromContext(question, hits);
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
async function ingestText(filename, text, uploadedBy, fileId, mime) {
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('порожній текст');
  const embeddings = await embedTexts(chunks);
  const docId = await insertKbDoc(filename, uploadedBy, fileId, mime);
  await insertKbChunks(docId, chunks.map((content, ord) => ({ ord, content, embedding: embeddings[ord] })));
  return { docId, chunkCount: chunks.length };
}

async function ingestDocument(ctx) {
  const doc = ctx.message.document;
  if (!doc) return;
  const name = doc.file_name || `file-${doc.file_unique_id}`;

  if (doc.file_size && doc.file_size > MAX_UPLOAD_BYTES) {
    await ctx.reply(`❌ "${name}" завеликий (${Math.round(doc.file_size / 1024 / 1024)} МБ). Ліміт Telegram для ботів — 20 МБ.`);
    return;
  }

  await ctx.reply(`⏳ Обробляю "${name}"…`);
  try {
    const buffer = await downloadTelegramFile(ctx, doc.file_id);
    const text = await extractText(buffer, name);
    if (!text || !text.trim()) {
      await ctx.reply(`⚠️ З "${name}" не вдалося витягти текст. Якщо це сканований PDF/зображення — потрібне розпізнавання (OCR), скажіть.`);
      return;
    }
    const author = ctx.from.username ? `@${ctx.from.username}` : String(ctx.from.id);
    const { chunkCount } = await ingestText(name, text, author, doc.file_id, doc.mime_type);
    await ctx.reply(`✅ Додано «${name}» — ${chunkCount} фрагм. (~${text.length} симв.). Тепер можна ставити питання.`);
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
    ? docs.map((d) => `• «${d.filename}» — ${d.chunkCount} фрагм.`).join('\n')
    : 'поки порожньо.';
  const text = `📚 Файли посібників:\n${list}\n\nОбери файл (відкрити/видалити) або завантаж новий.`;
  return { text, kb };
}

async function fileDetailContent(id) {
  const d = await getKbDoc(id);
  if (!d) return null;
  const kb = new InlineKeyboard()
    .text('📄 Відкрити файл', `kb:open:${id}`)
    .row()
    .text('🗑 Видалити', `kb:del:${id}`)
    .row()
    .text('« Файли', 'kb:menu');
  return { text: `📄 «${d.filename}»\nФрагментів: ${d.chunkCount}`, kb };
}

// Edit the current message to plain-text content; fall back to a fresh message if the edit
// can't be applied (e.g. the message is gone).
async function showPlain(ctx, text, kb) {
  await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
    await ctx.reply(text, { reply_markup: kb }).catch(() => {});
  });
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
  await ctx.reply('❓ Напишіть ваше питання одним повідомленням.');
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
    await ingestDocument(ctx);
  });
}

export { registerKnowledgeBase, answerQuestion, promptQuestion, ingestText, extractText };
