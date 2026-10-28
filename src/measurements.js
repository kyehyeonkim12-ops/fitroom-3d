// 신체 치수 정의, 기본값 추정, 범위 검사, 저장.
// 모든 길이 단위는 cm, 몸무게는 kg.

export const FIELDS = [
  { key: 'height',   group: 'basic', label: '키',         unit: 'cm', min: 120, max: 220, step: 0.5, hint: '맨발로 서서 바닥부터 정수리까지' },
  { key: 'weight',   group: 'basic', label: '몸무게',     unit: 'kg', min: 30,  max: 160, step: 0.5, hint: '' },

  { key: 'shoulder', group: 'upper', label: '어깨너비',   unit: 'cm', min: 28,  max: 60,  step: 0.5, hint: '등 뒤에서 왼쪽 어깨끝점부터 오른쪽 어깨끝점까지 직선' },
  { key: 'neck',     group: 'upper', label: '목둘레',     unit: 'cm', min: 25,  max: 55,  step: 0.5, hint: '목 아래쪽, 울대 바로 밑' },
  { key: 'chest',    group: 'upper', label: '가슴둘레',   unit: 'cm', min: 60,  max: 150, step: 0.5, hint: '겨드랑이 아래 가장 두꺼운 곳을 수평으로' },
  { key: 'waist',    group: 'upper', label: '허리둘레',   unit: 'cm', min: 45,  max: 150, step: 0.5, hint: '배꼽 위 가장 잘록한 곳' },
  { key: 'arm',      group: 'upper', label: '팔길이',     unit: 'cm', min: 40,  max: 80,  step: 0.5, hint: '어깨끝점에서 손목뼈까지, 팔을 자연스럽게 내린 상태' },
  { key: 'upperArm', group: 'upper', label: '위팔둘레',   unit: 'cm', min: 18,  max: 50,  step: 0.5, hint: '겨드랑이 아래 위팔에서 가장 굵은 곳' },

  { key: 'hip',      group: 'lower', label: '엉덩이둘레', unit: 'cm', min: 65,  max: 160, step: 0.5, hint: '엉덩이에서 가장 튀어나온 곳을 수평으로' },
  { key: 'thigh',    group: 'lower', label: '허벅지둘레', unit: 'cm', min: 35,  max: 90,  step: 0.5, hint: '가랑이 바로 아래 가장 굵은 곳' },
  { key: 'calf',     group: 'lower', label: '종아리둘레', unit: 'cm', min: 22,  max: 60,  step: 0.5, hint: '종아리에서 가장 굵은 곳' },
  { key: 'leg',      group: 'lower', label: '다리길이',   unit: 'cm', min: 55,  max: 105, step: 0.5, hint: '안쪽 기준. 가랑이부터 바닥까지 (인심)' },
  { key: 'calfLen',  group: 'lower', label: '종아리길이', unit: 'cm', min: 25,  max: 60,  step: 0.5, hint: '무릎 가운데부터 복숭아뼈까지' },
];

export const GROUPS = [
  { id: 'basic', title: '기본' },
  { id: 'upper', title: '상체' },
  { id: 'lower', title: '하체' },
];

// 키 대비 평균 비율. 남 175cm/70kg, 여 162cm/53kg 성인 평균 체형 기준.
const RATIOS = {
  male: {
    bmi: 22.9,
    shoulder: 0.245, neck: 0.217, chest: 0.543, waist: 0.457, hip: 0.543,
    thigh: 0.314, calf: 0.211, upperArm: 0.171, arm: 0.335, leg: 0.452, calfLen: 0.235,
  },
  female: {
    bmi: 20.2,
    shoulder: 0.232, neck: 0.198, chest: 0.519, waist: 0.407, hip: 0.562,
    thigh: 0.327, calf: 0.210, upperArm: 0.160, arm: 0.325, leg: 0.450, calfLen: 0.235,
  },
};

// 몸무게에 따라 둘레가 얼마나 변하는지 (BMI 비율의 지수)
const GIRTH_EXP = { neck: 0.45, chest: 0.5, waist: 0.85, hip: 0.5, thigh: 0.6, calf: 0.4, upperArm: 0.65, shoulder: 0.12 };

const round = (v) => Math.round(v * 2) / 2;

export function estimate(gender, height, weight) {
  const r = RATIOS[gender] || RATIOS.male;
  const bmi = weight / ((height / 100) ** 2);
  const k = bmi / r.bmi;
  const out = { height, weight };
  for (const key of ['shoulder', 'neck', 'chest', 'waist', 'hip', 'thigh', 'calf', 'upperArm', 'arm', 'leg', 'calfLen']) {
    const exp = GIRTH_EXP[key] || 0;
    out[key] = round(height * r[key] * Math.pow(k, exp));
  }
  return out;
}

export function defaultProfile() {
  return { gender: 'female', values: estimate('female', 162, 53), savedAt: null, isSample: true };
}

export function checkValue(field, v) {
  if (!Number.isFinite(v)) return '숫자를 입력해 주세요';
  if (v < field.min || v > field.max) return `${field.min}–${field.max}${field.unit} 사이로 입력해 주세요`;
  return null;
}

// 모델 생성용: 범위 밖 값은 경계로 맞춘다.
export function clampValues(values) {
  const out = {};
  for (const f of FIELDS) {
    const v = Number(values[f.key]);
    out[f.key] = Number.isFinite(v) ? Math.min(f.max, Math.max(f.min, v)) : (f.min + f.max) / 2;
  }
  return out;
}

// 서로 맞지 않는 치수 조합 경고
export function crossChecks(v) {
  const notes = [];
  if (v.leg > v.height * 0.56) notes.push('다리길이가 키에 비해 깁니다. 가랑이부터 바닥까지 잰 값인지 확인해 주세요.');
  if (v.leg < v.height * 0.36) notes.push('다리길이가 키에 비해 짧습니다. 바지 인심 길이 기준인지 확인해 주세요.');
  if (v.calfLen > v.leg * 0.62) notes.push('종아리길이가 다리길이에 비해 깁니다. 무릎 가운데부터 재 주세요.');
  if (v.waist > v.chest * 1.25) notes.push('허리둘레가 가슴둘레보다 훨씬 큽니다. 입력값을 확인해 주세요.');
  if (v.thigh > v.hip * 0.8) notes.push('허벅지둘레가 엉덩이둘레에 비해 큽니다. 한쪽 다리만 잰 값인지 확인해 주세요.');
  return notes;
}

const STORE_KEY = 'fitroom.body.v1';

export function loadProfile() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !p.values) return null;
    return { gender: p.gender === 'male' ? 'male' : 'female', values: p.values, savedAt: p.savedAt || null, isSample: false };
  } catch {
    return null;
  }
}

export function saveProfile(profile) {
  try {
    const savedAt = new Date().toISOString();
    localStorage.setItem(STORE_KEY, JSON.stringify({ gender: profile.gender, values: profile.values, savedAt }));
    return savedAt;
  } catch {
    return null;
  }
}

export function clearProfile() {
  try { localStorage.removeItem(STORE_KEY); } catch { /* 저장소 차단 시 무시 */ }
}
