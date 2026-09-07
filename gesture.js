/**
 * 묵찌빠 손 모양 분류기 (MediaPipe Hands 21개 랜드마크 기반)
 *
 * 설계 원칙
 *  - 손의 회전/기울기/거울 반전에 영향받지 않도록 "거리 비율"과 "관절 각도"만 사용
 *  - 손가락마다 0~1 사이의 '펴짐 점수'를 계산하고, 그 점수의 여유(margin)로 신뢰도를 산출
 *  - 여러 프레임의 결과를 다수결로 안정화 (GestureSmoother)
 *
 * 랜드마크 인덱스
 *  0 손목 | 1-4 엄지(CMC,MCP,IP,TIP) | 5-8 검지 | 9-12 중지 | 13-16 약지 | 17-20 소지
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Gesture = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MUK = 'muk';   // 주먹 (바위)
  const JJI = 'jji';   // 가위
  const PPA = 'ppa';   // 보자기 (보)
  const NONE = null;

  const FINGERS = {
    index:  { mcp: 5,  pip: 6,  dip: 7,  tip: 8 },
    middle: { mcp: 9,  pip: 10, dip: 11, tip: 12 },
    ring:   { mcp: 13, pip: 14, dip: 15, tip: 16 },
    pinky:  { mcp: 17, pip: 18, dip: 19, tip: 20 },
  };

  function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
    // z 는 x,y 보다 노이즈가 커서 가중치를 낮춘다
    return Math.sqrt(dx * dx + dy * dy + 0.25 * dz * dz);
  }

  function angleDeg(a, b, c) { // b 에서의 각도
    const v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
    const v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
    const dot = v1.x * v2.x + v1.y * v2.y + 0.25 * v1.z * v2.z;
    const n1 = Math.sqrt(v1.x ** 2 + v1.y ** 2 + 0.25 * v1.z ** 2);
    const n2 = Math.sqrt(v2.x ** 2 + v2.y ** 2 + 0.25 * v2.z ** 2);
    if (!n1 || !n2) return 180;
    return Math.acos(Math.max(-1, Math.min(1, dot / (n1 * n2)))) * 180 / Math.PI;
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  /**
   * 엄지를 제외한 손가락의 펴짐 점수 (0 = 완전히 접힘, 1 = 완전히 펴짐)
   *  a) 손목 기준 거리 비율: tip 이 pip 보다 손목에서 멀면 펴진 것
   *  b) PIP 관절 각도: 180도에 가까울수록 펴진 것
   */
  function fingerScore(lm, f) {
    const wrist = lm[0];
    const dTip = dist(lm[f.tip], wrist);
    const dPip = dist(lm[f.pip], wrist);
    const dMcp = dist(lm[f.mcp], wrist);
    // 손가락 길이로 정규화: (tip-pip 거리 차) / (mcp-wrist 거리)
    const ratio = (dTip - dPip) / Math.max(dMcp, 1e-6);
    // 주먹: ratio ≈ -0.3 ~ 0.0 / 펴짐: ratio ≈ 0.5 ~ 0.9
    const sRatio = clamp01((ratio - 0.05) / 0.45);
    const ang = angleDeg(lm[f.mcp], lm[f.pip], lm[f.tip]);
    // 주먹: 60~110도 / 펴짐: 160~180도
    const sAngle = clamp01((ang - 110) / 55);
    return 0.6 * sRatio + 0.4 * sAngle;
  }

  /** 엄지 펴짐 점수: 엄지 끝이 소지 MCP 로부터 얼마나 멀리 벗어났는가 + IP 각도 */
  function thumbScore(lm) {
    const palm = dist(lm[5], lm[17]); // 손바닥 폭
    const dTip = dist(lm[4], lm[17]);
    const dIp = dist(lm[3], lm[17]);
    const sSpread = clamp01(((dTip - dIp) / Math.max(palm, 1e-6) - 0.05) / 0.35);
    // 엄지 끝이 검지 MCP 근처에 붙어 있으면(주먹 위로 접힘) 접힌 것으로 본다
    const sAway = clamp01((dist(lm[4], lm[5]) / Math.max(palm, 1e-6) - 0.45) / 0.5);
    return 0.5 * sSpread + 0.5 * sAway;
  }

  /**
   * @param {Array<{x,y,z}>} lm 21개 랜드마크
   * @returns {{label: string|null, confidence: number, scores: object, reason: string}}
   */
  function classify(lm) {
    if (!lm || lm.length < 21) return { label: NONE, confidence: 0, scores: {}, reason: 'no-landmarks' };

    const s = {
      thumb: thumbScore(lm),
      index: fingerScore(lm, FINGERS.index),
      middle: fingerScore(lm, FINGERS.middle),
      ring: fingerScore(lm, FINGERS.ring),
      pinky: fingerScore(lm, FINGERS.pinky),
    };
    const ext = (v) => v >= 0.5;
    const margin = (v) => Math.abs(v - 0.5) * 2; // 0.5 에서 얼마나 떨어져 있나
    const four = [s.index, s.middle, s.ring, s.pinky];

    const allCurled = four.every((v) => !ext(v));
    const allExt = four.every(ext);
    const scissorsStd = ext(s.index) && ext(s.middle) && !ext(s.ring) && !ext(s.pinky);
    // 한국식 변형 찌: 엄지 + 검지
    const scissorsAlt = ext(s.thumb) && ext(s.index) && !ext(s.middle) && !ext(s.ring) && !ext(s.pinky);

    let label = NONE, reason = 'ambiguous';
    let conf = 0;
    if (allCurled) {
      label = MUK; reason = 'all-curled';
      conf = Math.min(...four.map(margin));
    } else if (allExt) {
      label = PPA; reason = 'all-extended';
      conf = Math.min(...four.map(margin));
    } else if (scissorsStd) {
      label = JJI; reason = 'index+middle';
      conf = Math.min(...four.map(margin));
    } else if (scissorsAlt) {
      label = JJI; reason = 'thumb+index';
      conf = Math.min(margin(s.thumb), ...four.map(margin));
    }
    return { label, confidence: clamp01(conf), scores: s, reason };
  }

  /** 프레임 다수결 안정화 */
  class GestureSmoother {
    constructor({ window = 8, minAgree = 0.6, minConfidence = 0.15 } = {}) {
      this.window = window; this.minAgree = minAgree; this.minConfidence = minConfidence;
      this.buf = [];
    }
    reset() { this.buf = []; }
    push(result) {
      const label = result && result.confidence >= this.minConfidence ? result.label : NONE;
      this.buf.push(label);
      if (this.buf.length > this.window) this.buf.shift();
      return this.current();
    }
    current() {
      if (!this.buf.length) return { label: NONE, agreement: 0 };
      const counts = {};
      for (const l of this.buf) counts[l] = (counts[l] || 0) + 1;
      let best = NONE, bestN = 0;
      for (const [l, n] of Object.entries(counts)) {
        if (l === 'null') continue;
        if (n > bestN) { best = l; bestN = n; }
      }
      const agreement = bestN / this.buf.length;
      return agreement >= this.minAgree ? { label: best, agreement } : { label: NONE, agreement };
    }
  }

  const KO = { [MUK]: '묵', [JJI]: '찌', [PPA]: '빠' };
  const EMOJI = { [MUK]: '✊', [JJI]: '✌️', [PPA]: '🖐️' };

  /** 가위바위보 승패: a 가 b 를 이기면 1, 지면 -1, 비기면 0 */
  function beats(a, b) {
    if (a === b) return 0;
    if ((a === MUK && b === JJI) || (a === JJI && b === PPA) || (a === PPA && b === MUK)) return 1;
    return -1;
  }

  return { MUK, JJI, PPA, KO, EMOJI, classify, beats, GestureSmoother, _internal: { fingerScore, thumbScore, dist, angleDeg } };
});
