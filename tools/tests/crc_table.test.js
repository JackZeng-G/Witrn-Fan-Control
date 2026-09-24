// CRC8 表验收：拿官方客户端成功刷机抓包里的**关键帧快照**（fixtures/key_frames.js）逐条验表。
// 为什么单独立一条：官方网页 W96D_V3.8.html 的表把 120/202 写成 200，照抄会让长帧（102B 解锁头 /
// 134B 数据帧）CRC 全错、设备静默丢弃；短帧两表恰好同值，所以只看小命令永远发现不了。
const path = require('path');
const T = require(path.join(__dirname, '..', 'crc8_table.js'));
const fx = require(path.join(__dirname, 'fixtures', 'key_frames.js'));

const crc8 = (u8, t = T) => { let c = 0x89; for (const x of u8) c = t[(c ^ x) & 0xff]; return c; };
const buf = h => Buffer.from(h, 'hex');
// 复刻"官方网页表"：正确表 + 120/202 两处误写成 200
const oldT = Uint8Array.from(T); oldT[120] = 200; oldT[202] = 200;

const fails = [];
console.log(`表长 ${T.length}｜T[120]=${T[120]}（应为 102）｜T[202]=${T[202]}（应为 101）`);
if (T.length !== 256) fails.push(`表长 ${T.length} ≠ 256`);
if (T[120] !== 102) fails.push(`T[120]=${T[120]}，应为 102`);
if (T[202] !== 101) fails.push(`T[202]=${T[202]}，应为 101`);

// 1) 主机写的帧：修正表必须全过；旧表在长帧上必须失败（证明这处修正确实关键）
const hostGroups = [
  ['6B 控制帧', fx.ctrl.map(c => c.raw)],
  ['102B 解锁头', [fx.unlock.raw]],
  ['106B 尾帧', [fx.tail.raw]],
  ['134B 数据帧', fx.data.map(d => d.raw)],
];
for (const [name, list] of hostGroups) {
  let ok = 0, oldOk = 0;
  for (const h of list) {
    const f = buf(h), len = f.readUInt16LE(2);
    if (crc8(f.slice(0, 4 + len)) === f[4 + len]) ok++;
    if (crc8(f.slice(0, 4 + len), oldT) === f[4 + len]) oldOk++;
  }
  console.log(`  ${name}: 修正表 ${ok}/${list.length}｜旧表 ${oldOk}/${list.length}`);
  if (ok !== list.length) fails.push(`${name} 用修正表仍有 ${list.length - ok} 条不通过`);
}
{ // 长帧上旧表必须露馅（否则说明夹具没覆盖错值路径）
  const longList = [fx.unlock.raw, fx.tail.raw, ...fx.data.map(d => d.raw)];
  const oldPass = longList.filter(h => { const f = buf(h), len = f.readUInt16LE(2); return crc8(f.slice(0, 4 + len), oldT) === f[4 + len]; }).length;
  console.log(`  旧表在长帧上通过 ${oldPass}/${longList.length}（应为 0 或极少）`);
  if (oldPass > 2) fails.push(`旧表在长帧上竟通过 ${oldPass} 条，夹具没覆盖到错值路径`);
}

// 2) 设备通知：按 CRC8_TABLE[key] 解掩码后，长度/载荷/CRC 都要对
let nOk = 0;
for (const n of fx.notify) {
  const raw = buf(n.raw), m = T[n.key];
  const f = Buffer.from(raw); for (let i = 2; i < f.length; i++) f[i] ^= m;
  const len = f.readUInt16LE(2);
  const payloadOk = f.slice(4, 4 + len).toString('hex') === n.payload;
  const crcOk = crc8(f.slice(0, 4 + len)) === f[4 + len];
  if (!payloadOk) fails.push(`通知 key=0x${n.key.toString(16)} 解掩码载荷不符（得到 ${f.slice(4, 4 + len).toString('hex')}，期望 ${n.payload}）`);
  if (!crcOk) fails.push(`通知 key=0x${n.key.toString(16)} CRC 不通过`);
  if (payloadOk && crcOk) nOk++;
}
console.log(`  设备通知（解掩码后验 CRC 与载荷）: ${nOk}/${fx.notify.length}`);
if (nOk !== fx.notify.length) fails.push('设备通知有未通过项');

console.log('\n' + (fails.length ? '✗ 失败项:\n  ' + fails.join('\n  ') : '✓ CRC8 表与抓包关键帧逐帧吻合（旧表在长帧上必然失败）'));
process.exit(fails.length ? 1 : 0);
