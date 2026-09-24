// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 验证「照抄小程序」序列（2026-09-25 抓包校准版）：
//   mock 设备规则 = 抓包行为
//     · 0x84 ENTER_DFU        → 应答 02，进入「已武装(ARMED)」态，链路保持
//     · 0x8F 在 ARMED 态（同一条连接）→ 真正的切换：设备随即停 BLE（断链），无应答
//     · 0x8F 非 ARMED 态       → 只是普通 SN 查询，回 0a+SN（不切换）
//     · 断链会清掉 ARMED（旧写法「等重连后再发 0x8F」因此永远切不过去）
//     · 传输阶段：0x85→02、0x8C→05 00 10、0x81+头96B（102B）→ 02、裸 0x81→01
// 断言：① 0x8F 必须发生在断链之前（同连接）；② 102B 解锁帧的 02 应答要能通过 expect 过滤。
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(path.join(ROOT, 'W96D统一控制台.html'), 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const ELS = {}, LOGS = [];
const ctx2d = { clearRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, arc(){}, fill(){}, fillRect(){}, drawImage(){}, getImageData:()=>({data:new Uint8ClampedArray(4)}), putImageData(){} };
const mk = id => ({ id, textContent:'', value:'', checked:false, disabled:false, style:{}, innerHTML:'', scrollTop:0, files:[], addEventListener(){}, classList:{add(){},remove(){},contains:()=>false}, querySelector(){return null}, querySelectorAll(){return[]}, dataset:{}, width:300, height:150, getContext:()=>ctx2d, getBoundingClientRect:()=>({left:0,top:0,width:300,height:150}) });
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Uint8Array, TextEncoder, TextDecoder, navigator:{userAgent:'Chrome',bluetooth:{}}, location:{href:'file:///x'}, requestAnimationFrame:f=>setTimeout(f,16), HTMLCanvasElement:function(){return{width:300,height:150,getContext:()=>ctx2d}} };
ctx.document = { getElementById:id=>ELS[id]||(ELS[id]=mk(id)), querySelector:()=>mk('q'), querySelectorAll:()=>[], addEventListener(){}, body:{classList:{add(){},remove(){}}}, title:'' };
ctx.window = { addEventListener(){}, matchMedia:()=>({matches:false,addEventListener(){}}) };
ctx.localStorage = { getItem:()=>null, setItem(){}, removeItem(){} };
ctx.confirm = ()=>true; ctx.alert = ()=>{};
vm.createContext(ctx); vm.runInContext(script, ctx);
vm.runInContext(`
  LOGS=[]; logTo=(id,l)=>LOGS.push(l); globalThis.SENT=[];
  onDfuReceive=(rx,data,results)=>{const len=data[2]|(data[3]<<8);results.push(data.slice(4,4+len));};
  S.type='ble'; S.busy=false;
  const dev={name:'W96D_000123', gatt:{connected:true, disconnect(){ EV.push('disconnect'); ARMED=false; S.type='none'; cleanupBle(); }}};
  S.ble={device:dev,services:{},chars:{}};
  bleDiscover=async(d)=>{ S.type='ble'; S.ble.services={FEE0:1}; S.ble.chars={DFU_W:W,DFU_N:N}; EV.push('reconnect'); };
  ARMED=false; STAGE=false; EV=[]; listener=null;
  const W={ properties:{read:false,write:true,writeWithoutResponse:true},
    writeValueWithoutResponse:async b=>{ const f=new Uint8Array(b); const cmd=f[4]&0x7f; const plen=(f[2]|(f[3]<<8)); globalThis.SENT.push(cmd);
      let rep=null;
      if(cmd===0x0f){
        if(ARMED){ STAGE=true; ARMED=false; EV.push('8f-same-conn'); setTimeout(()=>{try{dev.gatt.disconnect();}catch(e){}},30); }
        else rep=[0x0a,0x7b,0x00,0x00,0x00];
      }
      else if(cmd===0x0a) rep=[0x04,0x0d];
      else if(cmd===0x05) rep=STAGE?[0x02]:[0x01];
      else if(cmd===0x04){ ARMED=true; rep=[0x02]; }
      else if(cmd===0x0c) rep=[0x05,0x00,0x10];
      else if(cmd===0x01) rep = plen===97 ? (STAGE?[0x02]:null) : [0x01];   // 裸 81→01；81+头96B→02（仅传输阶段）
      if(rep && listener){ const f2=new Uint8Array(5+rep.length); f2[0]=0x55; f2[2]=rep.length; f2.set(rep,4); listener({target:{value:new DataView(f2.buffer)}}); }
    },
    writeValueWithResponse:async b=>{ await W.writeValueWithoutResponse(b); } };
  const N={ properties:{notify:true}, addEventListener:(e,h)=>{listener=h;}, removeEventListener:()=>{listener=null;} };
  charOf=k=>k==='DFU_W'?W:N;
  const fakeBuf=new Uint8Array(81860); for(let i=0;i<96;i++) fakeBuf[i]=0x31;
  $('dfuProbeFile').files=[{name:'W96D_V13.up', arrayBuffer:async()=>fakeBuf.buffer}];
`, ctx);
(async () => {
  const ok = await vm.runInContext('dfuMimicUnlock()', ctx);
  const logs = vm.runInContext('LOGS', ctx), ev = vm.runInContext('EV', ctx);
  logs.forEach(l => console.log('  ' + l));
  console.log('\n命令序列:', vm.runInContext('globalThis.SENT.map(x=>"0x"+x.toString(16)).join(" ")', ctx));
  console.log('事件顺序:', ev.join(' → '));
  const a = ev.indexOf('8f-same-conn') >= 0 && ev.indexOf('8f-same-conn') < ev.indexOf('disconnect');
  console.log(`\n断言① 0x8F 在断链前(同连接)发出: ${a ? '✓' : '✗ 失败'}`);
  console.log(`断言② 解锁被确认(02 未被 expect 丢弃): ${ok ? '✓' : '✗ 失败'}`);
  process.exit(a && ok ? 0 : 1);
})();
