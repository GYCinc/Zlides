import fs from 'node:fs';

const raw = fs.readFileSync(import.meta.dir + '/src/lib/sse/fixtures/escaped-answer-sample.txt', 'utf8');
console.log('fixture head bytes:', JSON.stringify(raw.slice(0, 120)));
console.log('fixture tail bytes:', JSON.stringify(raw.slice(-120)));
console.log('lastIndexOf </html>:', raw.toLowerCase().lastIndexOf('</html>'));
console.log('docStart:', (() => { const m = raw.match(/<!DOCTYPE|<html[\s>]/i); return m && m.index !== undefined ? m.index : -1; })());
console.log('contains literal backslash-n:', raw.includes('\\n'));

// Step through the decoder manually
let candidate = raw.trim();
const start = (() => { const m = candidate.match(/<!DOCTYPE|<html[\s>]/i); return m && m.index !== undefined ? m.index : -1; })();
const end = candidate.toLowerCase().lastIndexOf('</html>');
console.log('span:', start, '..', end, 'span end char:', JSON.stringify(candidate.slice(end, end + 10)));
if (start >= 0 && end > start) candidate = candidate.slice(start, end + '</html>'.length);
console.log('span head:', JSON.stringify(candidate.slice(0, 80)));
console.log('span tail:', JSON.stringify(candidate.slice(-80)));

// Try the JSON.parse path
try {
  const decoded = JSON.parse('"' + candidate + '"');
  console.log('JSON.parse OK, decoded head:', JSON.stringify(decoded.slice(0, 80)));
} catch (e) {
  console.log('JSON.parse failed:', e.message.slice(0, 120));
  const manual = candidate.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\"/g, '"');
  console.log('manual decode head:', JSON.stringify(manual.slice ? '' : '') + JSON.stringify(manualDecode(candidate)));
  function manualDecode(s) { return s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
  const d2 = manualDecode(candidate);
  console.log('manual head:', JSON.stringify(d2.slice(0, 80)));
  console.log('manual has structure:', d2.toLowerCase().includes('<body'));
}
