const MAX = 4096;
const TARGET = 3800;

// Split on paragraph/line breaks so we don't cut a sentence (or a markdown entity) in half.
function splitMessage(text) {
  if (text.length <= MAX) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let at = remaining.lastIndexOf('\n\n', TARGET);
    if (at <= 0) at = remaining.lastIndexOf('\n', TARGET);
    if (at <= 0) at = TARGET;
    chunks.push(remaining.slice(0, at));
    remaining = remaining.slice(at).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Send arbitrarily long text, splitting into <=4096-char messages. When parseMode is set and
// Telegram rejects the entity markup, resend that chunk as plain text so nothing is lost.
async function sendLong(api, chatId, text, { parseMode } = {}) {
  const chunks = splitMessage(text);
  for (const [i, chunk] of chunks.entries()) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : '';
    const body = prefix + chunk;
    try {
      await api.sendMessage(chatId, body, parseMode ? { parse_mode: parseMode } : {});
    } catch (err) {
      if (parseMode) {
        await api.sendMessage(chatId, body);
      } else {
        throw err;
      }
    }
  }
}

export { splitMessage, sendLong };
