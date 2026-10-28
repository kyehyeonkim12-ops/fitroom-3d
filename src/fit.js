// 핏 판정 기준, 상태 이름, 핏 지도 색, 문장 도우미.
import * as THREE from 'three';

export const STATUS = {
  tight:     { label: '꽉 낌',      rank: 0 },
  snug:      { label: '딱 맞음',    rank: 1 },
  regular:   { label: '적당',       rank: 2 },
  loose:     { label: '여유',       rank: 3 },
  veryLoose: { label: '아주 넉넉',  rank: 4 },
};
const ORDER = ['tight', 'snug', 'regular', 'loose', 'veryLoose'];

// 둘레 여유(cm) 경계값: [꽉 낌|딱 맞음, 딱 맞음|적당, 적당|여유, 여유|아주 넉넉]
// 어깨만 둘레가 아니라 어깨너비 차이(cm)
const THRESHOLDS = {
  shoulder:   [-2, -0.5, 2.5, 6],
  chest:      [0, 4, 14, 24],
  topWaist:   [0, 4, 16, 28],
  topHem:     [0, 4, 16, 28],
  bicep:      [0, 3, 10, 18],
  pantsWaist: [-0.5, 2, 5, 9],
  hip:        [0, 3, 10, 18],
  thigh:      [0, 3, 10, 20],
  pantsHem:   [0, 4, 14, 26],
  rise:       [-0.5, 1, 5, 10],
};

export function classify(kind, value) {
  const t = THRESHOLDS[kind];
  let i = 0;
  while (i < t.length && value >= t[i]) i++;
  return ORDER[i];
}

// 소재 신축성: 늘어나는 비율
export const STRETCH = { none: 0, some: 0.04, high: 0.1 };

// 늘어나는 소재면 모자란 둘레 일부를 메워 준다
export function effective(ease, garmentCirc, stretch) {
  if (ease >= 0) return ease;
  return Math.min(0, ease + garmentCirc * stretch);
}

export const f = (n) => {
  const r = Math.round(Math.abs(n) * 2) / 2;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

// 기준선 중 가장 가까운 곳 기준으로 위치 설명. d>0 이면 기준선보다 위.
export function nearestLandmark(y, marks) {
  let best = marks[0];
  for (const m of marks) if (Math.abs(y - m.y) < Math.abs(y - best.y)) best = m;
  const d = y - best.y;
  if (Math.abs(d) < 1) return `${best.name}에 딱 맞음`;
  return `${best.name} ${d > 0 ? '위' : '아래'} ${f(d)}cm`;
}

// 핏 지도 색: 둘레 여유(cm) → 색. 빨강(낌) → 주황 → 중립 → 하늘 → 파랑(넉넉)
const STOPS = [
  [-6, '#c22a1f'], [0, '#e5533a'], [3, '#f3a25a'], [7, '#e4e6dc'], [15, '#8cbde9'], [26, '#2c64c9'],
].map(([e, c]) => [e, new THREE.Color(c)]);

export function easeColor(e, out = new THREE.Color()) {
  if (e <= STOPS[0][0]) return out.copy(STOPS[0][1]);
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [e0, c0] = STOPS[i], [e1, c1] = STOPS[i + 1];
    if (e <= e1) return out.copy(c0).lerp(c1, (e - e0) / (e1 - e0));
  }
  return out.copy(STOPS[STOPS.length - 1][1]);
}

export const LEGEND = [
  { label: '꽉 낌', color: '#e5533a' },
  { label: '딱 맞음', color: '#f3a25a' },
  { label: '적당', color: '#e4e6dc' },
  { label: '여유', color: '#8cbde9' },
  { label: '아주 넉넉', color: '#2c64c9' },
];

export function summarize(rows) {
  // 정상 범위를 벗어난 부위 중 심한 순서로 3개 + 길이 정보, 문장은 몸 위에서 아래 순서로
  const off = rows.filter((r) => !r.always && r.status !== 'regular')
    .sort((a, b) => Math.abs(STATUS[b.status].rank - 2) - Math.abs(STATUS[a.status].rank - 2))
    .slice(0, 3);
  const picked = rows.filter((r) => off.includes(r) || r.always);
  const parts = (picked.length ? picked : rows.slice(0, 2)).map((r) => r.short);
  const tight = rows.filter((r) => r.status === 'tight');
  let verdict;
  if (tight.length >= 2) verdict = '작을 가능성이 높아요. 한 치수 큰 사이즈를 비교해 보세요.';
  else if (tight.length === 1) verdict = `${tight[0].part} 부분이 낄 수 있어요.`;
  else if (rows.some((r) => r.status === 'veryLoose')) verdict = '여유 있게 떨어지는 핏이에요.';
  else verdict = '전체적으로 잘 맞는 사이즈예요.';
  return { line: parts.join(', '), verdict };
}
