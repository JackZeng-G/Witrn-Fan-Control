#!/usr/bin/env node
/* HCI 日志解析器（针对本项目：复盘官方小程序/APP 的 BLE 刷机流程）
 *
 * 用法: node tools/parse_hci_log.js <日志文件> [--full]
 *   日志文件: btsnoop（*.log / *.cfa / *.btsnoop）或 pcap
 *   --full    打印每条报文完整字节（默认长帧截断）
 *
 * 输出:
 *   1) 连接与链路事件（连接/断开原因/连接参数=监督超时/MTU 协商/CCCD 订阅）
 *   2) 设备广播中的模式切换（扫描到 "…|DFU" 即设备已重启进 DFU 态）
 *   3) DFU 命令 → 应答 时序表（含每条延迟；设备通知帧按 CRC8_TABLE[key] 解掩码）
 *   4) 数据阶段统计（块数/覆盖字节/发送节奏）
 *   5) 句柄统计 + 写入/通知序列 + ≥20B 大帧（供比对解锁/头部帧）
 *
 * 结论（2026-09-25 官方小程序成功刷机抓包验证，详见 逆向分析与统一工具方案.md §2.4）：
 *   ENTER_DFU(0x84) 后设备立即停止响应并重启进 DFU 态 → 旧连接在监督超时(5s)后以 reason=0x08 断开，
 *   设备改播 FEE0 + "WITRN&W96D001@10|DFU" → 客户端必须**重新连接并重新订阅** FEE2，
 *   此后设备才接收 102B 解锁帧与 134B 数据帧（应用态收包缓冲仅约 20B，大帧被静默丢弃）。
 */
const fs = require('fs');
const path = require('path');
const CRC8_TABLE = require(path.join(__dirname, 'crc8_table.js'));

const file = process.argv[2];
const FULL = process.argv.includes('--full');
if (!file) { console.error('用法: node tools/parse_hci_log.js <日志文件> [--full]'); process.exit(1); }
const buf = fs.readFileSync(file);

// ---------- 容器解析：btsnoop / pcap ----------
function parseBtsnoop(b) {
  if (b.slice(0, 8).toString('latin1') !== 'btsnoop\0') return null;
  // btsnoop 头 = magic(8) + version(4) + datalink(4) = 16 字节；记录头 24 字节
  const datalink = b.readUInt32BE(12); // 1001=HCI unencapsulated, 1002=HCI UART(H4), 2001=monitor
  const pkts = [];
  let off = 16, base = null;
  while (off + 24 <= b.length) {
    const inclLen = b.readUInt32BE(off + 4);
    const flags = b.readUInt32BE(off + 8);
    const tsMs = Number(b.readBigUInt64BE(off + 16) / 1000n); // 微秒 → 毫秒
    if (base === null) base = tsMs;
    const data = b.slice(off + 24, off + 24 + inclLen);
    pkts.push({ t: tsMs - base, dir: (flags & 0x01) ? 'to-host' : 'from-host', data });
    off += 24 + inclLen;
  }
  return { kind: 'btsnoop', datalink, pkts };
}
function parsePcap(b) {
  const magic = b.readUInt32LE(0);
  if (magic !== 0xa1b2c3d4 && magic !== 0xd4c3b2a1) return null;
  const le = magic === 0xa1b2c3d4;
  const rd32 = o => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const linktype = rd32(20);
  const pkts = [];
  let off = 24;
  while (off + 16 <= b.length) {
    const inclLen = rd32(off + 8);
    const data = b.slice(off + 16, off + 16 + inclLen);
    pkts.push({ t: null, dir: 'from-host', data, linktype });
    off += 16 + inclLen;
  }
  return { kind: 'pcap', linktype, pkts };
}

const parsed = parseBtsnoop(buf) || parsePcap(buf);
if (!parsed) {
  console.error('无法识别容器格式（前 8 字节: ' + buf.slice(0, 8).toString('hex') + '）');
  console.error('若为 vivo 的 .cfa：它通常是 btsnoop，直接喂给本脚本即可；不行就改名 .cap 用 Wireshark 另存为 pcap。');
  process.exit(1);
}
const hex = u8 => Buffer.from(u8).toString('hex').replace(/(..)/g, '$1 ').trim();
const hasT = parsed.pkts.some(p => p.t !== null);
const dur = hasT && parsed.pkts.length ? parsed.pkts[parsed.pkts.length - 1].t : 0;
console.log(`容器=${parsed.kind} datalink/linktype=${parsed.datalink ?? parsed.linktype} 数据包=${parsed.pkts.length}` +
  (hasT ? ` 时长=${(dur / 1000).toFixed(1)}s` : ' （无时间戳）'));

// ---------- DFU 帧 ----------
const CRC8_INIT = 0x89;
function crc8(u8, end) {
  let c = CRC8_INIT;
  const n = end === undefined ? u8.length : end;
  for (let i = 0; i < n; i++) c = CRC8_TABLE[(c ^ u8[i]) & 0xff];
  return c;
}
// 帧: 55|key|len16LE|payload|crc；设备→主机方向 字节(≥2) 与 CRC8_TABLE[key] 异或
function dfuDecode(v) {
  if (!v || v.length < 5 || v[0] !== 0x55) return null;
  const key = v[1], m = CRC8_TABLE[key];
  const d = Buffer.from(v);
  for (let i = 2; i < d.length; i++) d[i] ^= m;
  const len = d.readUInt16LE(2);
  const crcAt = 4 + len;
  if (crcAt + 1 > d.length || len < 1 || len > 300) return { key, len, payload: d.slice(4), crcOk: false, bad: true };
  return { key, len, payload: d.slice(4, crcAt), crcOk: crc8(d, crcAt) === d[crcAt] };
}
const CTRL = {
  0x04: 'ENTER_DFU(进DFU)', 0x84: 'ENTER_DFU(进DFU)', 0x05: 'CHECK_IN_DFU(查DFU态)', 0x85: 'CHECK_IN_DFU(查DFU态)',
  0x07: 'START_UP(开始收数)', 0x87: 'START_UP(开始收数)', 0x08: 'END_UP(结束收数)', 0x88: 'END_UP(结束收数)',
  0x0b: 'RESET(重启)', 0x8b: 'RESET(重启)', 0x0c: 'GET_PAGE_SIZE(页大小)', 0x8c: 'GET_PAGE_SIZE(页大小)',
  0x0a: 'GET_VERSION(版本)', 0x8a: 'GET_VERSION(版本)', 0x0f: 'GET_SN(序列号)', 0x8f: 'GET_SN(序列号)'
};
function nameOfFrame(f) {
  if (!f) return '非DFU帧';
  if (f.bad) return `疑似DFU帧(长度字段非法 len=${f.len})`;
  const p = f.payload;
  if (f.len === 1) return CTRL[p[0]] || ('CTRL 0x' + p[0].toString(16));
  if (p[0] === 0x81) return `REQ_UNLOCK(解锁 + ${f.len - 1}B 文件头)`;
  if (p[0] === 0x02) return `WRITE_FLASH(数据 ${f.len - 1}B)`;
  return `DATA 0x${p[0].toString(16)} (${f.len}B)`;
}
function briefReply(f) {
  if (!f || f.bad) return '(无法解帧)';
  const p = f.payload, s = hex(p);
  if (!f.crcOk) return 'CRC✗ ' + s;
  if (f.len === 1) return `状态 ${p[0].toString(16).padStart(2, '0')}${p[0] === 1 ? ' = 应用态' : p[0] === 2 ? ' = DFU态/OK' : ''}`;
  if (p[0] === 0x0a && f.len === 5) return `序列号 0x${p.readUInt32LE(1).toString(16)}  [${s}]`;
  if (p[0] === 0x04) return `版本 ${s}`;
  if (p[0] === 0x05) return `页大小 0x${p.readUInt16LE(1).toString(16)}  [${s}]`;
  return s;
}

// ---------- 逐包解析 ----------
const REASON = { 0x08: '(监督超时→设备已重启)', 0x13: '(对端主动断开)', 0x16: '(本机主动断开)', 0x22: '(对端主动断开)' };
const writes = [], notifies = [], reads = [], events = [], advSeen = [];
const handleStat = new Map();
for (const p of parsed.pkts) {
  const d = p.data;
  if (!d.length) continue;

  // HCI 事件
  if (d[0] === 0x04 && d.length > 2) {
    const code = d[1];
    if (code === 0x05) { // Disconnect Complete: plen|status|handle(2)|reason
      events.push({ t: p.t, text: `断开完成 handle=0x${d.readUInt16LE(4).toString(16)} 原因=0x${d[6].toString(16).padStart(2, '0')}${REASON[d[6]] || ''}` });
    } else if (code === 0x0e && d.length > 6) { // Command Complete
      const op = d.readUInt16LE(4);
      if (op === 0x2006) events.push({ t: p.t, text: 'HCI 发起连接(LE Create Connection)' });
      else if (op === 0x200a) events.push({ t: p.t, text: 'HCI 取消连接(LE Create Connection Cancel)' });
    } else if (code === 0x3e && d.length > 5) { // LE Meta
      const sub = d[3];
      if (sub === 0x0a || sub === 0x01) { // 增强/普通连接完成: status|handle(2)|role|addrtype|addr(6)
        if (d[4] === 0) {
          const addr = [...d.slice(9, 15)].reverse().map(x => x.toString(16).padStart(2, '0')).join(':');
          events.push({ t: p.t, text: `连接建立 handle=0x${d.readUInt16LE(5).toString(16)} 对端=${addr}` });
        }
      } else if (sub === 0x03) { // Connection Update Complete
        events.push({ t: p.t, text: `连接参数更新 间隔=${d.readUInt16LE(7) * 1.25}ms 监督超时=${d.readUInt16LE(11) * 10}ms` });
      } else if (sub === 0x02 || sub === 0x0d) { // 广播 / 扩展广播报告
        const asc = d.toString('latin1').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (/DFU|WITRN|W96D/.test(asc)) advSeen.push({ t: p.t, text: asc.slice(0, 110) });
      }
    }
    continue;
  }

  // ACL → L2CAP → ATT（只处理首片）
  let acl = null;
  if (d[0] === 0x02 && d.length > 4) acl = d.slice(1);
  else if (d.length > 6 && (d.readUInt16LE(0) & 0x0fff) < 0x0fff) acl = d;
  if (!acl || acl.length < 8) continue;
  if (((acl.readUInt16LE(0) >> 12) & 0x1) !== 0) continue; // 只跳续帧(PB=1)；PB=0/2 都是首片
  const l2len = acl.readUInt16LE(4), cid = acl.readUInt16LE(6);
  if (cid !== 0x0004) continue;
  const att = acl.slice(8, 8 + Math.min(l2len, acl.length - 8));
  if (att.length < 3) continue;
  const op = att[0];
  if (op === 0x52 || op === 0x12) {
    const h = att.readUInt16LE(1), val = att.slice(3);
    if (h === 0x13) events.push({ t: p.t, text: `订阅 FEE2 通知（CCCD 0x0013 ← ${hex(val)}）` });
    writes.push({ t: p.t, dir: p.dir, op: op === 0x52 ? 'WRITE_CMD' : 'WRITE_REQ', handle: h, val, frame: dfuDecode(val) });
    handleStat.set(h, (handleStat.get(h) || 0) + 1);
  } else if (op === 0x1b || op === 0x1d) {
    const h = att.readUInt16LE(1), val = att.slice(3);
    notifies.push({ t: p.t, dir: p.dir, op: 'NOTIFY', handle: h, val, frame: dfuDecode(val) });
    handleStat.set('n' + h, (handleStat.get('n' + h) || 0) + 1);
  } else if (op === 0x02 || op === 0x03) {
    events.push({ t: p.t, text: (p.dir === 'from-host' ? 'MTU 请求 ' : 'MTU 应答 ') + att.readUInt16LE(1) });
  } else if (op === 0x0a || op === 0x0b) {
    reads.push({ t: p.t, dir: p.dir, op: op === 0x0a ? 'READ_REQ' : 'READ_RSP', handle: att.readUInt16LE(1), val: op === 0x0b ? att.slice(1) : null });
  }
}
const ts = t => (hasT && t !== null && t !== undefined) ? '+' + String(t).padStart(6) + 'ms ' : '';

// ---------- 报告 ----------
const evs = events.filter(e => e.t !== null).sort((a, b) => a.t - b.t);
if (evs.length) {
  console.log('\n=== 连接与链路事件 ===');
  evs.forEach(e => console.log('  ' + ts(e.t) + e.text));
}
if (advSeen.length) {
  console.log('\n=== 设备广播（模式切换证据）===');
  advSeen.forEach(a => console.log('  ' + ts(a.t) + a.text));
}

const dfuW = writes.filter(w => w.frame);
const dfuN = notifies.filter(n => n.frame);
const ctrlW = dfuW.filter(w => !(w.frame.payload[0] === 0x02 && w.frame.len > 2)); // 非数据帧
console.log(`\n=== DFU 命令 → 应答（写 ${dfuW.length} 条 / 通知 ${dfuN.length} 条）===`);
for (const w of ctrlW) {
  const reply = dfuN.find(n => n.t !== null && w.t !== null && n.t >= w.t && n.t - w.t < 3000);
  const dt = reply ? ` (+${reply.t - w.t}ms)` : ' (无应答)';
  console.log(`  ${ts(w.t)}→ ${nameOfFrame(w.frame)}${dt}${reply ? '  ← ' + briefReply(reply.frame) : ''}`);
}

const dataF = dfuW.filter(w => w.frame.payload[0] === 0x02 && w.frame.len > 2);
if (dataF.length > 1) {
  const ds = [];
  for (let i = 1; i < dataF.length; i++) ds.push(dataF[i].t - dataF[i - 1].t);
  const s = [...ds].sort((a, b) => a - b);
  const bytes = dataF.reduce((a, w) => a + w.frame.len - 1, 0);
  console.log('\n=== 数据阶段 ===');
  console.log(`  数据帧 ${dataF.length} 条，共 ${bytes} 字节（应等于 .up 文件大小 - 96B 头部）`);
  console.log(`  首帧 ${ts(dataF[0].t)}末帧 ${ts(dataF[dataF.length - 1].t)}跨度 ${((dataF[dataF.length - 1].t - dataF[0].t) / 1000).toFixed(2)}s`);
  console.log(`  帧间隔 min/中位/max = ${s[0]}/${s[s.length >> 1]}/${s[s.length - 1]}ms，速率 ${(dataF.length / ((dataF[dataF.length - 1].t - dataF[0].t) / 1000)).toFixed(1)} 帧/秒`);
}

console.log('\n=== 句柄统计（w=写, n=通知） ===');
for (const [k, v] of [...handleStat.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
  const isN = String(k).startsWith('n');
  const h = Number(String(k).replace(/^n/, ''));
  console.log(`  ${isN ? '通知' : '写  '} handle=0x${h.toString(16).padStart(4, '0')}: ${v} 次`);
}

console.log(`\n=== 写入序列（前 60 条，共 ${writes.length}） ===`);
writes.slice(0, 60).forEach((w, i) => {
  const s = hex(w.val);
  console.log(`  ${String(i + 1).padStart(3)} ${ts(w.t)}${w.op} h=0x${w.handle.toString(16)} len=${w.val.length} ${s.length > 90 && !FULL ? s.slice(0, 90) + '…' : s}`);
});

console.log(`\n=== 通知序列（前 40 条，共 ${notifies.length}） ===`);
notifies.slice(0, 40).forEach((w, i) => {
  const s = hex(w.val);
  console.log(`  ${String(i + 1).padStart(3)} ${ts(w.t)}${w.op} h=0x${w.handle.toString(16)} len=${w.val.length} ${s.length > 90 && !FULL ? s.slice(0, 90) + '…' : s}`);
});

const big = writes.filter(w => w.val.length >= 20);
console.log(`\n=== ≥20B 的写入（${big.length} 条，最多列 10 条）===`);
big.slice(0, 10).forEach((w, i) => {
  const s = hex(w.val);
  console.log(`  ${String(i + 1).padStart(3)} len=${w.val.length} ${s.length > 160 && !FULL ? s.slice(0, 160) + '…' : s}`);
});

if (reads.length) {
  console.log(`\n=== 读特征（${reads.length} 条，最多 20 条）===`);
  reads.slice(0, 20).forEach(r => console.log(`  ${ts(r.t)}${r.op} h=0x${r.handle.toString(16)} ${r.val ? hex(r.val) : ''}`));
}
console.log('\n提示：`WRITE_CMD(无响应)` vs `WRITE_REQ(带响应)` 即写入类型；带 `0x55` 帧头的即本项目的 DFU 帧（设备通知已按 CRC8_TABLE[key] 解掩码）。');
