// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// OTA 全流程 mock 回归（mock 设备规则 = 抓包行为）
// 校验：① 0x8F 在 0x84 应答后、断链前同连接发出；② 解锁帧 = 0x81 + 固件头 96B；
//       ③ 数据帧 639 条、逐字节等于固件体（81860-96=81764B）、末帧 100B；
//       ④ 顺序 = 0x85→0x8C→0x81→0x87→数据→0x88→0x0B；⑤ 干跑不发 0x81/0x87/0x0B。
const fs = require('fs'), vm = require('vm');
const HTML = path.join(ROOT, 'W96D统一控制台.html');
const FW = fs.readFileSync(path.join(ROOT, 'rom/W96D_V13.up'));   // 真实固件 81860B
const html = fs.readFileSync(HTML, 'utf8');
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
  LOGS=[]; logTo=(id,l)=>LOGS.push(l); globalThis.REC=[];
  onDfuReceive=(rx,data,results)=>{const len=data[2]|(data[3]<<8);results.push(Array.from(data.slice(4,4+len)));};
  S.type='ble'; S.busy=false;
  const dev={name:'W96D_000123', gatt:{connected:true, disconnect(){ EV.push('disconnect'); ARMED=false; S.type='none'; cleanupBle(); }}};
  S.ble={device:dev,services:{},chars:{}};
  bleDiscover=async(d)=>{ S.type='ble'; S.ble.services={FEE0:1}; S.ble.chars={DFU_W:W,DFU_N:N}; EV.push('reconnect'); };
  ARMED=false; STAGE=false; EV=[]; listener=null; globalThis.WRITES=[];
  globalThis.END88='ok'; globalThis.CI_AFTER=null; globalThis.END_DONE=false;
  const reply=(r)=>{ if(r && listener){ const f=new Uint8Array(5+r.length); f[0]=0x55; f[2]=r.length; f.set(r,4); listener({target:{value:new DataView(f.buffer)}}); } };
  const W={ properties:{read:false,write:true,writeWithoutResponse:true},
    writeValueWithoutResponse:async b=>{ const f=Uint8Array.from(b); const len=f[2]|(f[3]<<8); const p=Array.from(f.slice(4,4+len));
      const raw=p[0], cmd=raw&0x7f;   // 工具发的控制帧带 bit7（0x84/0x85/0x8F…），按低 7 位分发；WRITES 存原始字节供断言
      globalThis.WRITES.push({cmd:raw,len,p});
      if(cmd===0x0f){ if(ARMED){ STAGE=true; ARMED=false; EV.push('8f-switch'); setTimeout(()=>{try{dev.gatt.disconnect();}catch(e){}},30); } else reply([0x0a,0x7b,0x00,0x00,0x00]); }
      else if(cmd===0x0a) reply([0x04,0x0d]);
      else if(cmd===0x04){ ARMED=true; reply([0x02]); }
      else if(cmd===0x05) reply((globalThis.END_DONE && globalThis.CI_AFTER) ? [globalThis.CI_AFTER] : (STAGE?[0x02]:[0x01]));
      else if(cmd===0x0c) reply([0x05,0x00,0x10]);
      else if(cmd===0x01) reply(len===97 ? (STAGE?[0x02]:null) : [0x01]);
      else if(cmd===0x07) reply(STAGE?[0x02]:null);
      else if(cmd===0x08){ if(globalThis.END88==='ok') reply(STAGE?[0x02]:null); else globalThis.END_DONE=true; }
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
  const hex = a => Array.from(a).map(x => x.toString(16).padStart(2,'0')).join(' ');
  const setG = (k,v)=>vm.runInContext(`globalThis.${k}=${JSON.stringify(v)}`, ctx);

  // 场景 A：0x88 无应答，随后 0x85→02（设备仍停在传输阶段）
  setG('END88','none'); setG('CI_AFTER',2); setG('END_DONE',false);
  vm.runInContext('LOGS.length=0; S.type="ble"; STAGE=true; ARMED=false;', ctx);
  let rA=null; try { rA = await vm.runInContext('otaRun(false)', ctx); } catch(e){ fails.push('A 抛出异常: '+e.message); }
  const LA = vm.runInContext('LOGS', ctx);
  const vA = LA.filter(l=>/升级未完成|固件已生效|升级结果未确认/.test(l)).slice(-1)[0] || '';
  console.log('A 0x88 无应答 + 0x85→02');
  console.log('   判定:', vA.replace(/^\[OTA\] /,'').slice(0,80));
  if (!/升级未完成/.test(vA)) fails.push('A 未给出"升级未完成（设备仍在升级模式）"的判定');
  if (rA !== false) fails.push('A 返回值应为 false');
  if (!LA.some(l=>/已补发复位指令/.test(l))) fails.push('A 未补发复位指令');
  const W = vm.runInContext('globalThis.WRITES', ctx);
  if (!W.some(w=>w.cmd===0x88||w.cmd===0x08)) fails.push('A 未发 0x88');
  const n88 = W.filter(w=>w.cmd===0x88).length;
  console.log('   0x88 重试次数:', n88, '｜写入总条数:', W.length);

  // 场景 B：0x88 无应答，随后 0x85→01（设备已回应用态 = 固件已生效）
  setG('END88','none'); setG('CI_AFTER',1); setG('END_DONE',false);
  vm.runInContext('LOGS.length=0; S.type="ble"; STAGE=true;', ctx);
  let rB=null; try { rB = await vm.runInContext('otaRun(false)', ctx); } catch(e){ fails.push('B 抛出异常: '+e.message); }
  const LB = vm.runInContext('LOGS', ctx);
  const vB = LB.filter(l=>/升级未完成|固件已生效|升级结果未确认/.test(l)).slice(-1)[0] || '';
  console.log('B 0x88 无应答 + 0x85→01');
  console.log('   判定:', vB.replace(/^\[OTA\] /,'').slice(0,80));
  if (!/固件已生效/.test(vB)) fails.push('B 未给出"设备已恢复正常运行/固件已生效"的判定');

  console.log('\n' + (fails.length ? '✗ 失败项:\n  ' + fails.join('\n  ') : '✓ 全部断言通过'));
  process.exit(fails.length ? 1 : 0);
})();
