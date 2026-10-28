#!/usr/bin/env node
'use strict';
// Renders the sound effects of public/sfx.js to WAV files and prints their
// levels and spectra: listening without a browser, and the measures the tests use.
//
//   node scripts/render-sfx.js DIR [--seed N] [--rate 48000]
//
// See docs/developer/sound.md.
const fs = require('fs');
const path = require('path');
const Sfx = require('../public/sfx.js');

const LOW_HZ = 300; // a phone speaker plays next to nothing below this

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k; const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci; const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// A-weighting (IEC 61672), power gain at f: a rough "how loud does it sound" next to plain RMS.
function aWeight2(f) {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return (ra * 1.2589) ** 2; // +2.0 dB: 0 dB at 1 kHz
}

/** Peak, RMS of the sounding part, A-weighted RMS, spectral centroid and the energy share below LOW_HZ. */
function analyze(samples, sr) {
  let peak = 0;
  let finite = true;
  for (const x of samples) { if (!Number.isFinite(x)) finite = false; peak = Math.max(peak, Math.abs(x)); }
  const rms = Sfx.activeRms(samples);
  let n = 1;
  while (n < samples.length) n <<= 1;
  const re = new Float64Array(n); const im = new Float64Array(n);
  re.set(samples);
  fft(re, im);
  let total = 0; let low = 0; let moment = 0; let weighted = 0;
  for (let k = 1; k < n / 2; k++) {
    const f = k * sr / n;
    const p = re[k] * re[k] + im[k] * im[k];
    total += p; moment += p * f; weighted += p * aWeight2(f);
    if (f < LOW_HZ) low += p;
  }
  return {
    seconds: samples.length / sr,
    finite,
    peak,
    rms,
    rmsA: total ? rms * Math.sqrt(weighted / total) : 0,
    centroid: total ? moment / total : 0,
    lowShare: total ? low / total : 0,
  };
}

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

function wav(samples, sr) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((x, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), 44 + i * 2));
  return buf;
}

if (require.main === module) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? Number(process.argv[i + 1]) : fallback;
  };
  const dir = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null;
  const seed = arg('--seed', 1);
  const sr = arg('--rate', 48000);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  console.log('effect           len    peak    rms   rms(A)  centroid  <300 Hz');
  for (const name of Sfx.NAMES) {
    const samples = Sfx.render(name, sr, { seed });
    const a = analyze(samples, sr);
    console.log(`${name.padEnd(14)} ${a.seconds.toFixed(2)}s ${db(a.peak).toFixed(1).padStart(6)} ${db(a.rms).toFixed(1).padStart(6)} ${db(a.rmsA).toFixed(1).padStart(6)}  ${a.centroid.toFixed(0).padStart(6)} Hz  ${(a.lowShare * 100).toFixed(1).padStart(5)} %`);
    if (dir) fs.writeFileSync(path.join(dir, `${name}.wav`), wav(samples, sr));
  }
  if (dir) console.log(`WAV files in ${dir}`);
}

module.exports = { analyze, wav, LOW_HZ };
