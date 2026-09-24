// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 冒烟测试：OTA 摘除后工具仍能正常初始化、控制页可用、无悬空引用
const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(path.join(ROOT, 'W96D统一控制台.html'),'utf8');
const script=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const ELS={};
const ctx2d={clearRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillRect(){},drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(4)}),putImageData(){},fillText(){},save(){},restore(){},setLineDash(){},measureText:()=>({width:0})};
const mk=id=>({id,textContent:'',value:'',checked:false,disabled:false,style:{},innerHTML:'',scrollTop:0,addEventListener(){},classList:{add(){},remove(){},contains:()=>false},querySelector(){return null},querySelectorAll(){return[]},dataset:{},width:300,height:150,getContext:()=>ctx2d,getBoundingClientRect:()=>({left:0,top:0,width:300,height:150})});
const errs=[];
const ctx={console:{log(){},warn(){},error:(...a)=>errs.push(a.join(' '))},setTimeout,clearTimeout,setInterval,clearInterval,Date,Uint8Array,Int32Array,Float32Array,TextEncoder,TextDecoder,Math,JSON,Number,parseInt,parseFloat,isNaN,
 navigator:{userAgent:'Mozilla/5.0 (Windows NT 10.0) Chrome/120',bluetooth:{},usb:undefined,clipboard:{writeText:async()=>{}}},
 location:{href:'file:///x.html'},requestAnimationFrame:f=>setTimeout(f,16),
 HTMLCanvasElement:function(){return{width:300,height:150,getContext:()=>ctx2d}}};
ctx.document={getElementById:id=>ELS[id]||(ELS[id]=mk(id)),querySelector:()=>mk('q'),querySelectorAll:()=>[],addEventListener(){},body:{classList:{add(){},remove(){}}},title:''};
ctx.window={addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}})};
ctx.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
ctx.confirm=()=>true; ctx.alert=()=>{};
vm.createContext(ctx);
let loadErr=null;
try { vm.runInContext(script,ctx); } catch(e){ loadErr=e.message; }
console.log('脚本执行:', loadErr ? '❌ '+loadErr : '✓ 无异常');
// 关键函数是否都还在（协议核心 + 控制 + 设备信息读取）
const need=['dfuPack','calcCrc8','onDfuReceive','makeRx','dfuRequest','readDeviceInfo','bleSnRead','bleDiscover','charOf','writeBytes','bleSetGear','blePushSpeed','setConnUI'];
const missing=need.filter(n=>{ try { return typeof vm.runInContext(n,ctx)!=='function'; } catch(e){ return true; } });
console.log("关键函数:", missing.length? '❌ 缺失 '+missing.join(','): '✓ 全部存在');
// OTA 已于 2026-09-25 按抓包流程重新加入：核心入口必须存在（旧版遗留的探测函数不应再有）
const otaNeed=['otaRun','otaEnterTransferStage','otaParseFile','otaUI'];
const otaMissing=otaNeed.filter(n=>{ try { return typeof vm.runInContext(n,ctx)!=='function'; } catch(e){ return true; } });
const otaGone=['otaBind','otaHandshakeUnlock','dfuProbeFrame','enterOtaUi','exitOtaUi','dfuMimicUnlock','dfuReadProbe','dfuFrameLimit'];
const otaStill=otaGone.filter(n=>{ try { return typeof vm.runInContext(n,ctx)==='function'; } catch(e){ return false; } });
console.log('OTA 函数:', (otaMissing.length? '❌ 缺 '+otaMissing.join(','): '✓ otaRun/otaEnterTransferStage/otaParseFile/otaUI 齐备') + (otaStill.length? '｜❌ 旧遗留: '+otaStill.join(','): ''));
console.log('console.error 次数:', errs.length, errs.slice(0,2).join(' | '));
