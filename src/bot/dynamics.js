import { displayName } from "./operators.js";

// Growth dashboard for a manager — the primary screen of "Статистика менеджера". Renders a numeric
// TRAJECTORY across buckets (Kyiv weeks or months) + how the weakest sales stage evolved + a growth
// verdict (first→last deltas). Pure text builder (no DB/LLM) → easy to unit-test; the caller feeds
// buckets from store.getBucketedTrend (chronological, oldest→newest).

const MONTHS_UK = [
  "січ",
  "лют",
  "бер",
  "кві",
  "тра",
  "чер",
  "лип",
  "сер",
  "вер",
  "жов",
  "лис",
  "гру",
];

const pad2 = (n) => String(n).padStart(2, "0");
const partsOf = (ymd) => ymd.split("-").map(Number); // [y, m, d]

// Ukrainian plural agreement (1 / 2-4 / 5+, with the 11-14 exception) - e.g. pluralize(4, 'тиждень',
// 'тижні', 'тижнів') === 'тижні', pluralize(5, ...) === 'тижнів'.
function pluralize(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
const bucketWord = (n, bucket) =>
  bucket === "month"
    ? pluralize(n, "місяць", "місяці", "місяців")
    : pluralize(n, "тиждень", "тижні", "тижнів");

// "dd.mm–dd" for a week starting at ymd (Monday, end day only - no year/month repeated, saves
// space), or "лип'26" for a month.
function bucketLabel(ymd, bucket) {
  const [y, m, d] = partsOf(ymd);
  if (bucket === "month") return `${MONTHS_UK[m - 1]}'${String(y).slice(-2)}`;
  const endMs = Date.UTC(y, m - 1, d + 6);
  const e = new Date(endMs);
  return `${pad2(d)}.${pad2(m)}–${pad2(e.getUTCDate())}`;
}

const convOf = (b) =>
  b.salesCount ? Math.round((b.successCount / b.salesCount) * 100) : 0;

// arrow vs previous value; null-safe (no arrow when either side is missing)
function arrow(cur, prev) {
  if (cur == null || prev == null) return " ";
  if (cur > prev) return "↑";
  if (cur < prev) return "↓";
  return "·";
}

// Returns the message text (Markdown; the trajectory table is in a ``` block so columns align).
function buildDynamicsText(name, bucket, buckets) {
  if (!buckets.length) {
    return `📈 *Менеджер: ${displayName(name)}*\n\nЩе немає даних для цього менеджера.`;
  }
  const title = `📈 *Менеджер: ${displayName(name)}* · останні ${buckets.length} ${bucketWord(buckets.length, bucket)}`;

  // Trajectory table (monospace). "Перша"/"Друга" are placeholder columns (content TBD - see
  // CLAUDE.md "Поточний статус") added just to check that a 6-column table still fits on mobile.
  // "Бал" is deliberately asymmetric: the header sits 1 char further LEFT than before (no
  // padding - "Бал" already fills its 3-char field) while the data cells sit 1 char further
  // RIGHT (padded to 5 instead of 4). BAL_GAP compensates the header's trailing space so the
  // "Перша" column still lines up between the header row and every data row despite the two
  // fields having different widths (3 vs 5): 1 + (5 - 3) = 3 spaces.
  const BAL_HEADER = "Бал";
  const BAL_DATA_WIDTH = 5;
  const BAL_GAP = " ".repeat(1 + (BAL_DATA_WIDTH - BAL_HEADER.length));
  const head = `${"Період".padEnd(10)}${"Дзв".padStart(4)} ${"Кон".padStart(5)} ${BAL_HEADER}${BAL_GAP}${"Перша".padStart(5)} ${"Друга".padStart(5)}`;
  const rows = [head];
  buckets.forEach((b, i) => {
    const prev = i > 0 ? buckets[i - 1] : null;
    const conv = convOf(b);
    const convArr = prev ? arrow(conv, convOf(prev)) : " ";
    const scoreNum = b.avgScore == null ? null : Number(b.avgScore);
    const scoreArr = prev
      ? arrow(scoreNum, prev.avgScore == null ? null : Number(prev.avgScore))
      : " ";
    const label = bucketLabel(b.bucketStart, bucket).padEnd(10);
    const calls = String(b.callCount).padStart(4);
    const convCell = `${conv}%${convArr}`.padStart(5);
    const scoreCell = `${b.avgScore ?? "—"}${scoreArr}`.padStart(BAL_DATA_WIDTH);
    const placeholder1 = "—".padStart(5);
    const placeholder2 = "—".padStart(5);
    rows.push(
      `${label}${calls} ${convCell} ${scoreCell} ${placeholder1} ${placeholder2}`,
    );
  });
  const table = "```\n" + rows.join("\n") + "\n```";

  // Weakest-stage evolution (one line per bucket) - full stage name, never abbreviated.
  const stageLines = buckets
    .map(
      (b) =>
        `• ${bucketLabel(b.bucketStart, bucket)}: ${b.topWeakStage || "—"}`,
    )
    .join("\n");

  // Growth verdict: compare the first vs last MEANINGFUL bucket, ignoring near-empty ones (a bucket
  // with 0 sales / no score would otherwise distort the trend — e.g. a 2-call week reading as 0%).
  const salesB = buckets.filter((b) => b.salesCount > 0);
  const scoreB = buckets.filter((b) => b.avgScore != null);
  const convFirst = salesB.length ? convOf(salesB[0]) : null;
  const convLast = salesB.length ? convOf(salesB[salesB.length - 1]) : null;
  const dConv = salesB.length >= 2 ? convLast - convFirst : null;
  const sFirst = scoreB.length ? Number(scoreB[0].avgScore) : null;
  const sLast = scoreB.length
    ? Number(scoreB[scoreB.length - 1].avgScore)
    : null;
  const dScore =
    scoreB.length >= 2 ? Math.round((sLast - sFirst) * 10) / 10 : null;

  // Dead-zones so small fluctuations (noise) don't read as a real trend.
  const CONV_EPS = 3; // percentage points
  const SCORE_EPS = 0.3;
  let verdict = "недостатньо даних для тренду";
  if (dConv != null || dScore != null) {
    const ups =
      (dConv != null && dConv >= CONV_EPS ? 1 : 0) +
      (dScore != null && dScore >= SCORE_EPS ? 1 : 0);
    const downs =
      (dConv != null && dConv <= -CONV_EPS ? 1 : 0) +
      (dScore != null && dScore <= -SCORE_EPS ? 1 : 0);
    if (ups && !downs) verdict = "РІСТ ✅";
    else if (downs && !ups) verdict = "СПАД ⚠️";
    else if (ups && downs) verdict = "змішана 🔄";
    else verdict = "без змін ➖";
  }

  // Summary shows AVERAGES over the shown period (not first→last deltas - that's what the verdict
  // above is for). Conversion is weighted by each bucket's actual sales/success counts; score is a
  // simple mean of the per-bucket averages (that's the finest grain store.getBucketedTrend gives us).
  const totalSales = buckets.reduce((s, b) => s + (b.salesCount || 0), 0);
  const totalSuccess = buckets.reduce((s, b) => s + (b.successCount || 0), 0);
  const avgConv = totalSales
    ? Math.round((totalSuccess / totalSales) * 100)
    : null;
  const scoredBuckets = buckets.filter((b) => b.avgScore != null);
  const avgScoreOverall = scoredBuckets.length
    ? Math.round(
        (scoredBuckets.reduce((s, b) => s + Number(b.avgScore), 0) /
          scoredBuckets.length) *
          10,
      ) / 10
    : null;

  const summary =
    `📊 *Підсумок за ${buckets.length} ${bucketWord(buckets.length, bucket)}:*\n` +
    `Середня конверсія ${avgConv ?? "—"}%\n` +
    `Середній бал ${avgScoreOverall ?? "—"}\n` +
    `Динаміка: *${verdict}*`;

  return `${title}\n\n${table}\n👎 *Проблемні сегменти воронки:*\n${stageLines}\n\n${summary}`;
}

export { buildDynamicsText };
