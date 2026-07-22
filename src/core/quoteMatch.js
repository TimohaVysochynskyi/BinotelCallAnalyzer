// Deterministic quote → timecode locator (no LLM). Given a verbatim quote the model extracted and
// the call's timecoded `segments` ([{role,text,start,end}]), find WHICH segment the quote came from
// and return its timecode, so we can (a) verify the quote is real (not fabricated/paraphrased) and
// (b) cut an audio clip around it. Two-stage match: normalized substring first (exact), then token
// coverage (fuzzy — tolerates ASR/surzhyk drift and light model normalization). Returns
// { segIndex, start, end, score } or null when nothing matches well enough.

const COVERAGE_THRESHOLD = 0.7; // fraction of the quote's tokens that must appear in a segment

// Lowercase, keep only Unicode letters/digits (drops punctuation, "ё"→ kept as letter), collapse
// whitespace. Keeps Cyrillic and Latin alike.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// The model sometimes prefixes a quote with the speaker label ("Менеджер: ..."); strip it so it
// doesn't spoil the match against segment text (which has no label).
function stripRoleLabel(s) {
  return String(s || '').replace(/^\s*(менеджер|клієнт|клиент|оператор|manager|client)\s*[:\-–—]\s*/i, '');
}

function tokens(norm) {
  return norm ? norm.split(' ').filter(Boolean) : [];
}

// coverage = |quoteTokens ∩ segTokens| / |quoteTokens| — how much of the quote is present in the
// segment. Better than Jaccard for a short quote inside a longer turn (union would dominate).
function coverage(quoteTokens, segTokenSet) {
  if (quoteTokens.length === 0) return 0;
  let hit = 0;
  for (const t of new Set(quoteTokens)) if (segTokenSet.has(t)) hit += 1;
  return hit / new Set(quoteTokens).size;
}

// segments: [{role, text, start, end}].
//   requireRole: consider ONLY segments of this role — a quote not found in a manager turn is
//     rejected (null). Used for manager-behaviour evidence so a client's line can't be mislabelled
//     as the manager's. Takes precedence over preferRole.
//   preferRole: (legacy) try this role's segments first, then the rest.
// Returns the best match or null.
function findQuote(segments, quote, { preferRole = 'manager', requireRole = null } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const q = normalize(stripRoleLabel(quote));
  if (q.length < 3) return null;
  const qTokens = tokens(q);

  const order = [];
  if (requireRole) {
    segments.forEach((s, i) => s.role === requireRole && order.push(i));
    if (order.length === 0) return null; // no manager turns → cannot attribute to the manager
  } else if (preferRole) {
    segments.forEach((s, i) => s.role === preferRole && order.push(i));
    segments.forEach((s, i) => s.role !== preferRole && order.push(i));
  } else {
    segments.forEach((_, i) => order.push(i));
  }

  // Stage 1: normalized substring (exact-ish).
  for (const i of order) {
    const s = normalize(segments[i].text);
    if (s && s.includes(q)) {
      return { segIndex: i, start: segments[i].start ?? null, end: segments[i].end ?? null, score: 1 };
    }
  }

  // Stage 2: token coverage.
  let best = null;
  for (const i of order) {
    const segTokenSet = new Set(tokens(normalize(segments[i].text)));
    const score = coverage(qTokens, segTokenSet);
    if (!best || score > best.score) best = { segIndex: i, score };
  }
  if (best && best.score >= COVERAGE_THRESHOLD) {
    const seg = segments[best.segIndex];
    return { segIndex: best.segIndex, start: seg.start ?? null, end: seg.end ?? null, score: best.score };
  }
  return null;
}

export { findQuote, normalize };
