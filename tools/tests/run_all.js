#!/usr/bin/env node
/* 跑齐仓库里的回归测试。
 *
 *   node tools/tests/run_all.js
 *
 * 每个测试都是独立的 node 脚本，退出码 0 = 通过。改动 W96D统一控制台.html /
 * tools/*.js / rom/ 之后跑一遍最省心。 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();

const rows = [];
let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const t = Date.now();
  const r = spawnSync('node', [path.join(dir, f)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t;
  const tail = (r.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] || (r.stderr || '').trim().split('\n').slice(-1)[0] || '';
  const ok = r.status === 0;
  if (!ok) failed++;
  rows.push({ f, ok, ms, tail: tail.slice(0, 96) });
  console.log(`${ok ? '✓' : '✗'} ${f.padEnd(26)} ${String(ms + 'ms').padStart(8)}  ${tail}`);
  if (!ok && r.stderr) console.log('  ── stderr ──\n' + r.stderr.trim().split('\n').slice(-8).map(l => '  ' + l).join('\n'));
}
console.log(`\n${failed ? '✗' : '✓'} ${files.length - failed}/${files.length} 通过，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
