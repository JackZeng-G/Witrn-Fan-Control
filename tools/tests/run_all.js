#!/usr/bin/env node
/* 跑齐仓库里的回归测试。
 *
 *   node tools/tests/run_all.js           # 默认跑全部（跳过慢测）
 *   node tools/tests/run_all.js --slow    # 连慢测（帧长边界，约 2~4 分钟）一起跑
 *
 * 每个测试都是独立的 node 脚本，退出码 0 = 通过。改动 W96D统一控制台.html /
 * tools/*.js / rom/ 之后跑一遍最省心。 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const slow = ['frame_limit.test.js'];
const withSlow = process.argv.includes('--slow') || process.argv.includes('--all');
let files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort();
if (!withSlow) files = files.filter(f => !slow.includes(f));

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
console.log(`\n${failed ? '✗' : '✓'} ${files.length - failed}/${files.length} 通过，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s` +
  (withSlow ? '' : `（已跳过慢测：${slow.join(', ')}；加 --slow 一起跑）`));
process.exit(failed ? 1 : 0);
