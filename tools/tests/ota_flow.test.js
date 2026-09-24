// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// OTA 全流程 mock 回归（mock 设备规则 = 抓包行为）
// 校验：① 0x8F 在 0x84 应答后、断链前同连接发出；② 解锁帧 = 0x81 + 固件头 96B；
//       ③ 数据帧 639 条、逐字节等于固件体（81860-96=81764B）、末帧 100B；
//       ④ 顺序 = 0x85→0x8C→0x81→0x87→数据→0x88→0x0B；⑤ 干跑不发 0x81/0x87/0x0B。
const fs = require('fs'), vm = require('vm');
const HTML = path.join(ROOT, 'W96D统一控制台.html');
const { makeFw } = require(path.join(__dirname, 'fixtures', 'synthetic_fw.js'));
const FW = makeFw();   // 合成固件 81860B（仓库不再附带官方固件）
const html = fs.readFileSync(HTML, 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const ELS = {}, LOGS = [];
const ctx2d = { clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){},fillText(){},save(){},restore(){},setLineDash(){},measureText:()=>({width:0}) };
const mk = id => ({ id, textContent:'', value:'', checked:false, disabled:false, style:{}, innerHTML:'', scrollTop:0, files:[], addEventListener(){}, classList:{add(){},remove(){},contains:()=>false}, querySelector(){return null}, querySelectorAll(){return[]}, dataset:{}, width:300, height:150, getContext:()=>ctx2d, getBoundingClientRect:()=>({left:0,top:0,width:300,height:150}) });
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Uint8Array, TextEncoder, TextDecoder,
  navigator:{userAgent:'Chrome',bluetooth:{}}, location:{href:'file:///x'}, requestAnimationFrame:f=>setTimeout(f,16),
  HTMLCanvasElement:function(){return{width:300,height:150,getContext:()=>ctx2d}} };
ctx.document = { getElementById:id=>ELS[id]||(ELS[id]=mk(id)), querySelector:()=>mk('q'), querySelectorAll:()=>[], addEventListener(){}, body:{classList:{add(){},remove(){}}}, title:'' };
ctx.window = { addEventListener(){}, matchMedia:()=>({matches:false,addEventListener(){}}) };
ctx.localStorage = { getItem:()=>null, setItem(){}, removeItem(){} };
ctx.confirm = ()=>true; ctx.alert = ()=>{};
// 收尾重试参数注入短值，测试才跑得快（工具里默认 3×20s）
ctx.OTA_END_RETRIES = 2; ctx.OTA_END_TIMEOUT = 1200;
vm.createContext(ctx); vm.runInContext(script, ctx);
vm.runInContext(`
  LOGS=[]; logTo=(id,l)=>LOGS.push(l); globalThis.REC=[];
  onDfuReceive=(rx,data,results)=>{const len=data[2]|(data[3]<<8);results.push(Array.from(data.slice(4,4+len)));};
  S.type='ble'; S.busy=false;
  const dev={name:'W96D_000123', gatt:{connected:true, disconnect(){ EV.push('disconnect'); ARMED=false; S.type='none'; cleanupBle(); }}};
  S.ble={device:dev,services:{},chars:{}};
  bleDiscover=async(d)=>{ S.type='ble'; S.ble.services={FEE0:1}; S.ble.chars={DFU_W:W,DFU_N:N}; EV.push('reconnect'); };
  ARMED=false; STAGE=false; EV=[]; listener=null; globalThis.WRITES=[];
  const reply=(r)=>{ if(r && listener){ const f=new Uint8Array(5+r.length); f[0]=0x55; f[2]=r.length; f.set(r,4); listener({target:{value:new DataView(f.buffer)}}); } };
  const W={ properties:{read:false,write:true,writeWithoutResponse:true},
    writeValueWithoutResponse:async b=>{ const f=Uint8Array.from(b); const len=f[2]|(f[3]<<8); const p=Array.from(f.slice(4,4+len));
      const raw=p[0], cmd=raw&0x7f;   // 工具发的控制帧带 bit7（0x84/0x85/0x8F…），按低 7 位分发；WRITES 存原始字节供断言
      globalThis.WRITES.push({cmd:raw,len,p});
      if(cmd===0x0f){ if(ARMED){ STAGE=true; ARMED=false; EV.push('8f-switch'); setTimeout(()=>{try{dev.gatt.disconnect();}catch(e){}},30); } else reply([0x0a,0x7b,0x00,0x00,0x00]); }
      else if(cmd===0x0a) reply([0x04,0x0d]);
      else if(cmd===0x04){ ARMED=true; reply([0x02]); }
      else if(cmd===0x05) reply(STAGE?[0x02]:[0x01]);
      else if(cmd===0x0c) reply([0x05,0x00,0x10]);
      else if(cmd===0x01) reply(len===97 ? (STAGE?[0x02]:null) : [0x01]);
      else if(cmd===0x07) reply(STAGE?[0x02]:null);
      else if(cmd===0x08) reply(STAGE?[0x02]:null);
      /* 0x02 数据帧 / 0x0b 复位：无应答 */
    },
    writeValueWithResponse:async b=>{ await W.writeValueWithoutResponse(b); } };
  const N={ properties:{notify:true}, addEventListener:(e,h)=>{listener=h;}, removeEventListener:()=>{listener=null;} };
  charOf=k=>k==='DFU_W'?W:N;
  $('otaPace').value = '1';   // 测试里把帧间隔调到最小，避免真等 639×20ms
  $('otaFile').files=[{name:'W96D_V13.up', arrayBuffer:async()=>FW_BUF.buffer.slice(FW_BUF.byteOffset,FW_BUF.byteOffset+FW_BUF.byteLength)}];
  $('dfuProbeFile').files=$('otaFile').files;
`, Object.assign(ctx, { FW_BUF: FW }));
(async () => {
  const fails = [];
  const ok = await vm.runInContext('otaRun(false)', ctx);
  const W = vm.runInContext('globalThis.WRITES', ctx);
  const EV = vm.runInContext('EV', ctx);
  const cmds = W.map(w => w.cmd);
  const hex = a => a.map(x => x.toString(16).padStart(2, '0')).join(' ');
  console.log('写入总条数:', W.length, '｜事件顺序:', EV.join(' → '));
  console.log('命令序列(前 8):', cmds.slice(0, 8).map(c => '0x' + c.toString(16)).join(' '));

  // ① 切换时序
  const iSwitch = cmds.indexOf(0x8f), iDisc = W.length && EV.indexOf('8f-switch');
  if (!(EV.indexOf('8f-switch') >= 0 && EV.indexOf('8f-switch') < EV.indexOf('disconnect'))) fails.push('① 0x8F 未在断链前同连接发出');

  // ② 解锁帧
  const iUnlock = W.findIndex(w => w.cmd === 0x81 && w.len === 97);
  if (iUnlock < 0) fails.push('② 找不到 102B 解锁帧');
  else {
    const got = Buffer.from(W[iUnlock].p.slice(1));
    const exp = FW.slice(0, 96);
    if (W[iUnlock].len !== 97) fails.push('② 解锁帧载荷长≠97');
    if (!got.equals(exp)) fails.push('② 解锁帧头 96B 与固件不一致');
  }

  // ③ 数据帧
  const data = W.filter(w => w.cmd === 0x02);
  const body = FW.slice(96);
  const cat = Buffer.concat(data.map(w => Buffer.from(w.p.slice(1))));
  if (data.length !== 639) fails.push(`③ 数据帧数 ${data.length} ≠ 639`);
  if (cat.length !== body.length) fails.push(`③ 数据总长 ${cat.length} ≠ ${body.length}`);
  else if (!cat.equals(body)) fails.push('③ 数据内容与固件体不一致');
  const frames = data.map(w => w.len + 5);
  if (frames[0] !== 134 || frames[frames.length - 1] !== 106) fails.push(`③ 帧长首末 ${frames[0]}/${frames[frames.length - 1]} ≠ 134/106`);
  if (!data.slice(0, -1).every(w => w.len === 129)) fails.push('③ 存在非 128B 的中间块');

  // ④ 顺序
  const seq = [0x85, 0x8c, 0x81, 0x87, 0x02, 0x88, 0x0b];
  let pos = -1, okSeq = true;
  for (const c of seq) { const i = cmds.indexOf(c, pos + 1); if (i < 0) { okSeq = false; fails.push(`④ 顺序缺 ${c.toString(16)}`); break; } pos = i; }
  const i88 = W.findIndex(w => w.cmd === 0x88), i0b = W.findIndex(w => w.cmd === 0x0b);
  if (!(i88 >= 0 && i0b > i88)) fails.push('④ 0x0B 早于 0x88 或缺失');
  // 0x0B 之后只允许"升级后回读版本(0x8A)"这类收尾帧，不允许再出现写块/解锁/开始数据
  const after0b = W.slice(i0b + 1);
  if (after0b.some(w => w.cmd === 0x02 || w.cmd === 0x81 || w.cmd === 0x87)) fails.push('④ 0x0B 之后仍出现写块/解锁/开始数据帧');
  if (W[i0b] && W[i0b].len !== 1) fails.push('④ 0x0B 帧长异常');

  // ④b 握手应答真的被消费了（防"mock 不应答也过"）
  const L = vm.runInContext('LOGS', ctx);
  if (!L.some(l => /页大小 = 4096B/.test(l))) fails.push('④b 页大小未从 0x8C 应答取得（走了兜底）');
  if (L.some(l => /0x8C 两次无应答/.test(l))) fails.push('④b 0x8C 应答未被消费');
  if (!L.some(l => /设备版本 = 04 0d/.test(l))) fails.push('④b 0x8A 版本应答未被消费');
  if (!L.some(l => /设备 SN = 0a 7b 00 00 00/.test(l))) fails.push('④b 0x0F/0x8F SN 应答未被消费');

  // ⑤ 写入收尾：0x87 之后 0x0B 之前不允许再插别的（防流程错位）
  const i87 = W.findIndex(w => w.cmd === 0x87), i0b2 = W.findIndex(w => w.cmd === 0x0b);
  if (!(i87 >= 0 && i0b2 > i87)) fails.push('⑤ 0x87 / 0x0B 顺序异常');
  console.log('数据帧:', data.length, '｜总字节:', cat.length, '｜首/末帧长:', frames[0] + '/' + frames[frames.length - 1]);
  console.log('OTA 返回:', ok, '｜日志条数:', vm.runInContext('LOGS.length', ctx));
  console.log('\n' + (fails.length ? '✗ 失败项:\n  ' + fails.join('\n  ') : '✓ 全部断言通过'));
  process.exit(fails.length ? 1 : 0);
})();
