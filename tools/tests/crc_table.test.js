// CRC8 表验收：拿官方小程序「成功刷机」那份抓包里的**每一帧**来验 tools/crc8_table.js。
// 为什么单独立一条：官方网页 W96D_V3.8.html 的表在 120/202 两处误写成 200，照抄它会让长帧
// （102B 解锁头 / 134B 数据帧）CRC 全错、设备静默丢弃 —— 短帧恰好两表同值，所以极难发现。
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const T = require(path.join(__dirname, '..', 'crc8_table.js'));
const CFA = path.join(ROOT, 'BT_HCI_*.cfa');

const crc8 = u8 => { let c = 0x89; for (const x of u8) c = T[(c ^ x) & 0xff]; return c; };
const unmask = f => { const m = T[f[1]]; const o = Buffer.from(f); for (let i = 2; i < o.length; i++) o[i] ^= m; return o; };

const fails = [];
if (T.length !== 256) fails.push(`表长 ${T.length} ≠ 256`);
if (T[120] !== 102) fails.push(`T[120] = ${T[120]}，应为 102（poly 0x3B 真值；官方网页误写 200）`);
if (T[202] !== 101) fails.push(`T[202] = ${T[202]}，应为 101（poly 0x3B 真值；官方网页误写 200）`);
console.log(`表长 ${T.length}｜T[120]=${T[120]} T[202]=${T[202]}（poly 0x3B 非反射，初值 0x89）`);

const b = fs.readFileSync(CFA);
let off = 16; const groups = {}; let total = 0, pass = 0;
while (off + 24 <= b.length) {
  const incl = b.readUInt32BE(off + 4); const d = b.subarray(off + 24, off + 24 + incl); off += 24 + incl;
  if (d[0] !== 2 || d.length < 13) continue;
  const op = d[9];
  if (![0x52, 0x12, 0x1b, 0x1d].includes(op)) continue;
  const dev = (op === 0x1b || op === 0x1d);
  const v = Buffer.from(d.subarray(12));
  if (v.length < 6 || v[0] !== 0x55) continue;
  const f = dev ? unmask(v) : v;
  const len = f.readUInt16LE(2);
  if (4 + len + 1 !== f.length) continue;
  const cls = (dev ? '设备通知' : '主机写') + ' ' + f.length + 'B';
  groups[cls] = groups[cls] || { n: 0, ok: 0 };
  groups[cls].n++; total++;
  if (crc8(f.slice(0, 4 + len)) === f[4 + len]) { groups[cls].ok++; pass++; }
}
for (const [cls, g] of Object.entries(groups).sort()) {
  const ok = g.ok === g.n;
  console.log(`  ${cls}: CRC 通过 ${g.ok}/${g.n}${ok ? '' : '  ✗'}`);
  if (!ok) fails.push(`${cls} 有 ${g.n - g.ok} 条 CRC 不通过`);
}
console.log(`合计 ${pass}/${total}`);
if (total < 600) fails.push(`样本只有 ${total} 条，抓包似乎不完整`);

console.log('\n' + (fails.length ? '✗ 失败项:\n  ' + fails.join('\n  ') : '✓ CRC8 表与抓包逐帧吻合'));
process.exit(fails.length ? 1 : 0);
