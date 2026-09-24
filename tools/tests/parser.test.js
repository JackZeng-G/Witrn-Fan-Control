// 解析器输出验收：对仓库里那份「官方小程序成功刷机」抓包跑一遍 tools/parse_hci_log.js，
// 断言关键统计与应答，防止解析器改动后悄悄失真（技术文档第 5 节的时序表就是它产出的）。
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const CFA = path.join(ROOT, 'BT_HCI_*.cfa');

const out = execFileSync('node', [path.join(__dirname, '..', 'parse_hci_log.js'), CFA], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const fails = [];
const want = [
  [/datalink\/linktype=1002/, '容器识别为 btsnoop/H4'],
  [/DFU 命令 → 应答（写 657 条 \/ 通知 16 条）/, 'DFU 写 657 条 / 通知 16 条'],
  [/GET_SN\(序列号\) \(\+\d+ms\)\s+← 序列号 0x000123/, '0x8F → SN 0x000123'],
  [/GET_VERSION\(版本\) \(\+\d+ms\)\s+← 版本 04 0d/, '0x8A → 04 0d'],
  [/CHECK_IN_DFU\(查DFU态\) \(\+\d+ms\)\s+← 状态 01 = 应用态/, '切换前 0x85 → 01（应用态）'],
  [/ENTER_DFU\(进DFU\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '0x84 → 02'],
  [/GET_SN\(序列号\) \(无应答\)/, '切换命令 0x8F 无应答'],
  [/CHECK_IN_DFU\(查DFU态\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '重连后 0x85 → 02（传输阶段）'],
  [/GET_PAGE_SIZE\(页大小\) \(\+\d+ms\)\s+← 页大小 0x1000/, '0x8C → 页大小 0x1000'],
  [/REQ_UNLOCK\(解锁 \+ 96B 文件头\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '102B 解锁帧 → 02'],
  [/START_UP\(开始收数\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '0x87 → 02'],
  [/END_UP\(结束收数\) \(\+\d+ms\)\s+← 状态 02 = DFU态\/OK/, '0x88 → 02'],
  [/RESET\(重启\) \(无应答\)/, '0x0B 无应答'],
  [/数据帧 639 条，共 81764 字节/, '639 帧 / 81764B'],
  [/帧间隔 min\/中位\/max = \d+\/18\/\d+ms/, '帧间隔中位 18ms'],
  [/断开完成 handle=0x201 原因=0x08\(监督超时→设备已重启\)/, '切换后链路以监督超时断开'],
  [/MTU 应答 247/, '传输阶段 MTU 247'],
  [/订阅 FEE2 通知（CCCD 0x0013 ← 01 00）/, 'CCCD 订阅被识别'],
];
for (const [re, name] of want) if (!re.test(out)) fails.push(`缺少：${name}（${re}）`);
console.log(`解析输出 ${out.split('\n').length} 行，断言 ${want.length} 项，通过 ${want.length - fails.length} 项`);
fails.forEach(f => console.log('  ✗ ' + f));
console.log('\n' + (fails.length ? '✗ 解析器输出与预期不符' : '✓ 解析器输出与 技术文档第 5 节 时序表一致'));
process.exit(fails.length ? 1 : 0);
