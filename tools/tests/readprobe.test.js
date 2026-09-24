// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 用 mock 特征真跑一遍"读回测试"，确认两条通路都被记录
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(path.join(ROOT, 'W96D统一控制台.html'),'utf8');
const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const ELS={},LOGS=[],WRITES=[];
const ctx2d={clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){}};
const mk=id=>({id,textContent:'',value:'',checked:false,disabled:false,style:{},innerHTML:'',scrollTop:0,files:[],addEventListener(){},classList:{add(){},remove(){},contains:()=>false},querySelector(){return null},querySelectorAll(){return[]},dataset:{},width:300,height:150,getContext:()=>ctx2d,getBoundingClientRect:()=>({left:0,top:0,width:300,height:150})});
const ctx={console,setTimeout,clearTimeout,setInterval,clearInterval,Date,Uint8Array,TextEncoder,TextDecoder,navigator:{userAgent:'Chrome',bluetooth:{},clipboard:{writeText:async()=>{}}},location:{href:'file:///x'},requestAnimationFrame:f=>setTimeout(f,16),HTMLCanvasElement:function(){return{width:300,height:150,getContext:()=>ctx2d}}};
ctx.document={getElementById:id=>ELS[id]||(ELS[id]=mk(id)),querySelector:()=>mk('q'),querySelectorAll:()=>[],addEventListener(){},body:{classList:{add(){},remove(){}}},title:''};
ctx.window={addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}})};
ctx.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
ctx.confirm=()=>true; ctx.alert=()=>{};
vm.createContext(ctx); vm.runInContext(script,ctx);
// mock：通知回 04 0d；读回返回设备侧"最近一次应答"
vm.runInContext(`
  LOGS=[]; logTo=(id,l)=>LOGS.push(l);
  S.type='ble'; S.busy=false;
  S.ble={device:{name:'W96D_000123'},services:{},chars:{}};
  LAST=[0x04,0x0d];           // 设备侧"最后一次应答"，可读回
  listener=null;
  globalThis.__w={ properties:{read:true,write:true,writeWithoutResponse:true},
    writeValueWithoutResponse:async b=>{WRITES_UNUSED=1;},
    writeValueWithResponse:async b=>{},
    readValue:async()=>new DataView(new Uint8Array(LAST).buffer) };
  const n={ properties:{notify:true}, addEventListener:(e,h)=>{listener=h;}, removeEventListener:()=>{listener=null;} };
  charOf=k=>k==='DFU_W'?__w:n;
`,ctx);
// 让"通知"也发生：拦截写操作，模拟设备通知
vm.runInContext(`
  const ww=charOf('DFU_W');
  ww.writeValueWithoutResponse=async b=>{ if(listener){const f=new Uint8Array(LAST); listener({target:{value:new DataView(f.buffer)}});} };
  ww.writeValueWithResponse=async b=>{ if(listener){const f=new Uint8Array(LAST); listener({target:{value:new DataView(f.buffer)}});} };
`,ctx);
(async()=>{
  await vm.runInContext('dfuReadProbe()',ctx);
  vm.runInContext('LOGS',ctx).forEach(l=>console.log('  '+l));
  console.log('\n界面摘要:', (ELS['dfuReadProbeOut']||{}).textContent);
})();
