// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 回归：设备应答的 CRC 字节不符（2026-09-25 真机踩到：重连后第二次 0x85 的 02 应答被丢弃 ⇒ OTA 报 "DFU 超时"）
// 断言：① dfuRequest 在"结构完整 + CRC 不符"时宽容采用并返回载荷；② 整个 OTA 流程不再因此中止。
const fs = require('fs'), vm = require('vm');
const { makeFw } = require(path.join(__dirname, 'fixtures', 'synthetic_fw.js'));
const FW = makeFw();   // 合成固件 81860B（仓库不再附带官方固件）
const html = fs.readFileSync(path.join(ROOT, 'W96D统一控制台.html'), 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const ELS = {}, LOGS = [];
const ctx2d = { clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){} };
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
  LOGS=[]; logTo=(id,l)=>LOGS.push(l);
  onDfuReceive0 = null;   // 用工具自带的实现（不替换），只为验证 CRC 宽容分支
  S.type='ble'; S.busy=false;
  const dev={name:'W96D_000123', gatt:{connected:true, disconnect(){ ARMED=false; S.type='none'; cleanupBle(); }}};
  S.ble={device:dev,services:{},chars:{}};
  bleDiscover=async(d)=>{ S.type='ble'; S.ble.services={FEE0:1}; S.ble.chars={DFU_W:W,DFU_N:N}; };
  ARMED=false; STAGE=false; listener=null; CORRUPT={on:true,count:0};
  const sendFrame=(payload, corruptCrc)=>{           // 按官方帧法构造 + 按 CRC8_TABLE[key] 掩码
    const key=0x1f, T=CRC8_TABLE, f=new Uint8Array(5+payload.length);
    f[0]=0x55; f[1]=key; f[2]=payload.length&0xff; f[3]=(payload.length>>>8)&0xff; f.set(payload,4);
    let crc=0x89; for(let i=0;i<4+payload.length;i++) crc=T[(crc^f[i])&0xff];
    const m=T[key]; for(let i=2;i<5+payload.length;i++) f[i]^=m;
    f[f.length-1]= corruptCrc ? (crc^m)^0xff : (crc^m);   // corruptCrc: 故意写错最后一个字节
    if(listener) listener({target:{value:new DataView(f.buffer)}});
  };
  const W={ properties:{read:false,write:true,writeWithoutResponse:true},
    writeValueWithoutResponse:async b=>{ const f=Uint8Array.from(b); const cmd=f[4]&0x7f; let rep=null, corrupt=false;   // 控制帧带 bit7，按低 7 位分发
      if(cmd===0x0f){ if(ARMED){ STAGE=true; ARMED=false; setTimeout(()=>{try{dev.gatt.disconnect();}catch(e){}},30); } else rep=[0x0a,0x7b,0x00,0x00,0x00]; }
      else if(cmd===0x0a) rep=[0x04,0x0d];
      else if(cmd===0x04){ ARMED=true; rep=[0x02]; }
      else if(cmd===0x05){ rep=STAGE?[0x02]:[0x01]; corrupt = CORRUPT.on && CORRUPT.count++===0; }   // 第一次 0x85 应答故意写错 CRC
      else if(cmd===0x0c) rep=[0x05,0x00,0x10];
      else if(cmd===0x01) rep=f[2]===97?(STAGE?[0x02]:null):[0x01];
      else if(cmd===0x07||cmd===0x08) rep=STAGE?[0x02]:null;
      if(rep) sendFrame(rep, corrupt);
    },
    writeValueWithResponse:async b=>{ await W.writeValueWithoutResponse(b); } };
  const N={ properties:{notify:true}, addEventListener:(e,h)=>{listener=h;}, removeEventListener:()=>{listener=null;} };
  charOf=k=>k==='DFU_W'?W:N;
  $('otaPace').value = '1';   // 测试里把帧间隔调到最小，避免真等 639×20ms
  $('otaFile').files=[{name:'W96D_V13.up', arrayBuffer:async()=>FW_BUF.buffer.slice(FW_BUF.byteOffset,FW_BUF.byteOffset+FW_BUF.byteLength)}];
`, Object.assign(ctx, { FW_BUF: FW }));
(async () => {
  const fails = [];
  // ① 单发一条命令，应答 CRC 被写错 → 应宽容采用
  vm.runInContext('CORRUPT={on:true,count:0}; STAGE=false;', ctx);
  let got = null;
  try { got = await vm.runInContext('dfuRequest([0x05|0x80],[0x01,0x02],3000)', ctx); } catch (e) { fails.push('① 宽容模式未生效：' + e.message); }
  if (got && (got[0] & 0x7f) !== 1) fails.push('① 载荷不对：' + (got && Array.from(got)));
  const logs = vm.runInContext('LOGS', ctx);
  if (!logs.some(l => /CRC 不符但结构完整 → 宽容采用/.test(l))) fails.push('① 缺少"宽容采用"留痕日志');
  console.log('① CRC 被写错的 0x85 应答 → 返回值:', got ? Array.from(got).map(x=>'0x'+x.toString(16)).join(' ') : '(无)');
  console.log('   留痕:', logs.filter(l => /宽容采用/.test(l)).slice(-1)[0] || '(无)');

  // ② 整个 OTA：同样注入一次坏 CRC 应答，应仍能跑完
  vm.runInContext('LOGS.length=0; S.type="ble"; STAGE=false; ARMED=false; CORRUPT={on:true,count:0}; S.ble.chars={DFU_W:charOf("DFU_W"),DFU_N:charOf("DFU_N")};', ctx);
  let ok = false;
  try { ok = await vm.runInContext('otaRun(false)', ctx); } catch (e) { fails.push('② OTA 中止：' + e.message); }
  const W2 = vm.runInContext('LOGS', ctx);
  const dataLog = W2.filter(l => /全部 \d+ 块发送完毕/.test(l)).slice(-1)[0];
  console.log('② OTA 结果:', ok, '｜', dataLog || '(无完成日志)');
  if (!ok) fails.push('② OTA 未返回成功');
  console.log('\n' + (fails.length ? '✗ 失败项:\n  ' + fails.join('\n  ') : '✓ 全部断言通过'));
  process.exit(fails.length ? 1 : 0);
})();
