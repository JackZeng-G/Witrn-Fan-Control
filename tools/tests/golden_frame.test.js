// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 黄金帧回归：拿官方小程序成功刷机抓包里的**每一帧**，与工具 dfuPack 生成的结果逐字节对比。
// 覆盖：102B 解锁头、638 条 134B 数据帧、106B 尾帧（共 640 帧）。
// 这条测试直接同时验证「帧布局 + CRC 算法（含 poly 0x3B 修正）」—— 之前正是 CRC 表两处错值让长帧全错。
const fs = require('fs'), vm = require('vm');
const HTML = path.join(ROOT, 'W96D统一控制台.html');
const CFA = path.join(ROOT, 'BT_HCI_*.cfa');
const FW = fs.readFileSync(path.join(ROOT, 'rom/W96D_V13.up'));
const html = fs.readFileSync(HTML, 'utf8');
const core = html.match(/<script id="protocol-core">([\s\S]*?)<\/script>/)[1];
const ctx = { Uint8Array, console };
vm.createContext(ctx); vm.runInContext(core, ctx);
const dfuPack = vm.runInContext('dfuPack', ctx);

// 取抓包里主机写的所有 0x55 帧
const b = fs.readFileSync(CFA);
let off = 16; const cap = [];
while (off + 24 <= b.length) {
  const incl = b.readUInt32BE(off + 4); const d = b.subarray(off + 24, off + 24 + incl); off += 24 + incl;
  if (d[0] !== 2 || d.length < 13) continue;
  const op = d[9]; if (op !== 0x52 && op !== 0x12) continue;
  const v = Buffer.from(d.subarray(12));
  if (v.length >= 6 && v[0] === 0x55) cap.push(v);
}
const unlock = cap.find(v => v[4] === 0x81);
const data = cap.filter(v => v[4] === 0x02 && v.length === 134);
const tail = cap.find(v => v[4] === 0x02 && v.length === 106);
const fails = [];
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

if (!unlock) fails.push('抓包里没找到解锁帧');
else if (!eq(dfuPack([0x81, ...FW.slice(0, 96)]), unlock)) fails.push('102B 解锁帧与抓包不一致');
console.log(`解锁帧: 抓包 ${unlock.length}B｜dfuPack ${dfuPack([0x81, ...FW.slice(0, 96)]).length}B｜${unlock && eq(dfuPack([0x81, ...FW.slice(0, 96)]), unlock) ? '✓ 逐字节一致' : '✗ 不一致'}`);

if (!tail) fails.push('抓包里没找到尾帧');
else if (!eq(dfuPack([0x02, ...FW.slice(96 + 638 * 128)]), tail)) fails.push('106B 尾帧与抓包不一致');
console.log(`尾帧:   抓包 ${tail && tail.length}B｜帧内数据 ${FW.length - 96 - 638 * 128}B｜${tail && eq(dfuPack([0x02, ...FW.slice(96 + 638 * 128)]), tail) ? '✓ 逐字节一致' : '✗ 不一致'}`);

if (data.length !== 638) fails.push(`抓包数据帧 ${data.length} ≠ 638`);
let bad = 0, firstBad = -1;
data.forEach((f, i) => {
  if (!eq(dfuPack([0x02, ...FW.slice(96 + i * 128, 96 + (i + 1) * 128)]), f)) { bad++; if (firstBad < 0) firstBad = i; }
});
if (bad) fails.push(`134B 数据帧有 ${bad}/${data.length} 条不一致（首个 #${firstBad}）`);
console.log(`数据帧: 抓包 ${data.length} 条｜dfuPack 逐字节一致 ${data.length - bad}/${data.length}${bad ? '  ✗' : '  ✓'}`);

console.log('\n' + (fails.length ? '✗ 失败项:\n  ' + fails.join('\n  ') : '✓ 黄金帧全部逐字节一致（帧布局 + CRC8 均与成功刷机一致）'));
process.exit(fails.length ? 1 : 0);
