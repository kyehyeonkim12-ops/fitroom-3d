// 옷 사진에서 배경을 걸러내고 대표색과 무늬 영역을 뽑는다.
import * as THREE from 'three';

const MAX_STORE = 640;   // 저장용 사진 최대 변 길이(px)
const MAX_ANALYZE = 220; // 분석용

export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, MAX_STORE / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다')); };
    img.src = url;
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다'));
    img.src = src;
  });
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 결과: { bg, color: [r,g,b], bbox: {x,y,w,h} (0..1), crop: {cx, cy, size} (0..1, size는 bbox 너비 대비) }
export function analyze(img, category) {
  const k = Math.min(1, MAX_ANALYZE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const px = (x, y) => { const o = (y * w + x) * 4; return [data[o], data[o + 1], data[o + 2]]; };

  // 테두리 픽셀의 중앙값 = 배경색
  const border = [];
  for (let x = 0; x < w; x += 2) { border.push(px(x, 0), px(x, h - 1)); }
  for (let y = 0; y < h; y += 2) { border.push(px(0, y), px(w - 1, y)); }
  const med = (i) => border.map((p) => p[i]).sort((a, b) => a - b)[border.length >> 1];
  const bg = [med(0), med(1), med(2)];

  let mask = new Uint8Array(w * h), count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (dist(px(x, y), bg) > 42) { mask[y * w + x] = 1; count++; }
  }
  // 옷이 사진을 거의 다 채운 경우(원단 클로즈업)는 전체를 옷으로 본다
  if (count < w * h * 0.04) { mask.fill(1); count = w * h; }

  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  const samples = [];
  const step = Math.max(1, Math.floor(Math.sqrt(count / 3000)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if ((x % step === 0) && (y % step === 0)) samples.push(px(x, y));
  }
  const color = dominant(samples);
  const bbox = { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h };
  // 무늬 기본 영역: 상의는 가슴 가운데, 하의는 한쪽 허벅지
  const crop = category === 'bottom'
    ? { cx: bbox.x + bbox.w * 0.3, cy: bbox.y + bbox.h * 0.3, size: 0.25 }
    : { cx: bbox.x + bbox.w * 0.5, cy: bbox.y + bbox.h * 0.45, size: 0.3 };
  const patterned = variance(img, crop, bbox) > 16;
  return { bg, color, bbox, crop, patterned };
}

// 간단한 k-평균으로 가장 큰 색 묶음
function dominant(samples) {
  if (!samples.length) return [128, 128, 128];
  let cent = [samples[0], samples[Math.floor(samples.length / 3)], samples[Math.floor((samples.length * 2) / 3)], samples[samples.length - 1]].map((p) => p.slice());
  let assign = new Array(samples.length).fill(0);
  for (let it = 0; it < 8; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    samples.forEach((p, i) => {
      let best = 0, bd = Infinity;
      cent.forEach((c, k) => { const d = dist(p, c); if (d < bd) { bd = d; best = k; } });
      assign[i] = best;
      const s = sum[best]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    });
    cent = sum.map((s, k) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cent[k]));
  }
  const counts = cent.map(() => 0);
  assign.forEach((k) => counts[k]++);
  const best = counts.indexOf(Math.max(...counts));
  return cent[best].map(Math.round);
}

function cropRectPx(img, crop, bbox) {
  const side = crop.size * bbox.w * img.width;
  return { x: crop.cx * img.width - side / 2, y: crop.cy * img.height - side / 2, s: side };
}

function variance(img, crop, bbox) {
  const r = cropRectPx(img, crop, bbox);
  const n = 32;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, r.x, r.y, r.s, r.s, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  // 채널별 표준편차의 합: 밝기가 비슷한 색 줄무늬도 잡는다
  let total = 0;
  for (let ch = 0; ch < 3; ch++) {
    let s = 0, s2 = 0;
    for (let i = ch; i < d.length; i += 4) { s += d[i]; s2 += d[i] * d[i]; }
    const m = s / (n * n);
    total += Math.sqrt(Math.max(0, s2 / (n * n) - m * m));
  }
  return total / 3;
}

export function patternTexture(img, crop, bbox) {
  const r = cropRectPx(img, crop, bbox);
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  c.getContext('2d').drawImage(img, r.x, r.y, r.s, r.s, 0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function cropPreview(canvas, img, crop, bbox) {
  const ctx = canvas.getContext('2d');
  const k = Math.min(canvas.width / img.width, canvas.height / img.height);
  const w = img.width * k, h = img.height * k, ox = (canvas.width - w) / 2, oy = (canvas.height - h) / 2;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, ox, oy, w, h);
  const r = cropRectPx(img, crop, bbox);
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.strokeRect(ox + r.x * k, oy + r.y * k, r.s * k, r.s * k);
  ctx.strokeStyle = '#d39a12';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(ox + r.x * k, oy + r.y * k, r.s * k, r.s * k);
  ctx.restore();
  return { ox, oy, k };
}

// 무늬 한 칸의 실제 크기(cm) 기본값: 사진 속 옷 너비를 실측 단면에 대응시킨다
export function defaultTileCm(category, values, crop) {
  const flat = category === 'bottom' ? Number(values.hip) * 1.05 : Number(values.chest) * 1.55;
  const cm = (Number.isFinite(flat) ? flat : 50) * crop.size;
  return Math.round(Math.min(60, Math.max(3, cm)));
}

export const rgbHex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
