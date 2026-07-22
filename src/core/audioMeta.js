import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Probe how many audio channels a recording has, so the STT path can use ElevenLabs multichannel
// mode (perfect per-channel speaker separation) for stereo calls and plain diarization for mono.
// Uses system ffprobe (ships with ffmpeg, already required for audio clips). Any failure — no
// ffprobe, unknown format — returns null, and the caller falls back to the mono/diarization path.

const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`ffprobe exit ${code}: ${stderr.slice(-200)}`))));
  });
}

// Returns the channel count (integer) of the first audio stream, or null if it can't be determined.
async function probeChannels(blob) {
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), 'obv-probe-'));
    const path = join(dir, 'in.audio');
    await writeFile(path, Buffer.from(await blob.arrayBuffer()));
    const out = await runFfprobe([
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=channels',
      '-of', 'csv=p=0',
      path,
    ]);
    const n = parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    console.warn(`[audioMeta] channel probe skipped (${err.message}) — assuming mono/diarization`);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export { probeChannels };
