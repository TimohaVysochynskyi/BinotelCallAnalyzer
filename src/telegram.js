const { withRetry } = require('./retry');

async function rawSend(token, chatId, text, parseMode) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
  });
  if (!res.ok) {
    throw new Error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
}

async function sendMessage(text, { chatId } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const targetChatId = chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !targetChatId) {
    console.log('[telegram] DRY RUN (no TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID set) - would send:\n');
    console.log(text);
    console.log('\n[telegram] --- end of message ---');
    return;
  }

  try {
    await withRetry(() => rawSend(token, targetChatId, text, 'Markdown'), {
      attempts: 2,
      delayMs: 1000,
      label: 'telegram send (markdown)',
    });
    console.log('[telegram] sent (markdown)');
  } catch (err) {
    console.error(`[telegram] markdown send failed, falling back to plain text: ${err.message}`);
    await withRetry(() => rawSend(token, targetChatId, text, undefined), {
      attempts: 2,
      delayMs: 1000,
      label: 'telegram send (plain)',
    });
    console.log('[telegram] sent (plain text fallback)');
  }
}

async function sendAlert(text) {
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  await sendMessage(`⚠️ ${text}`, { chatId: adminChatId });
}

module.exports = { sendMessage, sendAlert };
