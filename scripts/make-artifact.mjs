// index.html → dist/artifact/index.html
// 공유 페이지는 문서 뼈대(doctype/head/body)와 charset·viewport 메타를 자동으로 붙이므로 그 부분만 걷어낸다.
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const out = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*|<\/html>\s*/gi, '')
  .replace(/<\/?head>\s*|<\/?body>\s*/gi, '')
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .replace(/<link rel="manifest"[^>]*>\s*/i, '');
mkdirSync('dist/artifact', { recursive: true });
writeFileSync('dist/artifact/index.html', out);
cpSync('src', 'dist/artifact/src', { recursive: true });
console.log('dist/artifact ready');
