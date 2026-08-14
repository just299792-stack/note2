/* =========================================================
   手记 —— 极简 PDF 生成器（零依赖）
   将页面画布以 JPEG 嵌入 PDF，页面尺寸与逻辑页同比例。
   ========================================================= */

function bytesToString(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

/** canvases: 每个页面的 <canvas>（已渲染好内容） */
export function canvasesToPdf(canvases, opts = {}) {
  void opts;
  const objects = [];   // 对象数组，index+1 即对象编号
  const pageRefs = [];

  const pageData = canvases.map((cv) => {
    let width = cv.width, height = cv.height;
    const MAX = 4096;
    if (width > MAX || height > MAX) {
      const k = Math.min(MAX / width, MAX / height);
      const t = document.createElement('canvas');
      t.width = Math.round(width * k); t.height = Math.round(height * k);
      t.getContext('2d').drawImage(cv, 0, 0, t.width, t.height);
      cv = t; width = t.width; height = t.height;
    }
    const bytes = b64ToBytes(cv.toDataURL('image/jpeg', 0.88).split(',')[1]);
    return { width, height, bytes };
  });

  const pdfW = 612, pdfH = 792;
  pageData.forEach((pd, i) => {
    objects.push(`<< /Type /XObject /Subtype /Image /Width ${pd.width} /Height ${pd.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pd.bytes.length} >>\nstream\n`);
    const imgRef = objects.length;
    objects.push(pd.bytes);
    objects.push('endstream');

    const content = `q\n${pd.width} 0 0 ${pd.height} 0 0 cm\n/Im${i} Do\nQ`;
    const contentBytes = new TextEncoder().encode(content);
    objects.push(`<< /Length ${contentBytes.length} >>\nstream\n`);
    const contentRef = objects.length;
    objects.push(contentBytes);
    objects.push('endstream');

    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfW} ${pdfH}] /Resources << /XObject << /Im${i} ${imgRef} 0 R >> >> /Contents ${contentRef} 0 R >>`);
    pageRefs.push(objects.length);
  });

  // Pages 对象 (2)
  objects.push(`<< /Type /Pages /Kids [${pageRefs.map(r => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
  const pagesRef = objects.length;

  // Catalog (1)
  objects.push(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);

  // 组装
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n`;
    const obj = objects[i];
    out += typeof obj === 'string' ? obj + '\n' : bytesToString(obj) + '\n';
    out += 'endobj\n';
  }

  const xrefPos = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return new Blob([out], { type: 'application/pdf' });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
