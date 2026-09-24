// 黄金帧回归：拿官方客户端成功刷机抓包里的**关键帧快照**，与工具 dfuPack 生成的结果逐字节对比。
// 覆盖：102B 解锁头、106B 尾帧、跨越整个固件体的 8 条 134B 数据帧。
// 这条测试同时验证「帧布局 + CRC 算法」—— 之前正是 CRC 表两处错值让长帧全错（设备静默丢弃）。
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
const hex = u8 => Buffer.from(u8).toString('hex');

const FW = fs.readFileSync(path.join(ROOT, 'rom/W96D_V13.up'));
const CHUNK = 128, HEAD = 96;
const fails = [];
const eq = (a, b) => hex(a) === b;

if (FW.length !== 81860) fails.push(`固件大小 ${FW.length} ≠ 81860`);
if (Math.floor((FW.length - HEAD) / CHUNK) !== 638) fails.push(`满帧数 ${Math.floor((FW.length - HEAD) / CHUNK)} ≠ 638`);
if (fx.dataCount !== 638) fails.push(`夹具记录的数据帧总数 ${fx.dataCount} ≠ 638`);

// ① 解锁头：0x81 + 96B 头部
const unlock = dfuPack([0x81, ...FW.slice(0, HEAD)]);
console.log(`解锁头: dfuPack ${unlock.length}B｜抓包 ${fx.unlock.raw.length / 2}B｜${eq(unlock, fx.unlock.raw) ? '✓ 逐字节一致' : '✗ 不一致'}`);
if (!eq(unlock, fx.unlock.raw)) fails.push('102B 解锁头与抓包不一致');

// ② 尾帧：最后 100B
const tail = dfuPack([0x02, ...FW.slice(HEAD + 638 * CHUNK)]);
console.log(`尾帧:   dfuPack ${tail.length}B｜抓包 ${fx.tail.raw.length / 2}B｜${eq(tail, fx.tail.raw) ? '✓ 逐字节一致' : '✗ 不一致'}`);
if (!eq(tail, fx.tail.raw)) fails.push('106B 尾帧与抓包不一致');

// ③ 数据帧（夹具里按块号给了跨越整个固件体的样本）
let bad = 0;
for (const d of fx.data) {
  const f = dfuPack([0x02, ...FW.slice(HEAD + d.i * CHUNK, HEAD + (d.i + 1) * CHUNK)]);
  const ok = eq(f, d.raw);
  if (!ok) { bad++; fails.push(`第 ${d.i} 块与抓包不一致`); }
}
console.log(`数据帧: 逐字节一致 ${fx.data.length - bad}/${fx.data.length}（块号 ${fx.data.map(d => d.i).join(', ')}）`);

console.log('\n' + (fails.length ? '✗ 失败项:\n  ' + fails.join('\n  ') : '✓ 黄金帧全部逐字节一致（帧布局 + CRC8 与成功刷机一致）'));
process.exit(fails.length ? 1 : 0);
