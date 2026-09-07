/* 묵찌빠 카메라 게임 — 앱 로직 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d');
  const ui = {
    status: $('status'), count: $('count'), userHand: $('user-hand'), cpuHand: $('cpu-hand'),
    confBar: $('conf-bar'), attackerTag: $('attacker-tag'), log: $('log'),
    scoreUser: $('score-user'), scoreCpu: $('score-cpu'),
    btnCamera: $('btn-camera'), btnGame: $('btn-game'), btnStop: $('btn-stop'),
    optVoice: $('opt-voice'), optBeep: $('opt-beep'), optSpeed: $('opt-speed'), optModel: $('opt-model'),
  };
  const badgeUser = document.querySelector('.badge-user'), badgeCpu = document.querySelector('.badge-cpu');

  // ---------- 상태 ----------
  const state = {
    cameraOn: false, running: false, abort: false,
    attacker: null,          // 'user' | 'cpu'
    score: { user: 0, cpu: 0 },
    latest: null,            // 최근 프레임 분류 결과
    latestAt: 0,
    stable: { label: null, agreement: 0 },
  };
  const smoother = new Gesture.GestureSmoother({ window: 7, minAgree: 0.6, minConfidence: 0.15 });

  // ---------- 로그/상태 표시 ----------
  function setStatus(text, cls) {
    ui.status.textContent = text;
    ui.status.className = 'status' + (cls ? ' ' + cls : '');
  }
  function log(text) {
    const li = document.createElement('li');
    li.textContent = text;
    ui.log.prepend(li);
    while (ui.log.children.length > 30) ui.log.lastChild.remove();
  }
  function showHand(el, label) { el.textContent = label ? Gesture.EMOJI[label] + ' ' + Gesture.KO[label] : '–'; }
  function setAttacker(who) {
    state.attacker = who;
    badgeUser.classList.toggle('attacking', who === 'user');
    badgeCpu.classList.toggle('attacking', who === 'cpu');
    ui.attackerTag.textContent = who === 'cpu' ? '공격' : '';
    document.querySelector('.badge-user .badge-label').textContent = who === 'user' ? '내 손 · 공격' : '내 손';
  }

  // ---------- 오디오(비프) & 음성(TTS) ----------
  let audioCtx = null;
  function beep(freq = 880, ms = 90, gain = 0.15) {
    if (!ui.optBeep.checked) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.type = 'square';
      g.gain.value = gain; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + ms / 1000);
    } catch (e) { /* 무시 */ }
  }
  const synth = window.speechSynthesis;
  let koVoice = null;
  function pickVoice() {
    if (!synth) return;
    const voices = synth.getVoices();
    koVoice = voices.find((v) => /^ko/i.test(v.lang) && /Yuna|Google|Premium|Enhanced/i.test(v.name))
      || voices.find((v) => /^ko/i.test(v.lang)) || null;
  }
  if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }

  /** 텍스트를 말하고 끝날 때까지 기다림 (TTS 미지원/실패 시 대략적인 시간만큼 대기) */
  function speak(text, { rate = 1.05, pitch = 1.0, timeout } = {}) {
    const est = timeout || Math.max(500, 260 * text.length);
    if (!ui.optVoice.checked || !synth) return wait(est);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ko-KR'; u.rate = rate; u.pitch = pitch;
        if (koVoice) u.voice = koVoice;
        u.onend = finish; u.onerror = finish;
        synth.speak(u);
        setTimeout(finish, est * 2.5 + 800); // 이벤트가 안 오는 브라우저 대비
      } catch (e) { finish(); }
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function flashCount(text, hold = false) {
    ui.count.textContent = text;
    ui.count.classList.remove('pop', 'hold');
    void ui.count.offsetWidth; // 애니메이션 재시작
    ui.count.classList.add(hold ? 'hold' : 'pop');
  }
  function clearCount() { ui.count.textContent = ''; ui.count.classList.remove('pop', 'hold'); }

  // ---------- MediaPipe Hands ----------
  let hands = null, rafId = 0, busy = false;
  function createHands() {
    const h = new Hands({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}` });
    h.setOptions({
      maxNumHands: 1,
      modelComplexity: Number(ui.optModel.value),
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6,
      selfieMode: false, // 캔버스는 CSS 로 좌우 반전
    });
    h.onResults(onResults);
    return h;
  }
  ui.optModel.addEventListener('change', () => { if (hands) hands.setOptions({ modelComplexity: Number(ui.optModel.value) }); });

  function onResults(res) {
    if (canvas.width !== res.image.width || canvas.height !== res.image.height) {
      canvas.width = res.image.width; canvas.height = res.image.height;
    }
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(res.image, 0, 0, canvas.width, canvas.height);
    let result = { label: null, confidence: 0 };
    if (res.multiHandLandmarks && res.multiHandLandmarks.length) {
      const lm = res.multiHandLandmarks[0];
      result = Gesture.classify(lm);
      const color = result.label ? '#22c55e' : '#f59e0b';
      if (window.drawConnectors) {
        drawConnectors(ctx, lm, HAND_CONNECTIONS, { color: 'rgba(255,255,255,.7)', lineWidth: 3 });
        drawLandmarks(ctx, lm, { color, lineWidth: 1, radius: 4 });
      }
    }
    ctx.restore();
    state.latest = result; state.latestAt = performance.now();
    state.stable = smoother.push(result);
    showHand(ui.userHand, state.stable.label);
    ui.confBar.style.width = Math.round(result.confidence * 100) + '%';
    ui.confBar.style.background = result.label ? '#22c55e' : '#ef4444';
  }

  async function loop() {
    if (!state.cameraOn) return;
    if (!busy && video.readyState >= 2) {
      busy = true;
      try { await hands.send({ image: video }); } catch (e) { console.error(e); }
      busy = false;
    }
    rafId = requestAnimationFrame(loop);
  }

  async function startCamera() {
    ui.btnCamera.disabled = true;
    setStatus('카메라를 준비하는 중…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
      });
      video.srcObject = stream;
      await video.play();
      hands = hands || createHands();
      await hands.initialize();
      state.cameraOn = true;
      loop();
      // iOS 에서 오디오/TTS 는 사용자 제스처 안에서 한 번 깨워 줘야 한다
      beep(660, 40, 0.01);
      if (synth) { try { synth.cancel(); } catch (e) {} }
      ui.btnCamera.textContent = '📷 카메라 켜짐';
      ui.btnGame.disabled = false;
      setStatus('연습 모드: 손을 보여 주세요. 인식되면 왼쪽 위에 표시됩니다.');
      log('카메라 시작. 손 인식 준비 완료.');
    } catch (e) {
      console.error(e);
      ui.btnCamera.disabled = false;
      const insecure = location.protocol !== 'https:' && location.hostname !== 'localhost';
      setStatus(insecure ? '카메라는 HTTPS 주소에서만 사용할 수 있어요.' : '카메라를 열 수 없어요: ' + (e.message || e.name));
    }
  }

  // ---------- 손 모양 샘플링 ----------
  /** ms 동안 프레임 결과를 모아 가장 많이 나온 손 모양을 돌려준다 */
  async function sampleGesture(ms) {
    const counts = {}; const t0 = performance.now(); let lastAt = -1;
    while (performance.now() - t0 < ms) {
      if (state.abort) return null;
      if (state.latestAt !== lastAt && state.latest && state.latest.label && state.latest.confidence >= 0.15) {
        lastAt = state.latestAt;
        counts[state.latest.label] = (counts[state.latest.label] || 0) + state.latest.confidence;
      }
      await wait(16);
    }
    let best = null, bestV = 0;
    for (const [k, v] of Object.entries(counts)) if (v > bestV) { best = k; bestV = v; }
    return best;
  }

  /** "가위 바위 보!" 또는 "묵 찌 빠!" 카운트: 말하며 박자마다 화면에 크게 표시, 마지막 박자에 손을 읽는다 */
  async function countAndCapture(words) {
    const beat = Number(ui.optSpeed.value);
    for (let i = 0; i < words.length; i++) {
      if (state.abort) return null;
      const last = i === words.length - 1;
      flashCount(words[i] + (last ? '!' : ''), last);
      beep(last ? 1320 : 880, last ? 160 : 80);
      const t0 = performance.now();
      const p = speak(words[i] + (last ? '!' : ''), { rate: 1.15, timeout: beat });
      if (last) smoother.reset();
      // 박자 간격 유지 (TTS 가 짧게 끝나도 beat 만큼 기다림)
      await p;
      const remain = beat - (performance.now() - t0);
      if (remain > 0 && !last) await wait(remain);
    }
    // 마지막 박자 직후 ~600ms 동안 손을 읽는다
    const label = await sampleGesture(650);
    clearCount();
    return label;
  }

  const randomHand = () => [Gesture.MUK, Gesture.JJI, Gesture.PPA][Math.floor(Math.random() * 3)];
  const ko = (l) => Gesture.KO[l];

  // ---------- 게임 진행 ----------
  async function runGame() {
    state.running = true; state.abort = false;
    ui.btnGame.disabled = true; ui.btnStop.disabled = false;
    setAttacker(null); showHand(ui.cpuHand, null);
    try {
      await speak('묵찌빠 시작! 먼저 가위바위보.', { timeout: 1800 });
      // 1) 가위바위보로 공격권 결정
      while (!state.abort) {
        setStatus('가위 바위 보! 마지막 박자에 손을 내세요.');
        const user = await countAndCapture(['가위', '바위', '보']);
        if (state.abort) break;
        if (!user) { setStatus('손이 안 보여요. 손 전체를 카메라에 보여 주세요.'); await speak('손이 안 보여요. 다시.', { timeout: 1500 }); continue; }
        const cpu = randomHand();
        showHand(ui.cpuHand, cpu);
        const r = Gesture.beats(user, cpu);
        log(`가위바위보 — 나: ${ko(user)} / 컴퓨터: ${ko(cpu)}`);
        if (r === 0) { setStatus(`비겼어요 (${ko(user)}). 다시!`); await speak('비겼다. 다시.', { timeout: 1200 }); continue; }
        setAttacker(r > 0 ? 'user' : 'cpu');
        const msg = r > 0 ? '이겼어요! 내가 공격.' : '졌어요. 컴퓨터가 공격.';
        setStatus(msg); await speak(r > 0 ? '내가 공격!' : '컴퓨터 공격!', { timeout: 1200 });
        break;
      }
      // 2) 묵찌빠 반복
      while (!state.abort) {
        await wait(400);
        setStatus((state.attacker === 'user' ? '내 공격 — ' : '컴퓨터 공격 — ') + '묵! 찌! 빠! 같으면 공격자 승리');
        const user = await countAndCapture(['묵', '찌', '빠']);
        if (state.abort) break;
        if (!user) { setStatus('손이 안 보여요. 다시 할게요.'); await speak('손이 안 보여요. 다시.', { timeout: 1500 }); continue; }
        const cpu = randomHand();
        showHand(ui.cpuHand, cpu);
        log(`묵찌빠(${state.attacker === 'user' ? '내 공격' : '컴퓨터 공격'}) — 나: ${ko(user)} / 컴퓨터: ${ko(cpu)}`);
        if (user === cpu) {
          const iWin = state.attacker === 'user';
          state.score[iWin ? 'user' : 'cpu']++;
          ui.scoreUser.textContent = state.score.user; ui.scoreCpu.textContent = state.score.cpu;
          setStatus(`${ko(cpu)}! 같아요 — ${iWin ? '내 승리! 🎉' : '컴퓨터 승리 😢'}`, iWin ? 'win' : 'lose');
          await speak(`${ko(cpu)}! ${iWin ? '내 승리!' : '컴퓨터 승리!'}`, { timeout: 1600 });
          log(iWin ? '★ 내 승리' : '★ 컴퓨터 승리');
          break;
        }
        const r = Gesture.beats(user, cpu);
        const next = r > 0 ? 'user' : 'cpu';
        const changed = next !== state.attacker;
        setAttacker(next);
        setStatus(`달라요 — ${changed ? (next === 'user' ? '공격권이 나에게!' : '공격권이 컴퓨터에게!') : (next === 'user' ? '계속 내 공격' : '계속 컴퓨터 공격')}`);
        await speak(changed ? (next === 'user' ? '내 공격!' : '컴퓨터 공격!') : '계속!', { timeout: 1000 });
      }
    } finally {
      clearCount();
      state.running = false;
      ui.btnGame.disabled = false; ui.btnStop.disabled = true;
      if (state.abort) { setStatus('게임을 중단했어요.'); setAttacker(null); }
      else ui.btnGame.textContent = '🎮 한 판 더';
    }
  }

  ui.btnCamera.addEventListener('click', startCamera);
  ui.btnGame.addEventListener('click', () => { if (!state.running) runGame(); });
  ui.btnStop.addEventListener('click', () => { state.abort = true; if (synth) synth.cancel(); });

  document.addEventListener('visibilitychange', () => { if (document.hidden && synth) synth.cancel(); });
  window.addEventListener('error', (e) => log('오류: ' + (e.message || e.error)));
})();
