// 黄金帧回归：拿官方客户端成功刷机抓包里的**关键帧快照**做「就地往返」验证 ——
// 取出线上帧的载荷，用工具 dfuPack() 重新组帧，必须与原帧逐字节一致（含 CRC8 与 key=0 的掩码）。
// 这样既覆盖了帧布局 + CRC 算法（此前正是 CRC 表两处错值让长帧全错），又不需要仓库附带厂商固件。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const fx = require(path.join(__dirname, 'fixtures', 'key_frames.js'));

const html = fs.readFileSync(path.join(ROOT, 'W96D统一控制台.html'), 'utf8');
const core = html.match(/<script id="protocol-core">([\s\S]*?)<\/script>/)[1];
const ctx = { Uint8Array, console };
vm.createContext(ctx); vm.runInContext(core, ctx);
const dfuPack = vm.runInContext('dfuPack', ctx);

const fails = [];
// 按抓包帧的声明长度切出载荷（key=0 ⇒ 线上字节即明文）
const payloadOf = f => f.slice(4, 4 + f.readUInt16LE(2));
const check = (label, rawHex, expectLen) => {
  const f = Buffer.from(rawHex, 'hex');
  const len = f.readUInt16LE(2);
  const ok = f[0] === 0x55 && f[1] === 0 && len === expectLen && Buffer.from(dfuPack(payloadOf(f))).equals(f);
  console.log(`${label}: ${f.length}B（len=${len}）｜${ok ? '✓ 重新组帧逐字节一致' : '✗ 不一致'}`);
  if (!ok) fails.push(`${label}（${f.length}B）重组后与抓包不一致`);
  return f;
};

check('102B 解锁头', fx.unlock.raw, 97);
check('106B 尾帧 ', fx.tail.raw, 101);
for (const d of fx.data) check(`134B 数据#${String(d.i).padStart(3, ' ')}`, d.raw, 129);
for (const c of fx.ctrl) check(`6B 控制 0x${c.cmd.toString(16).padStart(2, '0')}`, c.raw, 1);

if (fx.dataCount !== 638) fails.push(`夹具记录的数据帧总数 ${fx.dataCount} ≠ 638`);
if (fx.data.some(d => d.raw.length / 2 !== 134)) fails.push('存在非 134B 的数据帧样本');

console.log('\n' + (fails.length ? '✗ 失败项:\n  ' + fails.join('\n  ') : '✓ 黄金帧全部逐字节一致（帧布局 + CRC8 与成功刷机一致）'));
process.exit(fails.length ? 1 : 0);
