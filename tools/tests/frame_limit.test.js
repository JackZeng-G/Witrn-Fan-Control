// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 用 mock 设备（≤20B 应答、>20B 静默）验证边界测试能否正确报出 20B
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(path.join(ROOT, 'W96D统一控制台.html'),'utf8');
const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const ELS={};
const ctx2d={clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){}};
const mk=id=>({id,textContent:'',value:'',checked:false,disabled:false,style:{},innerHTML:'',scrollTop:0,files:[],addEventListener(){},classList:{add(){},remove(){},contains:()=>false},querySelector(){return null},querySelectorAll(){return[]},dataset:{},width:300,height:150,getContext:()=>ctx2d,getBoundingClientRect:()=>({left:0,top:0,width:300,height:150})});
const ctx={console,setTimeout,clearTimeout,setInterval,clearInterval,Date,Uint8Array,TextEncoder,TextDecoder,navigator:{userAgent:'Chrome',bluetooth:{}},location:{href:'file:///x'},requestAnimationFrame:f=>setTimeout(f,16),HTMLCanvasElement:function(){return{width:300,height:150,getContext:()=>ctx2d}}};
ctx.document={getElementById:id=>ELS[id]||(ELS[id]=mk(id)),querySelector:()=>mk('q'),querySelectorAll:()=>[],addEventListener(){},body:{classList:{add(){},remove(){}}},title:''};
ctx.window={addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}})};
ctx.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
ctx.confirm=()=>false; ctx.alert=()=>{};
vm.createContext(ctx); vm.runInContext(script,ctx);
vm.runInContext(`
  LOGS=[]; logTo=(id,l)=>LOGS.push(l);
  onDfuReceive=(rx,data,results)=>{const len=data[2]|(data[3]<<8);results.push(data.slice(4,4+len));};
  S.type='ble'; S.busy=false; S.ble={device:{name:'W96D_000123'},services:{},chars:{}};
  listener=null;
  // 模拟设备：帧长 <= 20 才应答 04 0d（模拟"20B 写缓冲"）
  const w={ properties:{read:true,write:true},
    writeValueWithoutResponse:async b=>{ const f=new Uint8Array(b); if(f.length<=130 && listener){ const r=new Uint8Array([0x04,0x0d]); const f2=new Uint8Array(5+r.length); f2[0]=0x55; f2[2]=r.length; f2.set(r,4); listener({target:{value:new DataView(f2.buffer)}});} },
    writeValueWithResponse:async b=>{},
    readValue:async()=>{ throw new Error('GATT operation not permitted.'); } };
  const n={ properties:{notify:true}, addEventListener:(e,h)=>{listener=h;}, removeEventListener:()=>{listener=null;} };
  charOf=k=>k==='DFU_W'?w:n;
`,ctx);
(async()=>{
  await vm.runInContext('dfuFrameLimit()',ctx);
  const logs=vm.runInContext('LOGS',ctx);
  logs.filter(l=>/边界/.test(l)).slice(0,6).forEach(l=>console.log('  '+l));
  console.log('  ...');
  logs.filter(l=>/结论|明细/.test(l)).forEach(l=>console.log('  '+l));
})();
