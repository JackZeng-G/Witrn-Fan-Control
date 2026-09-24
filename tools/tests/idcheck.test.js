// 仓库内路径（用脚本自身位置推导，不再依赖绝对路径）
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
// 校验 JS 里引用的元素 id 都存在于 HTML（防摘除后留下悬空引用）
const fs=require('fs');
const h=fs.readFileSync(path.join(ROOT, 'W96D统一控制台.html'),'utf8');
const htmlIds=new Set([...h.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
const jsRefs=new Set([...h.matchAll(/\$\('([^']+)'\)/g)].map(m=>m[1]));
const dyn=/^(logToggle|usbLog|telLogToggle)$/;
const missing=[...jsRefs].filter(x=>!htmlIds.has(x)&&!dyn.test(x));
console.log('HTML 元素 id 数:', htmlIds.size, '｜JS 引用 id 数:', jsRefs.size);
console.log(missing.length? '❌ 悬空引用: '+missing.join(', ') : '✓ 无悬空引用');
