/* 合成 .up 固件（不包含任何厂商字节，仅用于 OTA 流程测试）。
 * 结构照真实 .up：96B 明文头 + 固件体；头里放型号 `W96D001`（@0x21）与版本字节（@0x4D），
 * 体长度写成 hex 放在 @0x32（工具只读这三处）。因仓库不再附带官方固件，测试改用本函数生成。
 */
function makeFw(size = 81860, model = 'W96D001', ver = 0x0d) {
  const hdr = 96, body = size - hdr;
  const b = Buffer.alloc(size);
  const ascii = (s, off) => { for (let i = 0; i < s.length; i++) b[off + i] = s.charCodeAt(i) & 0xff; };
  ascii('0123456789abcdef0123456789abcdef', 0);              // 32 字符校验串占位
  ascii(model, 0x21);                                        // 型号（工具据此校验适配性）
  ascii(body.toString(16).toUpperCase().padStart(8, '0'), 0x32); // 体长度 hex
  b[0x4d] = ver;                                             // 版本字节
  // 体：确定性伪随机，保证"逐块拼接与体逐字节一致"这类断言有意义
  let x = 0x12345678;
  for (let i = hdr; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = (x >>> 16) & 0xff; }
  return b;
}
module.exports = { makeFw };
