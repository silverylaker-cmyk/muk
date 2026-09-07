// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const G = require('../gesture.js');

// 합성 손 생성기: 손가락은 MCP 에서 위(-y)로 뻗음. curl=1 이면 손가락을 손바닥 쪽으로 말아 넣는다.
function hand({ index = 0, middle = 0, ring = 0, pinky = 0, thumb = 0, rot = 0, mirror = false }) {
  const lm = new Array(21);
  const P = (x, y, z = 0) => ({ x, y, z });
  lm[0] = P(0, 0);
  const mcps = { 5: [-0.15, -0.5], 9: [-0.05, -0.52], 13: [0.05, -0.5], 17: [0.15, -0.45] };
  const seg = 0.13;
  const finger = (mcpIdx, curl) => {
    const [mx, my] = mcps[mcpIdx];
    lm[mcpIdx] = P(mx, my);
    let x = mx, y = my, dir = -Math.PI / 2;
    const bend = curl * (Math.PI * 0.55);
    for (let k = 1; k <= 3; k++) {
      dir += bend;
      x += seg * Math.cos(dir); y += seg * Math.sin(dir);
      lm[mcpIdx + k] = P(x, y);
    }
  };
  finger(5, index); finger(9, middle); finger(13, ring); finger(17, pinky);
  lm[1] = P(-0.15, -0.15);
  lm[2] = P(-0.28, -0.28);
  if (thumb >= 0.5) { lm[3] = P(-0.42, -0.38); lm[4] = P(-0.55, -0.46); }
  else { lm[3] = P(-0.25, -0.42); lm[4] = P(-0.12, -0.5); }
  const c = Math.cos(rot), s = Math.sin(rot);
  return lm.map((p) => ({ x: (mirror ? -1 : 1) * (p.x * c - p.y * s), y: p.x * s + p.y * c, z: 0 }));
}

const variants = [{}, { rot: 0.7 }, { rot: -1.2 }, { rot: 3.0 }, { mirror: true }, { rot: 1.5, mirror: true }];

test('묵: 모든 손가락 접힘', () => {
  for (const v of variants) {
    const r = G.classify(hand({ index: 1, middle: 1, ring: 1, pinky: 1, ...v }));
    assert.strictEqual(r.label, G.MUK, JSON.stringify({ v, r }));
    assert.ok(r.confidence > 0.5, 'confidence ' + r.confidence);
  }
});

test('빠: 모든 손가락 펴짐', () => {
  for (const v of variants) {
    const r = G.classify(hand({ thumb: 1, ...v }));
    assert.strictEqual(r.label, G.PPA, JSON.stringify({ v, r }));
    assert.ok(r.confidence > 0.5);
  }
});

test('찌: 검지+중지', () => {
  for (const v of variants) {
    const r = G.classify(hand({ ring: 1, pinky: 1, ...v }));
    assert.strictEqual(r.label, G.JJI, JSON.stringify({ v, r }));
    assert.strictEqual(r.reason, 'index+middle');
  }
});

test('찌 변형: 엄지+검지', () => {
  const r = G.classify(hand({ thumb: 1, middle: 1, ring: 1, pinky: 1 }));
  assert.strictEqual(r.label, G.JJI);
  assert.strictEqual(r.reason, 'thumb+index');
});

test('애매한 손(검지만) 은 null', () => {
  const r = G.classify(hand({ middle: 1, ring: 1, pinky: 1 }));
  assert.strictEqual(r.label, null);
});

test('반쯤 접힌 손은 낮은 신뢰도', () => {
  const r = G.classify(hand({ index: 0.28, middle: 0.28, ring: 0.28, pinky: 0.28 }));
  assert.ok(r.confidence < 0.5, 'conf=' + r.confidence);
});

test('Smoother 다수결', () => {
  const s = new G.GestureSmoother({ window: 5, minAgree: 0.6 });
  const mk = (label, confidence = 1) => ({ label, confidence });
  s.push(mk(G.MUK)); s.push(mk(G.MUK)); s.push(mk(G.JJI));
  assert.strictEqual(s.current().label, G.MUK);
  s.push(mk(G.JJI)); s.push(mk(G.JJI));
  assert.strictEqual(s.current().label, G.JJI);
  const s3 = new G.GestureSmoother({ window: 4, minAgree: 0.6 });
  s3.push(mk(G.MUK)); s3.push(mk(G.MUK)); s3.push(mk(G.PPA)); s3.push(mk(G.PPA));
  assert.strictEqual(s3.current().label, null);
  const s2 = new G.GestureSmoother({ minConfidence: 0.3 });
  assert.strictEqual(s2.push(mk(G.MUK, 0.1)).label, null);
});

test('승패', () => {
  assert.strictEqual(G.beats(G.MUK, G.JJI), 1);
  assert.strictEqual(G.beats(G.JJI, G.PPA), 1);
  assert.strictEqual(G.beats(G.PPA, G.MUK), 1);
  assert.strictEqual(G.beats(G.JJI, G.MUK), -1);
  assert.strictEqual(G.beats(G.PPA, G.PPA), 0);
});
