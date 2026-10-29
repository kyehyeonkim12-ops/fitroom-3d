// 이음새 없는 마네킹 표면.
// 몸통(측정 단면), 팔다리(굵기가 변하는 캡슐), 머리·가슴·종아리·손·발(타원체 등)을 거리장(SDF)으로 만들고
// 관절 부위를 부드럽게 녹여 붙인 뒤(smooth min), 격자에서 표면을 뽑아(Surface Nets) 한 덩어리 메시로 만든다.
import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const FAR = 1e3;

// 상자 바깥 점에서 상자까지 거리 (멀리 있는 부위는 정확한 계산 대신 이 값으로)
function boxDist(b, x, y, z) {
  const dx = Math.max(b[0] - x, 0, x - b[3]), dy = Math.max(b[1] - y, 0, y - b[4]), dz = Math.max(b[2] - z, 0, z - b[5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function smin(a, b, k) {
  if (k <= 1e-3) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

// ── 기본 도형 ──

// 두 끝 반지름이 다른 캡슐 (Inigo Quilez round cone). scale: 점 a 기준 축별 늘임
export class Cone {
  constructor(a, b, r1, r2, scale = null) {
    this.ax = a.x; this.ay = a.y; this.az = a.z;
    this.bx = b.x - a.x; this.by = b.y - a.y; this.bz = b.z - a.z;
    this.r1 = r1; this.r2 = r2;
    this.l2 = this.bx * this.bx + this.by * this.by + this.bz * this.bz;
    this.rr = r1 - r2;
    this.a2 = this.l2 - this.rr * this.rr;
    this.il2 = 1 / this.l2;
    this.s = scale ? [scale[0], scale[1], scale[2]] : null;
    this.smin = scale ? Math.min(...scale) : 1;
    const sx = scale ? scale[0] : 1, sy = scale ? scale[1] : 1, sz = scale ? scale[2] : 1;
    const R = Math.max(r1, r2);
    this.box = [
      Math.min(a.x, b.x) - R * sx, Math.min(a.y, b.y) - R * sy, Math.min(a.z, b.z) - R * sz,
      Math.max(a.x, b.x) + R * sx, Math.max(a.y, b.y) + R * sy, Math.max(a.z, b.z) + R * sz,
    ];
    if (scale) {
      // 늘인 공간에서 b의 위치도 a 기준으로 늘어난다
      const bx = a.x + this.bx * sx, by = a.y + this.by * sy, bz = a.z + this.bz * sz;
      this.box = [
        Math.min(a.x, bx) - R * sx, Math.min(a.y, by) - R * sy, Math.min(a.z, bz) - R * sz,
        Math.max(a.x, bx) + R * sx, Math.max(a.y, by) + R * sy, Math.max(a.z, bz) + R * sz,
      ];
    }
  }

  dist(px, py, pz) {
    let x = px - this.ax, y0 = py - this.ay, z0 = pz - this.az;
    if (this.s) { x /= this.s[0]; y0 /= this.s[1]; z0 /= this.s[2]; }
    const { bx, by, bz, l2, rr, a2, il2 } = this;
    const y = x * bx + y0 * by + z0 * bz;
    const z = y - l2;
    const qx = x * l2 - bx * y, qy = y0 * l2 - by * y, qz = z0 * l2 - bz * y;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = y * y * l2, z2 = z * z * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    let d;
    if (Math.sign(z) * a2 * z2 > k) d = Math.sqrt(x2 + z2) * il2 - this.r2;
    else if (Math.sign(y) * a2 * y2 < k) d = Math.sqrt(x2 + y2) * il2 - this.r1;
    else d = (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - this.r1;
    return d * this.smin;
  }
}

export class Ellipsoid {
  constructor(c, r) {
    this.cx = c.x; this.cy = c.y; this.cz = c.z;
    this.rx = r[0]; this.ry = r[1]; this.rz = r[2];
    this.box = [c.x - r[0], c.y - r[1], c.z - r[2], c.x + r[0], c.y + r[1], c.z + r[2]];
  }

  dist(px, py, pz) {
    const x = px - this.cx, y = py - this.cy, z = pz - this.cz;
    const ax = x / this.rx, ay = y / this.ry, az = z / this.rz;
    const bx = ax / this.rx, by = ay / this.ry, bz = az / this.rz;
    const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
    const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(this.rx, this.ry, this.rz);
  }
}

// 여러 도형을 부드럽게 합친 묶음
export class Group {
  constructor(prims, k, margin = 7) {
    this.prims = prims;
    this.k = k;
    this.margin = margin;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const p of prims) for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], p.box[i]); b[i + 3] = Math.max(b[i + 3], p.box[i + 3]); }
    this.box = b;
    // 도형이 많으면 높이(y)별 칸으로 나눠 근처 도형만 본다
    this.buckets = null;
    if (prims.length > 8) {
      this.bh = 3;
      const nb = Math.max(1, Math.ceil((b[4] - b[1] + 2 * margin) / this.bh));
      this.buckets = Array.from({ length: nb }, () => []);
      for (const p of prims) {
        const i0 = Math.floor((p.box[1] - margin - (b[1] - margin)) / this.bh);
        const i1 = Math.floor((p.box[4] + margin - (b[1] - margin)) / this.bh);
        for (let i = Math.max(0, i0); i <= Math.min(nb - 1, i1); i++) this.buckets[i].push(p);
      }
    }
  }

  dist(x, y, z) {
    const m = this.margin;
    let d = FAR, far = FAR;
    let list = this.prims;
    if (this.buckets) {
      const i = Math.floor((y - (this.box[1] - m)) / this.bh);
      if (i < 0 || i >= this.buckets.length) return boxDist(this.box, x, y, z);
      list = this.buckets[i];
      if (!list.length) return Math.max(m, boxDist(this.box, x, y, z));
    }
    for (const p of list) {
      const b = p.box;
      if (x < b[0] - m || y < b[1] - m || z < b[2] - m || x > b[3] + m || y > b[4] + m || z > b[5] + m) {
        far = Math.min(far, boxDist(b, x, y, z));
        continue;
      }
      d = smin(d, p.dist(x, y, z), this.k);
    }
    return Math.min(d, far);
  }
}

// 마디(중심, 반지름)를 스플라인으로 촘촘히 보간해 작은 캡슐들로 잇는다 (관절마다 볼록해지지 않게)
export function splineTube(nodes, spacing = 1.2) {
  const cr = (a, b, c, d, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  };
  const n = nodes.length;
  const g = (i) => nodes[clamp(i, 0, n - 1)];
  const pts = [];
  for (let i = 0; i < n - 1; i++) {
    const steps = Math.max(1, Math.ceil(nodes[i].p.distanceTo(nodes[i + 1].p) / spacing));
    for (let k = 0; k < steps + (i === n - 2 ? 1 : 0); k++) {
      const t = k / steps, a = g(i - 1), b = g(i), c = g(i + 1), d = g(i + 2);
      pts.push({
        p: new THREE.Vector3(cr(a.p.x, b.p.x, c.p.x, d.p.x, t), cr(a.p.y, b.p.y, c.p.y, d.p.y, t), cr(a.p.z, b.p.z, c.p.z, d.p.z, t)),
        r: Math.max(0.3, cr(a.r, b.r, c.r, d.r, t)),
      });
    }
  }
  const prims = [];
  for (let i = 0; i < pts.length - 1; i++) prims.push(new Cone(pts[i].p, pts[i + 1].p, pts[i].r, pts[i + 1].r));
  return new Group(prims, 0, 7);
}

const smax = (a, b, k) => -smin(-a, -b, k);

// ── 몸통: 측정 단면을 높이별 극좌표 반지름 표로 바꿔 거리 계산 ──

export class TorsoField {
  constructor(sample, y0, y1, dy = 0.5, NA = 96) {
    this.y0 = y0; this.y1 = y1; this.dy = dy; this.NA = NA;
    const ns = Math.ceil((y1 - y0) / dy) + 1;
    this.ns = ns;
    this.R = new Float32Array(ns * NA);
    this.S = new Float32Array(ns * NA);
    this.ZC = new Float32Array(ns);
    let maxR = 0;
    for (let s = 0; s < ns; s++) {
      const y = Math.min(y1, y0 + s * dy);
      const { zc, pts } = sample(y);
      this.ZC[s] = zc;
      const polar = pts.map(([x, z]) => [Math.atan2(z, x), Math.hypot(x, z)]).sort((a, b) => a[0] - b[0]);
      const n = polar.length;
      for (let a = 0; a < NA; a++) {
        const ang = -Math.PI + (a / NA) * Math.PI * 2;
        let i = 0;
        while (i < n && polar[i][0] < ang) i++;
        const p0 = i === 0 ? [polar[n - 1][0] - Math.PI * 2, polar[n - 1][1]] : polar[i - 1];
        const p1 = i === n ? [polar[0][0] + Math.PI * 2, polar[0][1]] : polar[i];
        const t = (ang - p0[0]) / (p1[0] - p0[0] || 1);
        const r = p0[1] + (p1[1] - p0[1]) * t;
        this.R[s * NA + a] = r;
        maxR = Math.max(maxR, r);
      }
    }
    for (let s = 0; s < ns; s++) {
      const s0 = Math.max(0, s - 1), s1 = Math.min(ns - 1, s + 1);
      for (let a = 0; a < NA; a++) this.S[s * NA + a] = (this.R[s1 * NA + a] - this.R[s0 * NA + a]) / ((s1 - s0) * dy || 1);
    }
    let zmin = Infinity, zmax = -Infinity;
    for (const z of this.ZC) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); }
    this.box = [-maxR, y0, zmin - maxR, maxR, y1, zmax + maxR];
  }

  dist(x, y, z) {
    const { y0, y1, dy, NA, R, S, ZC } = this;
    const fs = (clamp(y, y0, y1) - y0) / dy;
    const s0 = Math.min(this.ns - 2, Math.floor(fs)), t = fs - s0;
    const zc = ZC[s0] + (ZC[s0 + 1] - ZC[s0]) * t;
    const dz = z - zc;
    const fa = ((Math.atan2(dz, x) + Math.PI) / (Math.PI * 2)) * NA;
    const a0 = Math.floor(fa) % NA, a1 = (a0 + 1) % NA, ta = fa - Math.floor(fa);
    const i0 = s0 * NA, i1 = (s0 + 1) * NA;
    const r = (R[i0 + a0] * (1 - ta) + R[i0 + a1] * ta) * (1 - t) + (R[i1 + a0] * (1 - ta) + R[i1 + a1] * ta) * t;
    const sl = (S[i0 + a0] * (1 - ta) + S[i0 + a1] * ta) * (1 - t) + (S[i1 + a0] * (1 - ta) + S[i1 + a1] * ta) * t;
    // 단면 범위 밖은 마지막 기울기대로 이어 붙여 기울기가 꺾이지 않게
    const ext = y < y0 ? y - y0 : y > y1 ? y - y1 : 0;
    const re = Math.max(0.2, r + sl * ext);
    const side = (Math.sqrt(x * x + dz * dz) - re) / Math.sqrt(1 + sl * sl);
    // 아래 끝(가랑이)은 둥글게 깎아 다리와 자연스럽게 이어지게
    return smax(smax(side, y0 - y, 9), y - y1, 2);
  }
}

// ── 전체 몸 거리장 ──
// parts: { torso, neckHead, arms: [Group], legs: [Group], extras: [{ group, k }] , yChest, yCrotch }
export function bodyField(parts) {
  const { torso, neckHead, arms, legs, extras, yChest, yCrotch } = parts;
  const m = 7; // 가장 큰 녹임 폭보다 넓어야 이음선이 안 생긴다
  const inBox = (b, x, y, z) => !(x < b[0] - m || y < b[1] - m || z < b[2] - m || x > b[3] + m || y > b[4] + m || z > b[5] + m);
  return (x, y, z) => {
    let d = inBox(torso.box, x, y, z) ? torso.dist(x, y, z) : boxDist(torso.box, x, y, z);
    for (const e of extras) if (inBox(e.group.box, x, y, z)) d = smin(d, e.group.dist(x, y, z), e.k);
    d = Math.min(d, inBox(neckHead.box, x, y, z) ? Infinity : boxDist(neckHead.box, x, y, z));
    if (inBox(neckHead.box, x, y, z)) d = smin(d, neckHead.dist(x, y, z), 3);
    // 팔은 겨드랑이에서만 녹여 붙이고, 아래쪽은 몸과 닿아도 붙지 않게
    const kArm = 3.5 * smoothstep(yChest - 8, yChest + 3, y);
    for (const a of arms) d = inBox(a.box, x, y, z) ? smin(d, a.dist(x, y, z), kArm) : Math.min(d, boxDist(a.box, x, y, z));
    let dl = FAR;
    for (const l of legs) dl = inBox(l.box, x, y, z) ? smin(dl, l.dist(x, y, z), 0.6) : Math.min(dl, boxDist(l.box, x, y, z));
    const kLeg = 3 * smoothstep(yCrotch - 14, yCrotch, y);
    return smin(d, dl, kLeg);
  };
}

// ── Surface Nets: 격자 거리값 → 표면 메시 ──
export function meshField(field, box, step) {
  const [x0, y0, z0] = [box[0] - step, box[1] - step, box[2] - step];
  const nx = Math.ceil((box[3] - box[0]) / step) + 3;
  const ny = Math.ceil((box[4] - box[1]) / step) + 3;
  const nz = Math.ceil((box[5] - box[2]) / step) + 3;
  const F = new Float32Array(nx * ny * nz);
  const idx = (i, j, k) => i + nx * (j + ny * k);

  // 거친 격자로 먼저 재고, 표면 근처만 촘촘히 계산
  const C = 3, cs = step * C;
  const cnx = Math.ceil(nx / C) + 1, cny = Math.ceil(ny / C) + 1, cnz = Math.ceil(nz / C) + 1;
  const CF = new Float32Array(cnx * cny * cnz);
  for (let k = 0; k < cnz; k++) for (let j = 0; j < cny; j++) for (let i = 0; i < cnx; i++) {
    CF[i + cnx * (j + cny * k)] = field(x0 + i * cs, y0 + j * cs, z0 + k * cs);
  }
  const near = cs * 2.2;
  for (let k = 0; k < nz; k++) {
    const ck = Math.min(cnz - 2, Math.floor(k / C)), tk = k / C - ck;
    for (let j = 0; j < ny; j++) {
      const cj = Math.min(cny - 2, Math.floor(j / C)), tj = j / C - cj;
      for (let i = 0; i < nx; i++) {
        const ci = Math.min(cnx - 2, Math.floor(i / C)), ti = i / C - ci;
        const c = (a, b, e) => CF[(ci + a) + cnx * ((cj + b) + cny * (ck + e))];
        const v = ((c(0, 0, 0) * (1 - ti) + c(1, 0, 0) * ti) * (1 - tj) + (c(0, 1, 0) * (1 - ti) + c(1, 1, 0) * ti) * tj) * (1 - tk)
          + ((c(0, 0, 1) * (1 - ti) + c(1, 0, 1) * ti) * (1 - tj) + (c(0, 1, 1) * (1 - ti) + c(1, 1, 1) * ti) * tj) * tk;
        F[idx(i, j, k)] = Math.abs(v) > near ? v : field(x0 + i * step, y0 + j * step, z0 + k * step);
      }
    }
  }

  // 셀마다 꼭짓점 하나 (표면이 지나는 셀만)
  const cellV = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cidx = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const pos = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const [a, b, e] = corner[c];
      val[c] = F[idx(i + a, j + b, k + e)];
      if (val[c] < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [e0, e1] of edges) {
      const v0 = val[e0], v1 = val[e1];
      if ((v0 < 0) === (v1 < 0)) continue;
      const t = v0 / (v0 - v1);
      const c0 = corner[e0], c1 = corner[e1];
      sx += c0[0] + (c1[0] - c0[0]) * t;
      sy += c0[1] + (c1[1] - c0[1]) * t;
      sz += c0[2] + (c1[2] - c0[2]) * t;
      n++;
    }
    cellV[cidx(i, j, k)] = pos.length / 3;
    pos.push(x0 + (i + sx / n) * step, y0 + (j + sy / n) * step, z0 + (k + sz / n) * step);
  }

  // 부호가 바뀌는 격자 모서리마다 주변 4셀 꼭짓점으로 사각형
  const index = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c); else index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v = F[idx(i, j, k)];
    const inside = v < 0;
    if (inside !== (F[idx(i + 1, j, k)] < 0)) quad(cellV[cidx(i, j - 1, k - 1)], cellV[cidx(i, j, k - 1)], cellV[cidx(i, j, k)], cellV[cidx(i, j - 1, k)], !inside);
    if (inside !== (F[idx(i, j + 1, k)] < 0)) quad(cellV[cidx(i - 1, j, k - 1)], cellV[cidx(i - 1, j, k)], cellV[cidx(i, j, k)], cellV[cidx(i, j, k - 1)], !inside);
    if (inside !== (F[idx(i, j, k + 1)] < 0)) quad(cellV[cidx(i - 1, j - 1, k)], cellV[cidx(i, j - 1, k)], cellV[cidx(i, j, k)], cellV[cidx(i - 1, j, k)], !inside);
  }

  // 표면 위로 한 번 끌어당기고, 법선은 거리장의 기울기로
  const nrm = new Float32Array(pos.length);
  const e = step * 0.35;
  for (let p = 0; p < pos.length; p += 3) {
    let x = pos[p], y = pos[p + 1], z = pos[p + 2];
    let gx = field(x + e, y, z) - field(x - e, y, z);
    let gy = field(x, y + e, z) - field(x, y - e, z);
    let gz = field(x, y, z + e) - field(x, y, z - e);
    let l = Math.hypot(gx, gy, gz) || 1;
    gx /= l; gy /= l; gz /= l;
    const d = clamp(field(x, y, z), -step, step);
    x -= gx * d; y -= gy * d; z -= gz * d;
    pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
    nrm[p] = gx; nrm[p + 1] = gy; nrm[p + 2] = gz;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(index);
  return g;
}
