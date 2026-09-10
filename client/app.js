/* Animal Stock — mobile client: DOM UI + server intents, flat felt table. */
const APP_BUILD = 13; // bump with ?v= in index.html on every client change
let serverVer = 0;
function paintBuildTag() {
  const el = $('buildtag');
  if (el) el.textContent = `app v${APP_BUILD}` + (serverVer ? ` · server v${serverVer}` : '');
}
const $ = (id) => document.getElementById(id);
const screens = { splash: $('screen-splash'), join: $('screen-join'), lobby: $('screen-lobby'), game: $('screen-game') };
function show(name) { for (const k in screens) screens[k].classList.toggle('active', k === name); }

// splash: floating pink pig, tap to jump in
$('pig-splash').innerHTML = window.AnimalArt.shape('hippo', 180, 'bo');
$('screen-splash').onclick = () => {
  const s = $('screen-splash');
  if (s.classList.contains('jump')) return;
  s.classList.add('jump');
  setTimeout(() => { s.classList.remove('jump'); show('join'); }, 450);
};

let ws = null, wsOk = false, reconnectTries = 0;
let playerId = sessionStorage.getItem('as_pid') || null;
let roomCode = sessionStorage.getItem('as_room') || null;
let playerName = sessionStorage.getItem('as_name') || '';
let state = null;            // last redacted STATE
let drawnCard = null;        // private DRAWN card
let selHalf = null, selHippoIdx = null, hippoNapped = false;
let muted = localStorage.getItem('as_mute') === '1';
let lastRevealKey = '';

if (playerName) $('in-name').value = playerName;
if (roomCode) $('in-code').value = roomCode;
updateMuteBtn();

// ---------- sounds (synth, no assets) ----------
let AC = null;
function ac() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); return AC; }
function bellSound() {
  if (muted) return;
  try {
    const c = ac(), t = c.currentTime;
    [880, 1174, 1568].forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.25 / (i + 1), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + 1.2);
    });
  } catch (e) {}
}
function gruntSound() {
  if (muted) return;
  try {
    const c = ac(), t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.35);
    g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.4);
  } catch (e) {}
}
function updateMuteBtn() { $('btn-mute').textContent = muted ? '🔕' : '🔔'; }
$('btn-mute').onclick = () => { muted = !muted; localStorage.setItem('as_mute', muted ? '1' : '0'); updateMuteBtn(); };

// ---------- websocket ----------
function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host + '/ws';
}
function connect() {
  setConn(false);
  ws = new WebSocket(wsURL());
  ws.onopen = () => {
    setConn(true); reconnectTries = 0;
    if (pendingLobbyMsg) {
      // explicit tap beats auto-reclaim: it is the newest user intent
      const o = pendingLobbyMsg; pendingLobbyMsg = null; send(o);
    } else if (roomCode && playerId) {
      // auto-reclaim seat (phones lock constantly — spec section 12)
      send({ type: 'JOIN', room: roomCode, name: playerName || 'Player', playerId });
    }
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    onMsg(m);
  };
  ws.onclose = () => {
    setConn(false);
    const wait = Math.min(5000, 500 * Math.pow(1.6, reconnectTries++));
    toast('Connection lost — reconnecting…');
    setTimeout(connect, wait);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
// Lobby entry (create/join/solo) is queued if the socket isn't open yet,
// so an early tap is never silently dropped.
let pendingLobbyMsg = null;
function sendLobby(o) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); }
  else {
    pendingLobbyMsg = o;
    toast('Connecting… joining automatically.');
  }
}
function setConn(on) { wsOk = on; $('conn').className = 'conn ' + (on ? 'online' : 'offline'); }

function onMsg(m) {
  if (m.type === 'WELCOME') {
    playerId = m.playerId; roomCode = m.room;
    serverVer = m.v || 0;
    paintBuildTag();
    pendingLobbyMsg = null;
    sessionStorage.setItem('as_pid', playerId);
    sessionStorage.setItem('as_room', roomCode);
    sessionStorage.setItem('as_name', playerName);
    // solo flow: fill the fresh room with bots, then auto-start on arrival
    if (pendingBotTotal && Date.now() - pendingBotAt < 15000) {
      if ((m.v || 1) < 3) {
        pendingBotTotal = 0;
        toast('This game server is too old for bots — please restart server.py.');
      } else {
        send({ type: 'ADD_BOTS', count: pendingBotTotal - 1 });
      }
    } else {
      pendingBotTotal = 0;
    }
  } else if (m.type === 'STATE') {
    state = m.state;
    render();
  } else if (m.type === 'DRAWN') {
    drawnCard = m.card; selHalf = null; selHippoIdx = null; hippoNapped = false;
    if (drawnCard.hippo) {
      // Hippo targets are picked on the main board: the note stays up
      // until tapped, then the board itself becomes the picker.
      render();
      const faceN = (state.orders || []).filter(o => o.faceUp).length;
      showHippo(drawnCard.hippo,
        faceN ? 'Tap anywhere to continue — then tap an order to swap its halves'
              : 'No orders out — naps, no effect.',
        'draw');
    } else {
      openDrawModal();
    }
  } else if (m.type === 'ERROR') {
    toast(m.message);
    pendingBotTotal = 0; // let the user retry the solo setup cleanly
    const je = $('join-err'), le = $('lobby-err');
    if (je) je.textContent = m.message;
    if (le) le.textContent = m.message;
  }
}

// ---------- join / lobby ----------
$('btn-create').onclick = () => {
  playerName = ($('in-name').value || 'Player').trim().slice(0, 12) || 'Player';
  sessionStorage.setItem('as_name', playerName);
  $('join-err').textContent = '';
  sendLobby({ type: 'CREATE', name: playerName });
};
$('btn-join').onclick = () => {
  playerName = ($('in-name').value || 'Player').trim().slice(0, 12) || 'Player';
  const code = ($('in-code').value || '').trim().toUpperCase();
  if (code.length !== 4) { $('join-err').textContent = 'Code is 4 characters.'; return; }
  sessionStorage.setItem('as_name', playerName);
  $('join-err').textContent = '';
  playerId = null; // fresh join unless server matches name? keep simple: fresh seat
  sessionStorage.removeItem('as_pid');
  roomCode = code; sessionStorage.setItem('as_room', code);
  sendLobby({ type: 'JOIN', room: code, name: playerName });
};
$('btn-start').onclick = () => send({ type: 'START' });

// ---------- guided picture tour (inside How to play) ----------
const ART = window.AnimalArt;
const TOUR = [
  { t: 'Goal of the game',
    b: 'Everyone collects angry-manager tokens worth 1, then 2, then 3… The first player to reach <b>7+ total LOSES</b> — the lowest score wins.',
    mock: `<div style="font-size:64px">🏆</div>` },
  { t: 'Whose card is whose?',
    b: 'Every stock card faces <b>everyone except its owner</b>. You see their animals — never your own 🙈. (2-player games add a shared spare card.)',
    mock: `<div class="stocks">
      <div class="stock"><div class="nm">Ann</div><div class="cd"><span class="halfchip">${ART.icon('toucan', 1, 20)}</span><span class="halfchip">${ART.icon('leopard', 2, 20)}</span></div></div>
      <div class="stock"><div class="nm">Bo</div><div class="cd"><span class="halfchip">${ART.icon('fox', 1, 20)}</span><span class="halfchip">${ART.icon('toucan', 2, 20)}</span></div></div>
      <div class="stock me"><div class="nm">You</div><div class="cd"><span style="font-size:40px">🙈</span></div></div>
    </div>` },
  { t: 'Take an order',
    b: 'On your turn tap <b>TAKE</b>: draw a card and pick <b>ONE half</b>. Only that half becomes an order — the other half is discarded.',
    mock: `<button class="takebtn" style="min-height:56px;font-size:17px"><span class="deckmini"></span><span>TAKE</span></button>
    <div class="halves">
      <div class="halfpick"><div>${ART.icon('toucan', 1, 44)}</div><div class="big">A — 1× toucan</div></div>
      <div class="halfpick"><div>${ART.icon('leopard', 3, 44)}</div><div class="big">B — 3× leopard</div></div>
    </div>` },
  { t: 'The order board',
    b: 'Picked halves pile up, newest at the bottom. The faded halves beside them are the discards — <b>they count for nothing</b>.',
    mock: `<div class="orow"><div class="disc">${ART.icon('leopard', 3, 20)}</div><div class="pick">${ART.icon('toucan', 1, 26)}</div></div>
    <div class="orow"><div class="disc">${ART.icon('toucan', 2, 20)}</div><div class="pick">${ART.icon('fox', 1, 26)}</div></div>` },
  { t: 'The running tally',
    b: 'Always-visible totals of face-up orders — your deduction aid. It <b>never includes hidden stocks</b>, so that part is up to you.',
    mock: `<div class="draw-tally"><span class="dtchip">${ART.icon('toucan', 1, 20)}<b>3</b></span><span class="dtchip">${ART.icon('fox', 1, 20)}<b>2</b></span><span class="dtchip">${ART.icon('leopard', 1, 20)}<b>0</b></span><span class="dtchip">${ART.icon('elephant', 1, 20)}<b>1</b></span></div>` },
  { t: 'Ring the bell 🔔',
    b: 'On <b>YOUR turn only</b>, with at least 1 face-up order: accuse the table of overselling. Spot it on someone else\u2019s turn? You must wait for yours.',
    mock: `<div style="font-size:64px">🔔</div>` },
  { t: 'Only the last order is judged',
    b: 'The bell checks <b>just the newest order\u2019s animal</b> against stock. Everything older is history. (Hosts can switch to all-animals.)',
    mock: `<div class="orow"><div class="disc">${ART.icon('fox', 1, 20)}</div><div class="pick">${ART.icon('toucan', 2, 26)}</div></div>
    <div class="orow demo-last"><div class="disc">${ART.icon('toucan', 1, 20)}</div><div class="pick">${ART.icon('fox', 3, 26)}</div></div>` },
  { t: 'Who takes the token?',
    b: 'Oversold → whoever placed the <b>last order</b> takes the token. Board was fine → <b>you, the ringer</b>, take it. The token-taker starts next round.',
    mock: `<div class="tchips"><span class="tchip">⚡1</span><span class="tchip">⚡2</span><span class="ttotal">3</span></div>` },
  { t: 'Hippo drawn = swap',
    b: 'Drew a Hippo? Tap any face-up order to <b>swap its halves</b> — the unpicked side goes live. The Hippo parks beside that row. Empty board: it naps. Swapping can never blame you.',
    mock: `<div class="orow"><div class="pick">${ART.icon('leopard', 3, 26)}</div><div class="disc">${ART.icon('toucan', 1, 20)}</div><div class="flipmarks"><span class="fmark">${ART.shape('hippo', 24, 'bo')}</span></div></div>` },
  { t: 'Hippos hiding in stocks',
    b: 'Revealed only when the bell rings: <b>BO</b> (red) cancels all 3-counts · <b>PIP</b> (purple) cancels all Fox · <b>DOZY</b> (grey) naps. Tap any Hippo in-game to re-read this.',
    mock: `<div style="display:flex;gap:14px">${['bo', 'pip', 'dozy'].map(h => `<div style="text-align:center">${ART.shape('hippo', 54, h)}<div><b>${h.toUpperCase()}</b></div></div>`).join('')}</div>` },
  { t: 'No ringing after Hippo',
    b: 'The turn right after a Hippo draw <b>cannot ring</b> — the bell locks and you must take. Hover the bell anytime to see the rule.',
    mock: `<div style="font-size:64px;filter:grayscale(1);opacity:.5">🔔</div><div style="font-size:40px">🚫</div>` },
  { t: '15-second turns',
    b: 'The frame around the active box drains clockwise from the top-right — red flicker under 5s. Timeout <b>auto-plays</b> for you, never a stall.',
    mock: `<div style="width:150px;height:110px;border:4px solid #2E9E5B;border-radius:14px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:22px">15s</div>` },
  { t: 'Bots have your back',
    b: 'Leave mid-game and a 🤖 bot plays your seat fairly — rejoin anytime to take it back. Or start <b>Vs bots</b> to practice solo.',
    mock: `<div style="font-size:64px">🤖</div>` },
  { t: 'You\u2019re ready!',
    b: 'Lowest score wins, 7+ loses. Feeling brave? Ring early and often — fortune favours the sharp counter.',
    mock: `<div style="font-size:64px">🃏</div>` },
];
let tourIdx = 0;
function openTour() { tourIdx = 0; renderTour(); $('modal-tour').classList.remove('hidden'); }
function closeTour() { $('modal-tour').classList.add('hidden'); }
function renderTour() {
  const s = TOUR[tourIdx];
  const spot = $('tour-spot');
  spot.innerHTML = s.mock || '';
  spot.style.display = s.mock ? '' : 'none';
  $('tour-title').textContent = s.t;
  $('tour-body').innerHTML = s.b;
  $('tour-count').textContent = (tourIdx + 1) + ' / ' + TOUR.length;
  $('tour-dots').innerHTML = TOUR.map((_, k) => `<span class="tdot${k === tourIdx ? ' on' : ''}"></span>`).join('');
  $('btn-tour-go').classList.toggle('hidden', tourIdx !== TOUR.length - 1);
  $('tour-prev').disabled = tourIdx === 0;
  $('tour-next').disabled = tourIdx === TOUR.length - 1;
}
$('btn-tour').onclick = () => openTour();
$('btn-tour-x').onclick = (e) => { e.stopPropagation(); closeTour(); };
$('btn-tour-go').onclick = (e) => { e.stopPropagation(); closeTour(); };
$('tour-prev').onclick = (e) => { e.stopPropagation(); if (tourIdx > 0) { tourIdx--; renderTour(); } };
$('tour-next').onclick = (e) => { e.stopPropagation(); if (tourIdx < TOUR.length - 1) { tourIdx++; renderTour(); } };
$('modal-tour').addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  if (tourIdx < TOUR.length - 1) { tourIdx++; renderTour(); }
  else closeTour();
});
// test hook (?tour=3): open the tour at a given slide
try {
  const ti = parseInt(new URLSearchParams(location.search).get('tour') || '', 10);
  if (!isNaN(ti)) {
    tourIdx = Math.max(0, Math.min(TOUR.length - 1, ti));
    renderTour();
    $('modal-tour').classList.remove('hidden');
  }
} catch (e) {}

// ---------- first screen: friends vs bots ----------
let playTab = 'friends', botGameSize = 3, pendingBotTotal = 0, pendingBotAt = 0;
function setPlayTab(t) {
  playTab = t;
  $('tab-friends').classList.toggle('sel', t === 'friends');
  $('tab-bots').classList.toggle('sel', t === 'bots');
  $('panel-friends').classList.toggle('hidden', t !== 'friends');
  $('panel-bots').classList.toggle('hidden', t !== 'bots');
}
$('tab-friends').onclick = () => setPlayTab('friends');
$('tab-bots').onclick = () => setPlayTab('bots');
document.querySelectorAll('#bots-count .seg').forEach(b => {
  b.onclick = () => {
    botGameSize = parseInt(b.dataset.n, 10) || 3;
    document.querySelectorAll('#bots-count .seg').forEach(x => x.classList.toggle('sel', x === b));
    $('bots-hint').textContent = `You + ${botGameSize - 1} bot${botGameSize > 2 ? 's' : ''} · fills instantly, plays immediately`;
  };
});
$('btn-start-bots').onclick = () => {
  playerName = ($('in-name').value || 'Player').trim().slice(0, 12) || 'Player';
  sessionStorage.setItem('as_name', playerName);
  if (pendingBotTotal) return;
  $('join-err').textContent = '';
  playerId = null;
  sessionStorage.removeItem('as_pid');
  pendingBotTotal = botGameSize;
  pendingBotAt = Date.now();
  sendLobby({ type: 'CREATE', name: playerName });
};
$('mode-last').onclick = () => send({ type: 'SET_MODE', mode: 'last_only' });
$('mode-classic').onclick = () => send({ type: 'SET_MODE', mode: 'classic' });
$('btn-leave1').onclick = () => { send({ type: 'LEAVE' }); roomCode = null; sessionStorage.removeItem('as_room'); show('join'); };
$('btn-exit').onclick = () => $('modal-exit').classList.remove('hidden');
$('btn-exit-no').onclick = () => $('modal-exit').classList.add('hidden');
$('btn-exit-yes').onclick = () => { $('modal-exit').classList.add('hidden'); send({ type: 'LEAVE' }); roomCode = null; sessionStorage.removeItem('as_room'); show('join'); };
// (modal-hippo is pointer-events:none in note mode so hover never traps;
// draw mode is tappable and dismissed by tap, timeout safety, or new states)
$('btn-leave2').onclick = () => { send({ type: 'LEAVE' }); $('modal-over').classList.add('hidden'); roomCode = null; sessionStorage.removeItem('as_room'); show('join'); };

// ---------- game actions ----------
$('btn-take').onclick = () => send({ type: 'TAKE_ORDER' });
attachNotePreview($('btn-ring'), bellNote);
$('btn-ring').onclick = () => {
  const face = (state.orders || []).filter(o => o.faceUp);
  const last = face[face.length - 1];
  const lastOnly = (state.ruleMode || 'last_only') === 'last_only';
  $('bell-preview').innerHTML = last && lastOnly
    ? `Judges only <b>${last.count}× ${last.animal}</b> (the newest order). Wrong call = <b>you</b> take the token.`
    : `Judges <b>every animal</b>. Wrong call = <b>you</b> take the token.`;
  $('modal-bell').classList.remove('hidden');
};
$('btn-bell-no').onclick = () => $('modal-bell').classList.add('hidden');
$('btn-bell-yes').onclick = () => {
  $('modal-bell').classList.add('hidden');
  bellSound();
  const b = $('btn-ring');
  b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
  send({ type: 'RING_BELL' });
};
$('btn-next').onclick = () => {
  // final round's audit leads to the winning message, not another round
  if (state && state.loserId) send({ type: 'RESULTS' });
  else send({ type: 'NEXT_ROUND' });
};
$('btn-audit-toggle').onclick = () => {
  const m = $('modal-reveal');
  m.classList.toggle('mini');
  $('btn-audit-toggle').textContent = m.classList.contains('mini') ? '▼' : '▲';
};
$('btn-restart').onclick = () => send({ type: 'RESTART' });
$('btn-confirm-half').onclick = () => {
  if (!drawnCard || drawnCard.hippo) return;
  if (selHalf == null) { toast('Tap half A or B first.'); return; }
  send({ type: 'CHOOSE_HALF', halfIndex: selHalf });
  closeDraw();
};
$('btn-flip-go').onclick = () => {
  if (selHippoIdx == null) return;
  send({ type: 'HIPPO_FLIP', orderIndex: selHippoIdx });
  drawnCard = null; selHippoIdx = null;
  $('flipbar').classList.add('hidden');
};
function closeDraw() { $('modal-draw').classList.add('hidden'); drawnCard = null; }

// ---------- draw modal (normal cards only; Hippos pick on the board) ----------
function openDrawModal() {
  if (!drawnCard || drawnCard.hippo) return;
  const halves = $('draw-halves');
  halves.innerHTML = '';
  $('draw-hippo-pick').classList.add('hidden');
  halves.classList.remove('hidden');
  $('draw-hint').textContent = 'Only the tapped half becomes an order. The other half is discarded.';
  $('draw-title').textContent = 'Your draw — pick ONE half';
  $('draw-card').innerHTML = '';
  const dt = ordersTallyLocal();
  $('draw-tally').innerHTML = ['toucan', 'fox', 'leopard', 'elephant'].map(a =>
    `<span class="dtchip">${window.AnimalArt.icon(a, 1, 20)}<b>${dt[a] || 0}</b></span>`).join('');
  // stocks snapshot for reference (read-only; nothing can change mid-pick)
  const ds = $('draw-stocks');
  ds.innerHTML = '';
  state.players.forEach(p => {
    const d = document.createElement('div');
    d.className = 'stock' + (p.id === state.youId ? ' me' : '');
    let body;
    if (p.id === state.youId) {
      body = `<div class="cd"><span class="ownhide">🙈</span></div>`;
    } else {
      const card = p.stockCardId ? state.cards[p.stockCardId] : null;
      body = cardHalvesHTML(card);
    }
    d.innerHTML = `<div class="nm">${escapeHtml(p.name)}${aiMark(p)}${p.id === state.youId ? ' (you)' : ''}</div>` + body + tokenChipsHTML(p);
    ds.appendChild(d);
  });
  if (state.dummyStockCardId && state.cards[state.dummyStockCardId]) {
    const d = document.createElement('div');
    d.className = 'stock';
    d.innerHTML = `<div class="nm">spare</div>` + cardHalvesHTML(state.cards[state.dummyStockCardId]);
    ds.appendChild(d);
  }
  // order board snapshot for reference (read-only; nothing moves mid-pick)
  renderOrdersInto($('draw-orders'), false);
  drawnCard.halves.forEach((h, i) => {
    const d = document.createElement('div');
    d.className = 'halfpick' + (selHalf === i ? ' sel' : '');
    d.innerHTML = `${window.AnimalArt.icon(h.animal, h.count, 64)}<div class="big">${i === 0 ? 'A' : 'B'} — ${h.count}× ${h.animal}</div>`;
    d.onclick = () => { selHalf = i; [...halves.children].forEach((c, k) => c.classList.toggle('sel', k === i)); };
    halves.appendChild(d);
  });
  $('modal-draw').classList.remove('hidden');
}

// ---------- render ----------
function nameOf(pid) {
  if (!state) return '?';
  const p = state.players.find(p => p.id === pid);
  return p ? p.name : '?';
}
function mySeat() { return state ? (state.players.find(p => p.id === state.youId) || {}).seat : -1; }
function activePlayer() { return state ? state.players.find(p => p.seat === state.activeSeat) : null; }
function isMyTurn() { return state && state.phase === 'playing' && !state.hasPendingDraw && mySeat() === state.activeSeat; }

function render() {
  if (!state) return;
  // a server-side auto-pick (timeout) resolves the pending draw for us:
  // drop the stale pick state and go back to the main board
  if (!state.hasPendingDraw && drawnCard) {
    drawnCard = null; selHalf = null; selHippoIdx = null;
    $('modal-draw').classList.add('hidden');
  }
  // a hover/touch note belongs to replaced DOM nodes — drop it on fresh state;
  // a draw note outlives states only while its pick is still pending
  if (hippoOverlayMode === 'note') hideHippo();
  else if (hippoOverlayMode === 'draw' && !state.hasPendingDraw) hideHippo();
  if (state.phase === 'playing' && state.round === 1 && !state.orders.length && !state.lastResolution) {
    lastRevealKey = ''; openGameOver._played = false; // fresh game — reset one-shot flags
  }
  if (state.phase === 'lobby') {
    show('lobby');
    lastDealKey = '';
    $('lobby-code').textContent = state.room;
    $('lobby-players').innerHTML = state.players.map(p =>
      `<div class="prow"><span>${p.id === state.hostId ? '👑 ' : ''}${escapeHtml(p.name)}${aiMark(p)}${p.id === state.youId ? ' (you)' : ''}</span><span class="toks">${connMark(p)}${scoreStr(p)}</span></div>`).join('');
    $('btn-start').style.display = state.youId === state.hostId ? '' : 'none';
    $('btn-start').disabled = state.players.length < 2;
    const isHost = state.youId === state.hostId;
    const lastOnly = (state.ruleMode || 'last_only') === 'last_only';
    $('mode-last').classList.toggle('sel', lastOnly);
    $('mode-classic').classList.toggle('sel', !lastOnly);
    $('mode-last').disabled = !isHost;
    $('mode-classic').disabled = !isHost;
    $('mode-note').textContent = isHost ? '(host sets)' : '(host only)';
    if (pendingBotTotal && state.players.length >= pendingBotTotal) {
      pendingBotTotal = 0;
      if (state.youId === state.hostId) send({ type: 'START' });
    }
    return;
  }
  show('game');
  $('hud-round').textContent = 'R' + state.round + ' · next ⚡' + state.nextTokenValue;
  $('hud-mode').textContent = (state.ruleMode || 'last_only') === 'last_only' ? 'LAST' : 'ALL';
  $('hud-mode').title = (state.ruleMode || 'last_only') === 'last_only'
    ? 'Bell checks only the last order\u2019s animal' : 'Bell checks every animal';
  $('hud-deck').textContent = '🂠 ' + state.deckCount;
  $('take-count').textContent = '🂠 ' + state.deckCount;

  // recover a pending draw lost to reload (DRAWN is only sent live once)
  if (state.phase === 'playing' && state.hasPendingDraw && !drawnCard
      && state.pendingDrawCardId && state.cards[state.pendingDrawCardId]) {
    drawnCard = state.cards[state.pendingDrawCardId];
    selHalf = null; selHippoIdx = null; hippoNapped = false;
    if (!drawnCard.hippo) openDrawModal();
  }
  // Hippo targets are chosen on the main board, not in a modal.
  const flipMode = !!(drawnCard && drawnCard.hippo && state.hasPendingDraw);

  // status line
  const ap = activePlayer();
  let status;
  if (state.phase === 'playing') {
    if (state.activeChoosing) status = ap && ap.id === state.youId ? 'You drew — choose…' : `${ap ? ap.name : '?'} is choosing…`;
    else if (ap && ap.id === state.youId && state.noRingFor === state.youId) status = 'YOUR turn — take an order (🔕 blocked by Hippo)';
    else status = ap && ap.id === state.youId ? 'YOUR turn — order or bell?' : `${ap ? ap.name : '?'}'s turn…`;
  } else if (state.phase === 'reveal') status = 'Manager has ruled!';
  else if (state.phase === 'gameOver') status = 'Game over!';
  $('hud-status').textContent = status || '';

  renderStocks(); renderOrders(flipMode); renderFlipbar(flipMode); renderButtons(); tickTimer();
  renderSideTally();
  // audit carries the stocks: hide the felt copies during the calculation
  $('table-wrap').classList.toggle('noboardstocks', state.phase === 'reveal');
  // fresh round => shuffle/deal animation (once per round, never blocks).
  // runs after renderStocks so the seat tiles exist to fly cards to.
  const roundKey = state.room + ':' + state.round + ':' + state.phase;
  if (state.phase === 'playing' && roundKey !== lastDealKey) {
    lastDealKey = roundKey;
    showDeal(state.round);
  }

  // reveal / gameover modals
  if (state.phase === 'reveal' && state.lastResolution) openReveal(false);
  else $('modal-reveal').classList.add('hidden');
  if (state.phase === 'gameOver') { lastDealKey = ''; openGameOver(); }
  else $('modal-over').classList.add('hidden');
}

function scoreStr(p) { return p.tokens && p.tokens.length ? p.tokens.join('+') + ' = ' + p.total : '0'; }
// token chips inside the player's own box: one graphic per token + total
function tokenChipsHTML(p) {
  if (!p.tokens || !p.tokens.length) return `<div class="tchips"></div>`;
  return `<div class="tchips">` + p.tokens.map(t => `<span class="tchip">⚡${t}</span>`).join('') +
    `<span class="ttotal">${p.total}</span></div>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function aiMark(p) { return (p && p.ai) ? ' 🤖' : ''; }
function aiMarkById(pid) { return state ? aiMark(state.players.find(p => p.id === pid)) : ''; }
function connMark(p) { return p.ai ? ' 🤖' : (p.connected ? '' : ' 📴'); }

function cardHalvesHTML(card, dimExcept, iconPx) {
  if (!card) return `<div class="cd">?</div>`;
  if (card.hippo) return `<div class="cd">${window.AnimalArt.shape('hippo', 40, card.hippo)}</div>`;
  const px = iconPx || 22;
  return `<div class="cd">` + card.halves.map(h =>
    `<span class="halfchip${dimExcept && !dimExcept.has(h.animal) ? ' dimhalf' : ''}">${window.AnimalArt.icon(h.animal, h.count, px)}</span>`).join('') + `</div>`;
}

const HIPPO_INFO = {
  bo:   { name: 'BO',   fx: 'Cancels every order showing exactly 3 animals at reveal.' },
  dozy: { name: 'DOZY', fx: 'Does nothing at reveal — pure bluff.' },
  pip:  { name: 'PIP',  fx: 'Cancels every Fox order at reveal.' },
};
let hippoHideT = 0, hippoOverlayMode = null, lastTouchT = 0;
let lastDealKey = '', dealHideT = 0, dealTextT = 0;
// shared hover/touch auto-preview for tap-targets (hippos, bell)
function attachNotePreview(el, showFn) {
  el.onmouseenter = () => {
    if (Date.now() - lastTouchT < 1200) return; // ignore emulated mouse
    clearTimeout(hippoHideT);
    showFn();
  };
  el.onmouseleave = () => { if (hippoOverlayMode === 'note') hideHippo(); };
  el.ontouchstart = () => {
    lastTouchT = Date.now();
    clearTimeout(hippoHideT);
    showFn();
  };
  el.ontouchend = () => {
    clearTimeout(hippoHideT);
    hippoHideT = setTimeout(hideHippo, 2000);
  };
}
function attachHippoNote(el, which) {
  el.classList.add('hippo');
  attachNotePreview(el, () => showHippo(which, '', 'note'));
}
function bellNote() {
  const blocked = state && state.noRingFor === state.youId;
  const by = state && state.noRingBy ? nameOf(state.noRingBy) : null;
  showNote({
    art: '<div style="font-size:110px;line-height:1">🔔</div>',
    title: blocked ? 'RING BLOCKED' : 'THE BELL',
    color: blocked ? '#FF3B5C' : '',
    body: blocked
      ? `${by || 'Someone'} just played a Hippo — you must take an order this turn. No ringing the flipper.`
      : 'Ring to accuse the table of overselling. A wrong call takes the token — and nobody may ring on the turn right after a Hippo.',
    sub: '',
  }, 'note');
}
let dealTimers = [];
function showDeal(n) {
  // phase 1 (~1s): the deck riffle-shuffles in the middle, seats stay empty;
  // phase 2: the shuffle group dissolves INTO flying cards, one per seat —
  // each seat tile appears as its card lands.
  const ov = $('modal-deal');
  ov.classList.remove('hidden');
  clearTimeout(dealHideT); clearTimeout(dealTextT);
  dealTimers.forEach(clearTimeout); dealTimers = [];
  const later = (fn, ms) => dealTimers.push(setTimeout(fn, ms));
  $('deal-text').textContent = 'Shuffling…';
  const dw = document.querySelector('#modal-deal .dealwrap');
  dw.classList.remove('spent');
  const fly = $('deal-fly');
  fly.innerHTML = '';
  const stocks = $('stocks');
  const tiles = [...stocks.querySelectorAll('.stock')];
  stocks.classList.add('dealing');
  const cx = window.innerWidth / 2, cy = window.innerHeight * 0.42;
  later(() => {
    if (ov.classList.contains('hidden')) return;
    $('deal-text').textContent = `Dealing round ${n}…`;
    dw.classList.add('spent');
    tiles.forEach((t, k) => {
      const r = t.getBoundingClientRect();
      if (!r.width) { t.classList.add('landed'); return; }
      const el = document.createElement('span');
      el.className = 'dealcard';
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      fly.appendChild(el);
      const dx = (r.left + r.width / 2) - cx;
      const dy = (r.top + r.height / 2) - cy;
      el.animate([
        { transform: 'translate(-50%,-50%) scale(.9)', opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.18 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.55)`, opacity: 0.95 },
      ], { duration: 600, delay: k * 130, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' });
      later(() => { t.classList.add('landed'); }, k * 130 + 600);
    });
  }, 1050);
  const total = tiles.length ? 1050 + tiles.length * 130 + 900 : 1300;
  dealHideT = setTimeout(() => {
    ov.classList.add('hidden');
    fly.innerHTML = '';
    stocks.classList.remove('dealing');
  }, total);
}
function showHippo(which, sub, mode) {
  const info = HIPPO_INFO[which];
  if (!info) return;
  showNote({
    art: window.AnimalArt.shape('hippo', 120, which),
    title: info.name,
    color: (window.HIPPO_COLORS[which] || {}).main || '',
    body: info.fx,
    sub: sub || '',
    bigSub: mode === 'draw',
  }, mode);
}
function showNote(o, mode) {
  $('hippo-art').innerHTML = o.art || '';
  $('hippo-name').textContent = o.title || '';
  $('hippo-name').style.color = o.color || '';
  $('hippo-fx').textContent = o.body || '';
  $('hippo-sub').textContent = o.sub || '';
  $('hippo-sub').classList.toggle('big', !!o.bigSub);
  const ov = $('modal-hippo');
  // draw mode stays until tapped (tappable); note mode stays pointer-clear
  // so hover never traps (flicker loop)
  ov.classList.toggle('tappable', mode === 'draw');
  ov.classList.remove('hidden');
  const sh = document.querySelector('#modal-hippo .sheet');
  sh.classList.remove('pop-in'); void sh.offsetWidth; sh.classList.add('pop-in');
  hippoOverlayMode = mode || 'note';
}
function hideHippo() {
  $('modal-hippo').classList.add('hidden');
  $('modal-hippo').classList.remove('tappable');
  hippoOverlayMode = null;
  clearTimeout(hippoHideT);
}
// a tap lands on the overlay only in draw mode — that tap dismisses it
$('modal-hippo').addEventListener('pointerup', () => {
  if (hippoOverlayMode === 'draw') hideHippo();
});

function renderStocks() {
  const el = $('stocks');
  el.innerHTML = '';
  state.players.forEach(p => {
    const d = document.createElement('div');
    d.className = 'stock' + (p.id === state.youId ? ' me' : '');
    let body;
    if (p.id === state.youId && state.phase === 'playing') {
      body = `<div class="cd"><span class="ownhide">🙈</span></div>`;
    } else {
      const card = p.stockCardId ? state.cards[p.stockCardId] : null;
      body = cardHalvesHTML(card);
    }
    d.innerHTML = `<div class="nm">${escapeHtml(p.name)}${aiMark(p)}${p.id === state.youId ? ' (you)' : ''}</div>` + body + tokenChipsHTML(p);
    const shown = p.id === state.youId && state.phase === 'playing'
      ? null : (p.stockCardId ? state.cards[p.stockCardId] : null);
    if (shown && shown.hippo) attachHippoNote(d, shown.hippo);
    el.appendChild(d);
  });
  if (state.dummyStockCardId && state.cards[state.dummyStockCardId]) {
    const d = document.createElement('div');
    d.className = 'stock';
    const dc = state.cards[state.dummyStockCardId];
    d.innerHTML = `<div class="nm">spare</div>` + cardHalvesHTML(dc);
    if (dc.hippo) attachHippoNote(d, dc.hippo);
    el.appendChild(d);
  }
}

function renderOrders(flipMode) {
  renderOrdersInto($('orders'), flipMode);
}

function renderOrdersInto(el, flipMode) {
  el.innerHTML = '';
  if (!state.orders.length && !(state.hippoDiscards || []).length) { el.innerHTML = `<div class="hint">No orders yet — first player must take one.</div>`; return; }
  // napped hippos (drawn onto an empty board): public icons on the first rows
  const usedHippos = new Set();
  state.orders.forEach(o => (o.flippedBy || []).forEach(id => usedHippos.add(id)));
  (state.hippoDiscards || []).forEach(id => {
    if (usedHippos.has(id)) return;
    const hc = state.cards[id];
    if (!hc || !hc.hippo) return;
    const d = document.createElement('div');
    d.className = 'orow naprow';
    d.innerHTML = `<div class="pick nap" title="napped hippo — no effect">${window.AnimalArt.shape('hippo', 30, hc.hippo)}</div>`;
    attachHippoNote(d.querySelector('.pick'), hc.hippo);
    el.appendChild(d);
  });
  const hippos = new Set((state.lastResolution && state.phase !== 'playing' ? state.lastResolution.stockHippos : stockHipposLocal()));
  // reveal audit: spotlight the judged animal's rows, dim everything else
  // (reveal only — the game-over sheet keeps its full veil)
  const res = state.phase === 'reveal' ? state.lastResolution : null;
  const judged = res
    ? new Set(res.ruleMode === 'classic' ? res.oversoldAnimals
                                         : (res.checkedAnimal ? [res.checkedAnimal] : []))
    : null;
  // newest round at the bottom: picked half full-size, unpicked half faded left
  state.orders.forEach((o, i) => {
    const row = document.createElement('div');
    let cancelledByStock = false;
    if (o.faceUp) {
      if (hippos.has('bo') && o.count === 3) cancelledByStock = true;
      if (hippos.has('pip') && o.animal === 'fox') cancelledByStock = true;
    }
    const dead = !o.faceUp || cancelledByStock;
    row.className = 'orow' + (dead && !(judged && judged.has(o.animal)) ? ' down' : '');
    if (judged) row.classList.add(judged.has(o.animal) ? 'judged' : 'dimmed');
    const liveHTML = `<div class="pick">${cancelledByStock ? '<span class="cancelled-tag">🦛✖</span>' : ''}${window.AnimalArt.icon(o.animal, o.count, 26)}${o.faceUp ? '' : '<div class="who">flipped 🦛</div>'}</div>`;
    const deadHTML = o.discarded
      ? `<div class="disc">${window.AnimalArt.icon(o.discarded.animal, o.discarded.count, 20)}</div>`
      : `<div class="disc empty"></div>`;
    // hippos that swapped this row park at its right side as markers
    const flips = o.flippedBy || [];
    const marks = flips.map(id => {
      const hc = state.cards[id];
      const key = hc && hc.hippo ? hc.hippo : null;
      const sib = key ? key.toUpperCase() : '';
      return `<span class="fmark" data-sib="${key || ''}" title="swapped by ${sib || 'hippo'}">${window.AnimalArt.shape('hippo', 24, key)}</span>`;
    }).join('');
    const marksHTML = marks ? `<div class="flipmarks">${marks}</div>` : '';
    // an odd number of swaps trades the halves' places: the live animal
    // glows on the left, the dead one shades on the right
    if (flips.length % 2 === 1 && o.discarded) {
      row.classList.add('swapped');
      row.innerHTML = liveHTML + deadHTML + marksHTML;
    } else {
      row.innerHTML = deadHTML + liveHTML + marksHTML;
    }
    if (flipMode && o.faceUp) {
      row.querySelector('.pick').onclick = () => {
        selHippoIdx = i;
        renderOrders(true);
        renderFlipbar(true);
      };
      row.classList.add('flipcand');
      if (selHippoIdx === i) row.classList.add('flipsel');
    }
    row.querySelectorAll('.fmark').forEach(mk => {
      if (mk.dataset.sib) attachHippoNote(mk, mk.dataset.sib);
    });
    el.appendChild(row);
  });
}

function renderSideTally() {
  const el = $('side-tally');
  if (!state || state.phase === 'lobby') { el.innerHTML = ''; return; }
  const t = ordersTallyLocal();
  const lastFace = [...(state.orders || [])].reverse().find(o => o.faceUp);
  const lastOnly = (state.ruleMode || 'last_only') === 'last_only';
  el.innerHTML = ['toucan', 'fox', 'leopard', 'elephant'].map(a =>
    `<div class="strow${lastOnly && lastFace && lastFace.animal === a ? ' live' : ''}" title="${a} ordered">${window.AnimalArt.icon(a, 1, 22)}<b>${t[a] || 0}</b></div>`).join('');
}

function renderFlipbar(flipMode) {
  const bar = $('flipbar');
  if (!flipMode) { bar.classList.add('hidden'); return; }
  const face = (state.orders || []).some(o => o.faceUp);
  if (!face) {
    // Hippo with an empty board naps: no effect, turn ends.
    bar.classList.add('hidden');
    if (!hippoNapped) {
      hippoNapped = true;
      toast('Hippo naps — no orders to flip.');
      send({ type: 'HIPPO_FLIP', orderIndex: null });
      drawnCard = null;
    }
    return;
  }
  bar.classList.remove('hidden');
  const sel = selHippoIdx != null ? state.orders[selHippoIdx] : null;
  const disc = sel && sel.discarded;
  $('flip-text').innerHTML = (sel && sel.faceUp && disc)
    ? `Swap <b>${sel.count}× ${sel.animal}</b> → <b>${disc.count}× ${disc.animal}</b>?`
    : `🦛 Tap an order on the board to swap its halves`;
  $('btn-flip-go').disabled = !(sel && sel.faceUp);
}

function stockHipposLocal() {
  const out = [];
  state.players.forEach(p => {
    if (p.id === state.youId && state.phase === 'playing') return; // own hidden — can't know
    const c = p.stockCardId && state.cards[p.stockCardId];
    if (c && c.hippo) out.push(c.hippo);
  });
  const dc = state.dummyStockCardId && state.cards[state.dummyStockCardId];
  if (dc && dc.hippo) out.push(dc.hippo);
  return out;
}

function ordersTallyLocal() {
  const t = { toucan: 0, fox: 0, leopard: 0, elephant: 0 };
  state.orders.forEach(o => { if (o.faceUp) t[o.animal] += o.count; });
  return t;
}
function renderButtons() {
  const mine = isMyTurn();
  const faceUp = (state.orders || []).some(o => o.faceUp);
  const blocked = state.noRingFor === state.youId;
  $('btn-take').disabled = !(mine && state.phase === 'playing');
  $('btn-ring').disabled = !(mine && state.phase === 'playing' && faceUp && !blocked);
}

// turn countdown frame: one bordered box tracing its target (active tile,
// whole table on your turn, draw sheet while picking), revealed through a
// rotating conic mask so it hugs rounded corners and drains gradually with
// its end pinned at the top-right corner. No bars anywhere.
setInterval(tickTimer, 50);
function tickTimer() {
  const ov = $('turnframe');
  if (!state || state.phase !== 'playing' || !state.turnDeadline) {
    ov.classList.add('hidden');
    return;
  }
  const left = state.turnDeadline - Date.now() / 1000;
  const frac = Math.max(0, Math.min(1, left / 15));
  let tel = null;
  if (!$('modal-draw').classList.contains('hidden') && state.hasPendingDraw) {
    tel = document.querySelector('#modal-draw .sheet');
  } else {
    const ap = activePlayer();
    if (!ap) { ov.classList.add('hidden'); return; }
    if (ap.id === state.youId) {
      tel = $('table-wrap');
    } else {
      const idx = state.players.findIndex(p => p.id === ap.id);
      tel = document.querySelectorAll('#stocks .stock')[idx] || null;
    }
  }
  if (!tel) { ov.classList.add('hidden'); return; }
  const r = tel.getBoundingClientRect();
  if (!r.width || !r.height) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  const pad = 5;
  const W = r.width + pad * 2, H = r.height + pad * 2;
  ov.style.left = (r.left - pad) + 'px';
  ov.style.top = (r.top - pad) + 'px';
  ov.style.width = W + 'px';
  ov.style.height = H + 'px';
  if (ov._tel !== tel) {
    ov._tel = tel;
    let br = 0;
    try { br = parseFloat(getComputedStyle(tel).borderTopLeftRadius) || 0; } catch (e) { br = 0; }
    ov._trad = br;
  }
  const svg = $('turnframe-svg');
  if (ov._vw !== W || ov._vh !== H) {
    ov._vw = W; ov._vh = H;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  }
  $('turnframe-path').setAttribute('d', framePathD(W, H, (ov._trad || 0) + pad, frac));
  const urgent = left < 5;
  ov.classList.toggle('urgent', urgent);
}

// Countdown path: walk the rounded rect clockwise from the top-right corner
// vertex, densifying corner arcs. Pure pixel math — identical everywhere.
function framePathD(W, H, R, frac) {
  const inset = 3; // centerline sits just inside the overlay edge
  const a = W / 2 - inset, b = H / 2 - inset;
  if (a <= 0 || b <= 0) return '';
  const r = Math.max(0, Math.min(R, a, b));
  const cx = W / 2, cy = H / 2;
  const P = (x, y) => [cx + x, cy + y];
  // features in clockwise order from the top-right corner vertex
  const feats = [];
  const edge = (x1, y1, x2, y2) => feats.push({ pts: [P(x1, y1), P(x2, y2)] });
  const arc = (qx, qy, a0, a1) => {
    const pts = [];
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.18));
    for (let k = 0; k <= steps; k++) {
      const t = a0 + (a1 - a0) * (k / steps);
      pts.push([cx + qx + r * Math.cos(t), cy + qy + r * Math.sin(t)]);
    }
    feats.push({ pts });
  };
  const D = Math.PI / 2;
  // pinned end = bottom of the top-right fillet; walk clockwise from there
  edge(a, -b + r, a, b - r);
  arc(a - r, b - r, 0, D);
  edge(a - r, b, -a + r, b);
  arc(-a + r, b - r, D, 2 * D);
  edge(-a, b - r, -a, -b + r);
  arc(-a + r, -b + r, 2 * D, 3 * D);
  edge(-a + r, -b, a - r, -b);
  arc(a - r, -b + r, 3 * D, 4 * D);
  const lens = feats.map(f => {
    let L = 0;
    for (let k = 1; k < f.pts.length; k++) {
      L += Math.hypot(f.pts[k][0] - f.pts[k - 1][0], f.pts[k][1] - f.pts[k - 1][1]);
    }
    return L;
  });
  const total = lens.reduce((s, x) => s + x, 0);
  let remain = Math.max(0, Math.min(1, frac)) * total;
  if (remain <= 0.5) return '';
  const out = ['M' + feats[0].pts[0][0].toFixed(1) + ' ' + feats[0].pts[0][1].toFixed(1)];
  for (let f = 0; f < feats.length && remain > 0; f++) {
    const pts = feats[f].pts;
    let used = 0;
    for (let k = 1; k < pts.length && remain > 0; k++) {
      const seg = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (used + seg <= remain) {
        out.push('L' + pts[k][0].toFixed(1) + ' ' + pts[k][1].toFixed(1));
        used += seg;
      } else {
        const t = seg > 0 ? (remain - used) / seg : 0;
        out.push('L' + (pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t).toFixed(1) +
                 ' ' + (pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t).toFixed(1));
        used = remain;
      }
    }
    remain -= used;
  }
  if (remain > 0) out.push('Z');
  return out.join('');
}

function openReveal(isNew) {
  const r = state.lastResolution;
  const key = state.room + state.round + JSON.stringify(r);
  const first = key !== lastRevealKey;
  lastRevealKey = key;
  const me = state.youId;
  const iAmRinger = r.ringerId === me;
  const iAmBlamed = r.blamedId === me;
  if (first) {
    if (iAmBlamed) gruntSound(); else bellSound();
    $('modal-reveal').classList.remove('mini');
    $('btn-audit-toggle').textContent = '▲';
  }
  // Viewer-aware headline: a ringer who caught bad orders gets a winner
  // message, not a scolding. The blamed player gets told plainly.
  let head, color = '#FF3B5C';
  if (r.oversold) {
    if (iAmRinger) { head = '🎉 You caught them!'; color = '#2E9E5B'; }
    else if (iAmBlamed) { head = '😡 Caught out!'; }
    else { head = `😡 Bad orders — ${nameOf(r.blamedId)} pays!`; }
  } else {
    if (iAmRinger) { head = '😡 False alarm!'; }
    else { head = `😡 ${nameOf(r.ringerId)} rang for nothing!`; }
  }
  $('rv-verdict').textContent = head;
  $('rv-verdict').style.color = color;
  // the audit shows everyone's revealed stocks (3 per row, full width);
  // the judged animal stays bright, every other half is dimmed
  const judgedAudit = r.ruleMode === 'classic'
    ? new Set(r.oversoldAnimals)
    : new Set(r.checkedAnimal ? [r.checkedAnimal] : []);
  const dim = judgedAudit.size ? judgedAudit : null;
  const tiles = state.players.map(p => {
    const card = p.stockCardId ? state.cards[p.stockCardId] : null;
    const hip = card && card.hippo ? ` data-hippo="${card.hippo}"` : '';
    return `<div class="stock"${hip}><div class="nm">${escapeHtml(p.name)}${aiMark(p)}${p.id === state.youId ? ' (you)' : ''}</div>` +
      cardHalvesHTML(card, dim, 16) + tokenChipsHTML(p) + `</div>`;
  });
  if (state.dummyStockCardId && state.cards[state.dummyStockCardId]) {
    const dc = state.cards[state.dummyStockCardId];
    const hip = dc.hippo ? ` data-hippo="${dc.hippo}"` : '';
    tiles.push(`<div class="stock"${hip}><div class="nm">spare</div>` +
      cardHalvesHTML(dc, dim, 16) + `</div>`);
  }
  $('rv-tally').innerHTML = `<div class="stocks audit">${tiles.join('')}</div>`;
  $('rv-tally').querySelectorAll('[data-hippo]').forEach(el =>
    attachHippoNote(el, el.dataset.hippo));
  const who = iAmBlamed ? '<b>You</b>' : `<b>${escapeHtml(nameOf(r.blamedId))}</b>${aiMarkById(r.blamedId)}`;
  const sub = r.oversold
    ? (iAmRinger ? 'Nice catch — no token for you.' : (iAmBlamed ? 'The orders were bad.' : r.verdict))
    : (iAmRinger ? 'The board was fine — the token is yours.' : r.verdict);
  const takes = `${who} take${iAmBlamed ? '' : 's'} token <b>${r.tokenGiven}</b>`;
  $('rv-blame').innerHTML = `${escapeHtml(sub)}<br>👉 ${takes}` +
    (state.loserId ? ` — game over!` : ` and start${iAmBlamed ? '' : 's'} next round`);
  $('btn-next').textContent = state.loserId ? 'See results →' : 'Next round →';
  $('modal-reveal').classList.remove('hidden');
}

function openGameOver() {
  const r = state.lastResolution;
  if (r && !openGameOver._played) { gruntSound(); openGameOver._played = true; }
  const sorted = [...state.players].sort((a, b) => a.total - b.total);
  $('over-title').textContent = `🏆 ${sorted.length ? sorted[0].name : '?'} wins!`;
  $('over-table').innerHTML = sorted.map(p =>
    `<div class="prow"><span>${state.winners.includes(p.id) ? '🏆 ' : ''}${state.loserId === p.id ? '😡 ' : ''}${escapeHtml(p.name)}</span><span class="toks">${scoreStr(p)}${state.loserId === p.id ? ' — LOSES' : ''}</span></div>`).join('') +
    `<p class="hint">First to 7+ loses · fewest wins. Credits: after <i>Durian</i> by Masato Uesugi (Oink Games) — original animals & art here.</p>`;
  $('modal-over').classList.remove('hidden');
}

let toastT = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------- boot ----------
paintBuildTag();
connect();
