/* 묵찌빠 카메라 게임 — 앱 로직 */
import { HandLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

(function () {
  'use strict';
  const TASKS_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
  const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  const $ = (id) => document.getElementById(id);
  const video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d');
  const ui = {
    status: $('status'), count: $('count'), userHand: $('user-hand'), cpuHand: $('cpu-hand'),
    confBar: $('conf-bar'), attackerTag: $('attacker-tag'), log: $('log'),
    scoreUser: $('score-user'), scoreCpu: $('score-cpu'),
    btnCamera: $('btn-camera'), btnGame: $('btn-game'), btnStop: $('btn-stop'),
    optVoice: $('opt-voice'), optBeep: $('opt-beep'), optSpeed: $('opt-speed'),
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

  // ---------- MediaPipe HandLandmarker (Tasks Vision) ----------
  let landmarker = null, rafId = 0, busy = false;
  const stats = { frames: 0, hands: 0, lastError: '' };
  const debugEl = $('debug');
  function setDebug() {
    if (!debugEl) return;
    debugEl.textContent = `프레임 ${stats.frames} · 손 감지 ${stats.hands}` + (stats.lastError ? ` · 오류: ${stats.lastError}` : '');
  }

  async function createLandmarker() {
    const vision = await FilesetResolver.forVisionTasks(TASKS_WASM);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: HAND_MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    try {
      return await HandLandmarker.createFromOptions(vision, opts('GPU'));
    } catch (e) {
      console.warn('GPU delegate 실패, CPU 로 전환', e);
      log('GPU 가속 불가 → CPU 모드로 인식합니다.');
      return await HandLandmarker.createFromOptions(vision, opts('CPU'));
    }
  }

  function drawHand(lm, color) {
    const W = canvas.width, H = canvas.height;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.75)';
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.beginPath(); ctx.moveTo(lm[a].x * W, lm[a].y * H); ctx.lineTo(lm[b].x * W, lm[b].y * H); ctx.stroke();
    }
    ctx.fillStyle = color;
    for (const p of lm) { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 5, 0, Math.PI * 2); ctx.fill(); }
  }

  function processFrame() {
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let result = { label: null, confidence: 0 };
    stats.frames++;
    if (landmarker) {
      try {
        const res = landmarker.detectForVideo(video, performance.now());
        if (res && res.landmarks && res.landmarks.length) {
          const lm = res.landmarks[0];
          stats.hands++;
          result = Gesture.classify(lm);
          drawHand(lm, result.label ? '#22c55e' : '#f59e0b');
        }
      } catch (e) {
        stats.lastError = e.message || String(e);
        console.error(e);
      }
    }
    state.latest = result; state.latestAt = performance.now();
    state.stable = smoother.push(result);
    showHand(ui.userHand, state.stable.label);
    ui.confBar.style.width = Math.round(result.confidence * 100) + '%';
    ui.confBar.style.background = result.label ? '#22c55e' : '#ef4444';
    if (stats.frames % 15 === 0) setDebug();
  }

  function loop() {
    if (!state.cameraOn) return;
    if (video.readyState >= 2 && video.videoWidth > 0) processFrame();
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
      state.cameraOn = true;
      loop(); // 모델이 준비되기 전에도 카메라 화면은 바로 보여 준다
      setStatus('손 인식 모델을 내려받는 중… (첫 실행은 몇 초 걸립니다)');
      try {
        landmarker = landmarker || await createLandmarker();
      } catch (e) {
        console.error(e);
        stats.lastError = e.message || String(e);
        setDebug();
        setStatus('손 인식 모델을 불러오지 못했어요. 네트워크를 확인하고 새로고침해 주세요.');
        log('모델 로드 실패: ' + stats.lastError);
        return;
      }
      // iOS 에서 오디오/TTS 는 사용자 제스처 안에서 한 번 깨워 줘야 한다
      beep(660, 40, 0.01);
      if (synth) { try { synth.cancel(); } catch (e) {} }
      ui.btnCamera.textContent = '📷 카메라 켜짐';
      ui.btnGame.disabled = false;
      setStatus('연습 모드: 손바닥을 카메라에 보여 주세요. 인식되면 왼쪽 위에 표시됩니다.');
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
