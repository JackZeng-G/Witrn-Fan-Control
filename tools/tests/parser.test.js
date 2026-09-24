// 解析器验收：用抓包关键帧快照（fixtures/key_frames.js）**合成一个迷你 btsnoop**，
// 跑一遍 tools/parse_hci_log.js 并断言它解出的连接事件、命令→应答时序与数据阶段统计。
// （原始 354KB 抓包已按仓库精简要求删除，解析器逻辑仍由本测试守住。）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fx = require(path.join(__dirname, 'fixtures', 'key_frames.js'));
const T = require(path.join(__dirname, '..', 'crc8_table.js'));

// 按设备侧规则造一条通知帧：55|key|len16LE|payload|CRC8，字节(≥2)与 CRC8_TABLE[key] 异或。
// 夹具里含真实设备 SN 的通知帧已按隐私要求移除，这里用占位 SN 自建一条来覆盖该结构。
function mkNotify(key, payload) {
  const f = Buffer.alloc(5 + payload.length);
  f[0] = 0x55; f[1] = key; f.writeUInt16LE(payload.length, 2); Buffer.from(payload).copy(f, 4);
  let c = 0x89; for (let i = 0; i < 4 + payload.length; i++) c = T[(c ^ f[i]) & 0xff];
  const m = T[key]; for (let i = 2; i < f.length; i++) f[i] ^= m;
  f[f.length - 1] = c ^ m;
  return f;
}
const SN_FRAME = mkNotify(0x1f, [0x0a, 0x7b, 0x00, 0x00, 0x00]);   // 占位 SN = 0x00000123

/* ---------- 合成 btsnoop ---------- */
const H4_ACL = 0x02, H4_EVT = 0x04;
const acl = (handle, att, sent) => {
  const b = Buffer.alloc(1 + 4 + 4 + att.length);
  b[0] = H4_ACL; b.writeUInt16LE(handle, 1); b.writeUInt16LE(4 + att.length, 3);
  b.writeUInt16LE(att.length, 5); b.writeUInt16LE(4, 7);       // L2CAP: len + CID=ATT
  Buffer.from(att).copy(b, 9);
  return { data: b, sent };
};
const attWrite = (handle, value) => [0x52, handle & 0xff, handle >> 8, ...value];
const attNotify = (handle, value) => [0x1b, handle & 0xff, handle >> 8, ...value];
const attMtu = (mtu, rsp) => [rsp ? 0x03 : 0x02, mtu & 0xff, mtu >> 8];   // MTU 请求/应答没有 handle 字段
const evConn = (handle) => {
  const addr = [0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa];           // 占位地址（线上 LE 字节），解析器会反转成 aa:bb:cc:dd:ee:ff
  return { data: Buffer.from([H4_EVT, 0x3e, 0x1f, 0x0a, 0x00, handle & 0xff, handle >> 8, 0x00, 0x00,
    ...addr, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x06, 0, 0, 0, 0xf4, 0x01]), sent: false };
};
const evConnParam = (handle, itv, to) => ({ data: Buffer.from([H4_EVT, 0x3e, 0x0a, 0x03, 0x00, handle & 0xff, handle >> 8,
  itv & 0xff, itv >> 8, 0, 0, to & 0xff, to >> 8]), sent: false });
const evDisconnect = (handle, reason) => ({ data: Buffer.from([H4_EVT, 0x05, 0x04, 0x00, handle & 0xff, handle >> 8, reason]), sent: false });

const H = 0x0201, HX = 0x0013, HW = 0x0010;   // 连接句柄 / CCCD / DFU 写特征
const recs = [];
const add = (t, r) => recs.push({ t, ...r });
add(29000, evConn(H));
add(29017, evConnParam(H, 6, 500));            // 7.5ms / 5000ms
add(29819, acl(H, attMtu(247, false), true));
add(29835, acl(H, attMtu(243, true), false));
add(30486, acl(H, attWrite(HX, [0x01, 0x00]), true));
add(30866, acl(H, attNotify(0x0012, SN_FRAME), false));   // SN 应答（占位值）
// 命令帧与设备应答按夹具时间轴插入
for (const c of fx.ctrl) add(c.t, acl(H, attWrite(HW, Buffer.from(c.raw, 'hex')), true));
for (const n of fx.notify) add(n.t, acl(H, attNotify(0x0012, Buffer.from(n.raw, 'hex')), false));
add(fx.unlock.t, acl(H, attWrite(HW, Buffer.from(fx.unlock.raw, 'hex')), true));
for (const d of fx.data) add(d.t, acl(H, attWrite(HW, Buffer.from(d.raw, 'hex')), true));
add(fx.tail.t, acl(H, attWrite(HW, Buffer.from(fx.tail.raw, 'hex')), true));
add(103459, evDisconnect(H, 0x08));            // 监督超时（设备重启）

recs.sort((a, b) => a.t - b.t);
const chunks = [Buffer.from('btsnoop\0', 'latin1'), Buffer.alloc(4), Buffer.alloc(4)];
chunks[1].writeUInt32BE(1, 0); chunks[2].writeUInt32BE(1002, 0);
const t0 = recs[0].t;
for (const r of recs) {
  const h = Buffer.alloc(24);
  h.writeUInt32BE(r.data.length, 0); h.writeUInt32BE(r.data.length, 4);
  h.writeUInt32BE(r.sent ? 0 : 1, 8); h.writeUInt32BE(0, 12);
  h.writeBigUInt64BE(BigInt(t0 + r.t) * 1000n, 16);
  chunks.push(h, r.data);
}
const tmp = path.join(os.tmpdir(), 'w96d_synth_' + process.pid + '.cfa');
fs.writeFileSync(tmp, Buffer.concat(chunks));

/* ---------- 跑解析器并断言 ---------- */
let out = '', err = null;
try { out = execFileSync('node', [path.join(__dirname, '..', 'parse_hci_log.js'), tmp], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
catch (e) { err = e; }
finally { fs.unlinkSync(tmp); }

const fails = [];
if (err) fails.push('解析器执行失败：' + (err.stderr || err.message));
console.log('— 连接与链路事件 —');
out.split('\n').filter(l => /连接建立|连接参数更新|断开完成|MTU|CCCD/.test(l)).forEach(l => console.log('  ' + l.trim()));
const want = [
  [/datalink\/linktype=1002/, '识别为 btsnoop / HCI H4'],
  [/连接建立 handle=0x201 对端=aa:bb:cc:dd:ee:ff/, '解析连接建立与对端地址'],
  [/连接参数更新 间隔=7\.5ms 监督超时=5000ms/, '解析连接参数（监督超时）'],
  [/MTU 请求 247/, '解析 MTU 请求'],
  [/MTU 应答 243/, '解析 MTU 应答'],
  [/订阅 FEE2 通知（CCCD 0x0013 ← 01 00）/, '识别 CCCD 订阅'],
  [/GET_SN\(序列号\) \(\+\d+ms\)\s+← 序列号 0x7b/, '0x0F → SN（占位值）'],
  [/GET_VERSION\(版本\) \(\+\d+ms\)\s+← 版本 04 0d/, '0x8A → 版本'],
  [/CHECK_IN_DFU\(查DFU态\) \(\+\d+ms\)\s+← 状态 01 = 应用态/, '切换前 0x85 → 01'],
  [/ENTER_DFU\(进DFU\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '0x84 → 02'],
  [/GET_SN\(序列号\) \(无应答\)/, '切换命令 0x8F 无应答'],
  [/CHECK_IN_DFU\(查DFU态\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '重连后 0x85 → 02'],
  [/GET_PAGE_SIZE\(页大小\) \(\+\d+ms\)\s+← 页大小 0x1000/, '0x8C → 页大小'],
  [/REQ_UNLOCK\(解锁 \+ 96B 文件头\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '102B 解锁帧 → 02'],
  [/START_UP\(开始收数\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '0x87 → 02'],
  [/END_UP\(结束收数\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '0x88 → 02'],
  [/RESET\(重启\) \(无应答\)/, '0x0B 无应答'],
  [new RegExp(`数据帧 ${fx.data.length + 1} 条，共 ${fx.data.length * 128 + 100} 字节`), `数据阶段统计（${fx.data.length + 1} 帧 / ${fx.data.length * 128 + 100}B）`],
  [/断开完成 handle=0x201 原因=0x08\(监督超时→设备已重启\)/, '断链原因（监督超时）'],
];
for (const [re, name] of want) if (!re.test(out)) fails.push(`缺少：${name}`);
console.log(`合成 btsnoop：${recs.length} 个记录｜解析输出 ${out.split('\n').length} 行｜断言 ${want.length} 项，通过 ${want.length - fails.length} 项`);
fails.forEach(f => console.log('  ✗ ' + f));
console.log('\n' + (fails.length ? '✗ 解析器输出与预期不符' : '✓ 解析器按预期解出连接事件、命令应答与数据阶段'));
process.exit(fails.length ? 1 : 0);
