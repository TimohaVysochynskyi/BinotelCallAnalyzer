import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputFile } from 'grammy';
import { getCallRecordUrl } from '../core/binotel.js';

// Audio evidence for the report: cut a short clip around a quoted line so the owner can listen and
// verify. Uses SYSTEM ffmpeg (fast, tiny clips). If ffmpeg isn't installed the report still works —
// it just goes text-only (prepareClips returns an empty map). Clips are cut ONCE per report and can
// be re-sent to several recipients (scheduled fan-out).

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const PAD = Number(process.env.AUDIO_CLIP_PAD_SEC || 3); // seconds of context on each side
const MAX_CLIPS_PER_FINDING = 3;
const CAPTION_QUOTE_MAX = 300;

// Stable key so the same (call, timecode) maps to one cut clip across findings/recipients.
function clipKey(callId, start, end) {
  return `${callId}:${start}:${end}`;
}

// Cached one-shot preflight: is `ffmpeg` runnable? Cache the promise so we probe at most once.
let ffmpegProbe = null;
function ffmpegAvailable() {
  if (!ffmpegProbe) {
    ffmpegProbe = new Promise((resolve) => {
      try {
        const p = spawn(FFMPEG, ['-version']);
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }
  return ffmpegProbe;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`))));
  });
}

// Collect the unique (callId,start,end) clips needed by a report — negatives only, capped per
// finding — preserving which callId each belongs to. Findings live in report.blocks[].findings.
function allFindings(report) {
  if (Array.isArray(report.blocks)) return report.blocks.flatMap((b) => b.findings || []);
  return report.findings || [];
}

function neededClips(report) {
  const seen = new Set();
  const clips = [];
  for (const f of allFindings(report)) {
    if (f.type !== 'error') continue;
    let n = 0;
    for (const ev of f.evidence) {
      if (ev.start == null) continue;
      if (n >= MAX_CLIPS_PER_FINDING) break;
      n += 1;
      const key = clipKey(ev.callId, ev.start, ev.end);
      if (seen.has(key)) continue;
      seen.add(key);
      clips.push({ key, callId: ev.callId, start: ev.start, end: ev.end });
    }
  }
  return clips;
}

// Build a Map(clipKey → mp3 Buffer) for a report's negative findings. Downloads each source
// recording once (cached per call), cuts every needed clip with ffmpeg. Any failure (no ffmpeg,
// recording gone, cut error) just omits that clip → the report shows the text quote without audio.
async function prepareClips(report) {
  const clips = new Map();
  const wanted = neededClips(report);
  if (!wanted.length) return clips;

  if (!(await ffmpegAvailable())) {
    console.warn('[audioClip] ffmpeg not available — report will be text-only (no audio clips)');
    return clips;
  }

  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'obv-clip-'));
    const sources = new Map(); // callId → path of downloaded full mp3 (or null if unavailable)

    for (const c of wanted) {
      try {
        if (!sources.has(c.callId)) {
          sources.set(c.callId, await downloadRecording(c.callId, dir));
        }
        const src = sources.get(c.callId);
        if (!src) continue; // recording unavailable in Binotel → skip

        const from = Math.max(0, c.start - PAD);
        const dur = Math.max(1, (Number(c.end ?? c.start) - c.start) + 2 * PAD);
        const out = join(dir, `${c.key.replace(/[^\w.-]/g, '_')}.mp3`);
        await runFfmpeg(['-y', '-ss', String(from), '-i', src, '-t', String(dur), '-c:a', 'libmp3lame', '-q:a', '5', out]);
        clips.set(c.key, await readFile(out));
      } catch (err) {
        console.error(`[audioClip] clip ${c.key} failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[audioClip] prepareClips failed: ${err.message}`);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return clips;
}

async function downloadRecording(callId, dir) {
  const url = await getCallRecordUrl(callId);
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${callId}: HTTP ${res.status}`);
  const path = join(dir, `src-${String(callId).replace(/[^\w.-]/g, '_')}.mp3`);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

// Send one prepared clip as a Telegram audio message with a short caption (the quote + time).
async function sendClip(api, chatId, buf, ev) {
  const quote = ev.quote.length > CAPTION_QUOTE_MAX ? `${ev.quote.slice(0, CAPTION_QUOTE_MAX)}…` : ev.quote;
  const caption = `🎧 «${quote}»`;
  await api.sendAudio(chatId, new InputFile(buf, `evidence-${ev.callId}.mp3`), { caption });
}

export { prepareClips, clipKey, sendClip, ffmpegAvailable };
