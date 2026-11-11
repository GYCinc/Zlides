import { rescueDocumentFromAnswer } from './src/lib/sse/rescue';
import fs from 'node:fs';

const FILE = '/home/hayron/Zlides22/Zlides/saved_slides/slide_20260918043526_Spices__Cempasuchil_and_the_Ma.html';
const broken = fs.readFileSync(FILE, 'utf8');
const fixed = rescueDocumentFromAnswer(broken);
if (!fixed) { console.error('decoder returned null — refusing to touch the file'); process.exit(1); }
fs.writeFileSync(FILE, fixed);
console.log('before:', broken.length, 'bytes, literal \\n sequences:', (broken.match(/\\n/g) || []).length);
console.log('after: ', fixed.length, 'bytes, literal \\n sequences:', (fixed.match(/\\n/g) || []).length);
console.log('escaped quotes left:', (fixed.match(/\\"/g) || []).length);
console.log('head:', JSON.stringify(fixed.slice(0, 140)));
