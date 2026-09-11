/* Animal Stock — mobile client: DOM UI + server intents, flat felt table. */
const APP_BUILD = 13; // bump with ?v= in index.html on every client change
let serverVer = 0;
function paintBuildTag() {
  const el = $('buildtag');
  if (el) el.textContent = `app v${APP_BUILD}` + (serverVer ? ` · server v${serverVer}` : '');
}
const $ = (id) => document.getElementById(id);
const screens = { splash: $('screen-splash'), join: $('screen-join'), code: $('screen-code'), lobby: $('screen-lobby'), game: $('screen-game') };
// Sheets that belong to a game in progress. #modal-reveal is display:block with
// a position:fixed sheet, so hiding the game screen alone leaves it on top of
// whatever comes next — the reveal used to follow you out to the join screen.
const GAME_OVERLAYS = ['modal-reveal', 'modal-over', 'modal-draw', 'modal-hippo',
                       'modal-bell', 'modal-exit'];
function closeGameOverlays() {
  GAME_OVERLAYS.forEach(id => $(id).classList.add('hidden'));
  $('modal-hippo').classList.remove('tappable');
  hippoOverlayMode = null;
}
function show(name) {
  if (name !== 'game') closeGameOverlays();
  for (const k in screens) screens[k].classList.toggle('active', k === name);
  // the table is a fixed canvas: the page itself must not scroll behind it,
  // or the turn frame ends up drawn over the HUD
  document.body.classList.toggle('in-game', name === 'game');
}

// splash: floating pink pig, tap to jump in
$('pig-splash').innerHTML = window.AnimalArt.shape('hippo', 180, 'bo');
$('code-hippo').innerHTML = window.AnimalArt.shape('hippo', 40, 'bo');
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
    if (walkOn) return;   // the walkthrough owns the screen right now
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
    const ce = $('code-err');
    if (ce && screens.code.classList.contains('active')) ce.textContent = m.message;
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
function joinWithCode() {
  playerName = ($('in-name').value || 'Player').trim().slice(0, 12) || 'Player';
  const code = ($('in-code').value || '').trim().toUpperCase();
  if (code.length !== 4) { $('code-err').textContent = 'Code is 4 characters.'; return; }
  sessionStorage.setItem('as_name', playerName);
  $('join-err').textContent = '';
  playerId = null; // fresh join unless server matches name? keep simple: fresh seat
  sessionStorage.removeItem('as_pid');
  roomCode = code; sessionStorage.setItem('as_room', code);
  sendLobby({ type: 'JOIN', room: code, name: playerName });
}
// entering a code gets its own screen rather than unfolding under the button
$('btn-join').onclick = () => {
  $('code-err').textContent = '';
  $('in-code').value = '';
  show('code');
  $('in-code').focus();
};
$('btn-code-go').onclick = () => joinWithCode();
$('btn-code-back').onclick = () => show('join');
$('in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinWithCode(); });
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
      <div class="stock"><div class="nm">Ann</div><div class="cd"><span class="halfchip">${ART.icon('toucan', 1, 20)}</span><span class="halfchip">${ART.icon('crocodile', 2, 20)}</span></div></div>
      <div class="stock"><div class="nm">Bo</div><div class="cd"><span class="halfchip">${ART.icon('zebra', 1, 20)}</span><span class="halfchip">${ART.icon('toucan', 2, 20)}</span></div></div>
      <div class="stock me"><div class="nm">You</div><div class="cd"><span style="font-size:40px">🙈</span></div></div>
    </div>` },
  { t: 'Take an order',
    b: 'On your turn tap <b>TAKE</b>: draw a card and pick <b>ONE half</b>. Only that half becomes an order — the other half is discarded.',
    mock: `<button class="takebtn" style="min-height:56px;font-size:17px"><span class="deckmini"></span><span>TAKE</span></button>
    <div class="halves">
      <div class="halfpick"><div>${ART.icon('toucan', 1, 44)}</div><div class="big">A — 1× toucan</div></div>
      <div class="halfpick"><div>${ART.icon('crocodile', 3, 44)}</div><div class="big">B — 3× crocodile</div></div>
    </div>` },
  { t: 'The order board',
    b: 'Picked halves pile up, newest at the bottom. The faded halves beside them are the discards — <b>they count for nothing</b>.',
    mock: `<div class="orow"><div class="disc">${ART.icon('crocodile', 3, 20)}</div><div class="pick">${ART.icon('toucan', 1, 26)}</div></div>
    <div class="orow"><div class="disc">${ART.icon('toucan', 2, 20)}</div><div class="pick">${ART.icon('zebra', 1, 26)}</div></div>` },
  { t: 'The running tally',
    b: 'Always-visible totals of face-up orders — your deduction aid. It <b>never includes hidden stocks</b>, so that part is up to you.',
    mock: `<div class="draw-tally"><span class="dtchip">${ART.icon('toucan', 1, 20)}<b>3</b></span><span class="dtchip">${ART.icon('zebra', 1, 20)}<b>2</b></span><span class="dtchip">${ART.icon('crocodile', 1, 20)}<b>0</b></span><span class="dtchip">${ART.icon('lion', 1, 20)}<b>1</b></span></div>` },
  { t: 'Ring the bell 🔔',
    b: 'On <b>YOUR turn only</b>, with at least 1 face-up order: accuse the table of overselling. Spot it on someone else\u2019s turn? You must wait for yours.',
    mock: `<div style="font-size:64px">🔔</div>` },
  { t: 'Only the last order is judged',
    b: 'The bell checks <b>just the newest order\u2019s animal</b> against stock. Everything older is history. (Hosts can switch to all-animals.)',
    mock: `<div class="orow"><div class="disc">${ART.icon('zebra', 1, 20)}</div><div class="pick">${ART.icon('toucan', 2, 26)}</div></div>
    <div class="orow demo-last"><div class="disc">${ART.icon('toucan', 1, 20)}</div><div class="pick">${ART.icon('zebra', 3, 26)}</div></div>` },
  { t: 'Who takes the token?',
    b: 'Oversold → whoever placed the <b>last order</b> takes the token. Board was fine → <b>you, the ringer</b>, take it. The token-taker starts next round.',
    mock: `<div class="tchips"><span class="tchip">⚡1</span><span class="tchip">⚡2</span><span class="ttotal">3</span></div>` },
  { t: 'Hippo drawn = swap',
    b: 'Drew a Hippo? Tap any face-up order to <b>swap its halves</b> — the unpicked side goes live. The Hippo parks beside that row. Empty board: it naps. Swapping can never blame you.',
    mock: `<div class="orow"><div class="pick">${ART.icon('crocodile', 3, 26)}</div><div class="disc">${ART.icon('toucan', 1, 20)}</div><div class="flipmarks"><span class="fmark">${ART.shape('hippo', 24, 'bo')}</span></div></div>` },
  { t: 'Hippos hiding in stocks',
    b: 'Revealed only when the bell rings: <b>BO</b> (red) cancels all 3-counts · <b>PIP</b> (purple) cancels all Zebra · <b>DOZY</b> (grey) naps. Tap any Hippo in-game to re-read this.',
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
// the picture tour has no button on the join screen any more; it stays
// reachable through the ?tour=N hook only
const tourBtn = document.getElementById('btn-tour');
if (tourBtn) tourBtn.onclick = () => openTour();
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
$('btn-leave1').onclick = () => { send({ type: 'LEAVE' }); roomCode = null; sessionStorage.removeItem('as_room'); show('join'); };
$('btn-exit').onclick = () => $('modal-exit').classList.remove('hidden');
$('btn-exit-no').onclick = () => $('modal-exit').classList.add('hidden');
$('btn-exit-yes').onclick = () => { $('modal-exit').classList.add('hidden'); send({ type: 'LEAVE' }); roomCode = null; sessionStorage.removeItem('as_room'); show('join'); };
// (modal-hippo is pointer-events:none in note mode so hover never traps;
// draw mode is tappable and dismissed by tap, timeout safety, or new states)
$('btn-leave2').onclick = () => { send({ type: 'LEAVE' }); $('modal-over').classList.add('hidden'); roomCode = null; sessionStorage.removeItem('as_room'); show('join'); };

// ---------- game actions ----------
$('btn-take').onclick = () => send({ type: 'TAKE_ORDER' });
$('btn-ring').onclick = () => {
  if (state && state.noRingFor === state.youId) { bellNote(); return; }
  const face = (state.orders || []).filter(o => o.faceUp);
  const last = face[face.length - 1];
  $('bell-preview').innerHTML = last
    ? `Judges only <b>${last.count}× ${last.animal}</b> (the newest order). Wrong call = <b>you</b> take the token.`
    : `No orders yet — take one first.`;
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
  $('draw-tally').innerHTML = ['toucan', 'zebra', 'crocodile', 'lion'].map(a =>
    `<span class="dtchip">${window.AnimalArt.icon(a, 1, 20)}<b>${dt[a] || 0}</b></span>`).join('');
  // stocks snapshot for reference (read-only; nothing can change mid-pick)
  const ds = $('draw-stocks');
  ds.innerHTML = '';
  state.players.forEach(p => {
    const d = document.createElement('div');
    d.className = 'stock' + (p.id === state.youId ? ' me' : '');
    let body;
    if (p.id === state.youId) {
      body = `<div class="cd"><span class="ownhide">${window.AnimalArt.shape('monkey', 46)}</span></div>`;
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
    // empty token row keeps the spare's halves on the same line as everyone's
    d.innerHTML = `<div class="nm">spare</div>` + cardHalvesHTML(state.cards[state.dummyStockCardId]) +
      `<div class="tchips"></div>`;
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
  // A Hippo note stays up across state updates: it used to be torn down by the
  // next player's draw, which is exactly when someone is still reading it.
  // A draw note still closes once its own pick is resolved.
  if (hippoOverlayMode === 'draw' && !state.hasPendingDraw) hideHippo();
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
    if (pendingBotTotal && state.players.length >= pendingBotTotal) {
      pendingBotTotal = 0;
      if (state.youId === state.hostId) send({ type: 'START' });
    }
    return;
  }
  show('game');
  $('hud-round').textContent = 'R' + state.round + ' · next ⚡' + state.nextTokenValue;
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
    `<span class="halfchip${dimExcept ? (dimExcept.has(h.animal) ? ' judgedhalf' : ' dimhalf') : ''}">${window.AnimalArt.icon(h.animal, h.count, px)}</span>`).join('') + `</div>`;
}

const HIPPO_INFO = {
  bo:   { name: 'BO',   fx: 'Cancels every order showing exactly 3 animals at reveal.' },
  dozy: { name: 'DOZY', fx: 'Does nothing at reveal — pure bluff.' },
  pip:  { name: 'PIP',  fx: 'Cancels every Zebra order at reveal.' },
};
let hippoHideT = 0, hippoOverlayMode = null, lastTouchT = 0, hippoShowT = 0;
// how long the cursor has to rest on a Hippo before its note opens —
// without it, brushing past one on the way elsewhere pops the note
const NOTE_HOVER_DELAY = 500;
let lastDealKey = '', dealHideT = 0, dealTextT = 0;
// shared hover/touch auto-preview for tap-targets (hippos, bell)
function attachNotePreview(el, showFn) {
  el.onmouseenter = () => {
    if (Date.now() - lastTouchT < 1200) return; // ignore emulated mouse
    clearTimeout(hippoHideT);
    clearTimeout(hippoShowT);
    hippoShowT = setTimeout(showFn, NOTE_HOVER_DELAY);
  };
  el.onmouseleave = () => {
    clearTimeout(hippoShowT);
    if (hippoOverlayMode === 'note') hideHippo();
  };
  el.ontouchstart = () => {
    lastTouchT = Date.now();
    clearTimeout(hippoHideT);
    clearTimeout(hippoShowT);
    showFn();                 // a tap is deliberate: no waiting
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
// Only ever shown when someone tries to ring on a hippo-blocked turn. A normal
// turn gets no note at all — the bell just opens its confirm dialog.
function bellNote() {
  const by = state && state.noRingBy ? nameOf(state.noRingBy) : null;
  showNote({
    art: window.AnimalArt.shape('bell', 110),
    title: 'RING BLOCKED',
    color: '#FF3B5C',
    body: `${by || 'Someone'} just played a Hippo. You must take an order this turn — the bell unlocks again next turn.`,
    sub: 'Tap anywhere to go back',
  }, 'tapnote');
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
  ov.classList.toggle('tappable', mode === 'draw' || mode === 'tapnote');
  ov.classList.remove('hidden');
  const sh = document.querySelector('#modal-hippo .sheet');
  sh.classList.remove('pop-in'); void sh.offsetWidth; sh.classList.add('pop-in');
  hippoOverlayMode = mode || 'note';
}
function hideHippo() {
  clearTimeout(hippoShowT);
  $('modal-hippo').classList.add('hidden');
  $('modal-hippo').classList.remove('tappable');
  hippoOverlayMode = null;
  clearTimeout(hippoHideT);
}
// Draw notes and click-opened notes ("tapnote") own the screen, so a tap
// anywhere dismisses them. Hover notes stay pointer-transparent: an overlay
// under the cursor would fire mouseleave on the thing being hovered and
// flicker open/shut.
$('modal-hippo').addEventListener('pointerup', () => {
  if (hippoOverlayMode === 'draw' || hippoOverlayMode === 'tapnote') hideHippo();
});

function renderStocks() {
  const el = $('stocks');
  el.innerHTML = '';
  state.players.forEach(p => {
    const d = document.createElement('div');
    d.className = 'stock' + (p.id === state.youId ? ' me' : '');
    let body;
    if (p.id === state.youId && state.phase === 'playing') {
      body = `<div class="cd"><span class="ownhide">${window.AnimalArt.shape('monkey', 46)}</span></div>`;
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
    d.innerHTML = `<div class="nm">spare</div>` + cardHalvesHTML(dc) + `<div class="tchips"></div>`;
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
  const judged = res ? new Set(res.checkedAnimal ? [res.checkedAnimal] : []) : null;
  // newest round at the bottom: picked half full-size, unpicked half faded left
  state.orders.forEach((o, i) => {
    const row = document.createElement('div');
    let cancelledByStock = false;
    if (o.faceUp) {
      if (hippos.has('bo') && o.count === 3) cancelledByStock = true;
      if (hippos.has('pip') && o.animal === 'zebra') cancelledByStock = true;
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
  el.innerHTML = ['toucan', 'zebra', 'crocodile', 'lion'].map(a =>
    `<div class="strow${lastFace && lastFace.animal === a ? ' live' : ''}" title="${a} ordered">${window.AnimalArt.icon(a, 1, 22)}<b>${t[a] || 0}</b></div>`).join('');
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
  const t = { toucan: 0, zebra: 0, crocodile: 0, lion: 0 };
  state.orders.forEach(o => { if (o.faceUp) t[o.animal] += o.count; });
  return t;
}
function renderButtons() {
  const mine = isMyTurn();
  const faceUp = (state.orders || []).some(o => o.faceUp);
  const blocked = state.noRingFor === state.youId;
  $('btn-take').disabled = !(mine && state.phase === 'playing');
  // A hippo block is not the same as "you cannot ring right now": it is a rule
  // worth explaining. Leave the button live but shaded, so tapping it says why.
  $('btn-ring').disabled = !(mine && state.phase === 'playing' && faceUp);
  $('btn-ring').classList.toggle('blocked', !!(blocked && mine && state.phase === 'playing'));
}

// turn countdown frame: one bordered box tracing its target (active tile,
// whole table on your turn, draw sheet while picking), revealed through a
// rotating conic mask so it hugs rounded corners and drains gradually with
// its end pinned at the top-right corner. No bars anywhere.
// One turn's clock, in seconds — mirrors TURN_SECONDS/CHOOSE_SECONDS in
// server.py. Only drives the countdown ring's fill; the server owns the
// real deadline, so a mismatch is cosmetic.
const TURN_WINDOW = 30;
setInterval(tickTimer, 50);
// a 50ms poll cannot keep a fixed-position frame glued to a scrolling target —
// it lags a frame behind and visibly judders. Repaint on the scroll itself.
window.addEventListener('scroll', () => tickTimer(), { passive: true });
window.addEventListener('resize', () => tickTimer());
function tickTimer() {
  const ov = $('turnframe');
  if (!state || state.phase !== 'playing' || !state.turnDeadline) {
    ov.classList.add('hidden');
    return;
  }
  const left = state.turnDeadline - Date.now() / 1000;
  // A round's first deadline has the dealing animation baked into it, so more
  // than a full turn's worth of time left means the cards are still flying.
  // Framing a seat mid-deal drew a box around a tile that was not there yet.
  if (left > TURN_WINDOW + 0.15) { ov.classList.add('hidden'); return; }
  const frac = Math.max(0, Math.min(1, left / TURN_WINDOW));
  let tel = null;
  const pd = !$('modal-draw').classList.contains('hidden') && state.hasPendingDraw;
  const ap = activePlayer();
  if (pd) {
    tel = document.querySelector('#modal-draw .sheet');
  } else {
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
  // the frame is position:fixed, so once its target scrolls off it would hang
  // over whatever is there instead — the HUD, usually
  if (r.bottom < 8 || r.top > window.innerHeight - 8) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  const pad = 5;
  // whole pixels: sub-pixel rects made the frame shimmer as the page scrolled
  const W = Math.round(r.width) + pad * 2, H = Math.round(r.height) + pad * 2;
  ov.style.left = Math.round(r.left - pad) + 'px';
  ov.style.top = Math.round(r.top - pad) + 'px';
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
  // The ring is NOT redrawn per tick any more. Re-cutting the path from JS
  // capped its smoothness at the tick rate, and any throttling turned the
  // drain into ~1/second steps of ~100px — it sat still, then jumped. Instead
  // the full lap is drawn once per turn and the browser interpolates
  // stroke-dashoffset over the remaining time, so it drains continuously
  // however often (or rarely) this function runs.
  const path = $('turnframe-path');
  const key = `${pd ? 'draw' : (ap ? ap.id : '-')}|${W}x${H}|${state.turnDeadline}`;
  if (ov._key !== key) {
    ov._key = key;
    path.setAttribute('d', framePathD(W, H, (ov._trad || 0) + pad, 1));
    const L = path.getTotalLength();
    // dasharray L + offset D shows the first (L - D) of the lap, so D runs
    // 0 -> L as the turn burns down
    path.style.transition = 'none';
    path.style.strokeDasharray = L;
    path.style.strokeDashoffset = L * (1 - Math.max(0, Math.min(1, frac)));
    void path.getBoundingClientRect();          // flush before re-arming
    path.style.transition = `stroke-dashoffset ${Math.max(0, left).toFixed(2)}s linear`;
    path.style.strokeDashoffset = L;
  }
  ov.classList.toggle('urgent', left < 5);
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
  // Deliberately never closed with 'Z'. At frac ~1 the remainder lands on a
  // floating-point knife edge, so the ring flickered between a closed loop and
  // an open one — read as "it sits still, then the line suddenly cuts". A full
  // lap already returns to its start, so leaving it open looks identical and
  // drains continuously from the first frame.
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
  const judgedAudit = new Set(r.checkedAnimal ? [r.checkedAnimal] : []);
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
      cardHalvesHTML(dc, dim, 16) + `<div class="tchips"></div></div>`);
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

// ---------- guided walkthrough: one whole round, on the real board ----------
// Nothing here is a mock-up. It feeds a scripted state into the real renderer
// and points at the live elements, so the walkthrough cannot drift out of sync
// with the game it explains. Every number below is a legal deal: the cards all
// exist in DECK_CONFIG and the verdict is what shared/game_logic.py would rule.
const W_CARDS = {
  wAnn: { id: 'wAnn', halves: [{ animal: 'toucan', count: 1 }, { animal: 'crocodile', count: 2 }] },
  wBo: { id: 'wBo', halves: [{ animal: 'zebra', count: 1 }, { animal: 'toucan', count: 3 }] },
  wYou: { id: 'wYou', hippo: 'dozy' },
  w1: { id: 'w1', halves: [{ animal: 'toucan', count: 1 }, { animal: 'zebra', count: 2 }] },
  w2: { id: 'w2', halves: [{ animal: 'crocodile', count: 1 }, { animal: 'toucan', count: 3 }] },
  w3: { id: 'w3', hippo: 'bo' },
  w4: { id: 'w4', halves: [{ animal: 'lion', count: 1 }, { animal: 'toucan', count: 2 }] },
  w5: { id: 'w5', halves: [{ animal: 'toucan', count: 1 }, { animal: 'zebra', count: 3 }] },
};
function wBase() {
  const mk = (id, name, seat, card) => ({
    id, name, seat, stockCardId: card, tokens: [], total: 0,
    connected: true, ai: false,
  });
  return {
    room: 'DEMO', phase: 'playing', round: 1, nextTokenValue: 1, deckCount: 28,
    players: [mk('ann', 'Ann', 0, 'wAnn'), mk('bo', 'Bo', 1, 'wBo'), mk('you', 'You', 2, 'wYou')],
    hostId: 'ann', youId: 'you', activeSeat: 2,
    cards: JSON.parse(JSON.stringify(W_CARDS)),
    orders: [], hippoDiscards: [], dummyStockCardId: null,
    lastOrderBy: null, lastResolution: null, turnDeadline: null,
    hasPendingDraw: false, pendingDrawCardId: null, activeChoosing: false,
    noRingFor: null, noRingBy: null, winners: [], loserId: null,
  };
}
// place an order exactly the way the server's _append_order does
function wPlace(s, cardId, half, by) {
  const c = s.cards[cardId], pick = c.halves[half], other = c.halves[1 - half];
  s.orders.push({
    cardId, halfIndex: half, faceUp: true, placedBy: by,
    animal: pick.animal, count: pick.count,
    discarded: { animal: other.animal, count: other.count }, flippedBy: [],
  });
  s.lastOrderBy = by;
  s.deckCount -= 1;
}
// ...and swap one exactly the way apply_hippo_swap does
function wSwap(s, idx, hippoId) {
  const o = s.orders[idx], kept = { animal: o.animal, count: o.count };
  o.animal = o.discarded.animal;
  o.count = o.discarded.count;
  o.discarded = kept;
  o.flippedBy = (o.flippedBy || []).concat([hippoId]);
  s.hippoDiscards.push(hippoId);
  s.deckCount -= 1;
}
const W_SIBS = '<div class="walk-sibs">' + ['bo', 'pip', 'dozy']
  .map(h => '<div>' + ART.shape('hippo', 46, h) + '<div>' + h.toUpperCase() + '</div></div>')
  .join('') + '</div>';

const WALK = [
  {
    t: 'One round, start to finish',
    b: 'Three players, one round, start to finish. You are the bottom card.',
    sel: '#table-wrap',
  },
  {
    t: 'What everyone is holding',
    b: 'One <b>stock</b> card each, and <b>both halves count</b>. Ann: 1 toucan + 2 crocodiles. Bo: 1 zebra + 3 toucans. That is the whole supply.',
    sel: '#stocks',
  },
  {
    t: 'Except yours',
    b: 'Yours is face-down <b>to you only</b>. Ann and Bo can both see it.',
    sel: '.stock.me',
  },
  {
    t: 'Your turn: two choices',
    b: '<b>TAKE</b> a card and promise something, or ring the <b>bell</b> to accuse the table. Your turn only.',
    sel: '#btn-take',
  },
  {
    t: 'Pick ONE half',
    b: 'Only the half you tap becomes a promise. Bo already shows a zebra, so take the <b>2 zebra</b>.',
    sel: '#draw-halves',
    run: (s) => { s.hasPendingDraw = true; s.pendingDrawCardId = 'w1'; s.activeChoosing = true; },
  },
  {
    t: 'Your promise lands',
    b: 'The <b>faded half is the discard</b> — it counts for nothing. You have promised 2 zebra.',
    sel: '#orders',
    run: (s) => {
      s.hasPendingDraw = false; s.pendingDrawCardId = null; s.activeChoosing = false;
      wPlace(s, 'w1', 1, 'you');
      s.activeSeat = 0;
    },
  },
  {
    t: 'The running tally',
    b: 'How many of each animal are <b>promised</b>. Stock is never counted here — that part is your job.',
    sel: '#side-tally',
  },
  {
    t: 'Ann goes big',
    b: 'Ann promises <b>3 toucans</b>. Common animal, fair bet — but the board is filling up.',
    sel: '#orders',
    run: (s) => { wPlace(s, 'w2', 1, 'ann'); s.activeSeat = 1; },
  },
  {
    t: 'Bo draws a Hippo 🦛',
    b: 'A drawn Hippo <b>swaps a row’s halves</b>. Bo aims it at your row: <b>2 zebra becomes 1 toucan</b>.',
    sel: '#orders',
    run: (s) => { wSwap(s, 0, 'w3'); s.activeSeat = 2; s.noRingFor = 'you'; s.noRingBy = 'bo'; },
  },
  {
    t: 'The bell is locked',
    b: 'No ringing on the turn after a Hippo — you must take. Flipping never gets Bo blamed.',
    sel: '#btn-ring',
  },
  {
    t: 'So you take, quietly',
    b: 'You promise <b>1 lion</b> — the rarest animal, only ten in the deck. Small, but a real gamble.',
    sel: '#orders',
    run: (s) => { wPlace(s, 'w4', 0, 'you'); s.activeSeat = 0; s.noRingFor = null; s.noRingBy = null; },
  },
  {
    t: 'Ann overreaches',
    b: 'Ann promises <b>3 zebra</b>. The bell judges the <b>newest order’s animal</b> and nothing else, so zebra is all that matters now.',
    sel: '#side-tally',
    run: (s) => { wPlace(s, 'w5', 1, 'ann'); s.activeSeat = 2; },
  },
  {
    t: 'Now count it',
    b: 'Zebra promised: <b>3</b>. Zebra you can see: <b>1</b>. The rest would have to be on your own hidden card.',
    sel: '#stocks',
  },
  {
    t: 'Ring it 🔔',
    b: 'The bell is unlocked again. You think Ann promised zebra that do not exist — call her.',
    sel: '#btn-ring',
  },
  {
    t: 'Everything flips',
    b: 'Yours was <b>DOZY</b> — a Hippo holds <b>no animals</b>, so you added nothing all round.',
    sel: '#modal-reveal .sheet',
    run: (s) => {
      s.phase = 'reveal';
      s.lastResolution = {
        oversold: true, oversoldAnimals: ['zebra'], checkedAnimal: 'zebra',
        stockTally: { toucan: 4, zebra: 1, crocodile: 2, lion: 0 },
        ordersTally: { toucan: 4, zebra: 3, crocodile: 0, lion: 1 },
        blamedId: 'ann', ringerId: 'you', tokenGiven: 1,
        verdict: 'MANAGER IS FURIOUS — the orders were bad',
        stockHippos: ['dozy'], gameOver: null,
      };
    },
  },
  {
    t: 'Good call — Ann pays',
    b: '3 promised against <b>1</b> in stock. The <b>last player to promise</b> takes the token — Ann. She starts the next round.',
    // the verdict line lives inside the scrollable sheet, so anchor to the
    // sheet itself: scrolling a sub-element out from under the ring looks broken
    sel: '#modal-reveal .sheet',
    run: (s) => {
      s.phase = 'reveal';
      s.lastResolution = {
        oversold: true, oversoldAnimals: ['zebra'], checkedAnimal: 'zebra',
        stockTally: { toucan: 4, zebra: 1, crocodile: 2, lion: 0 },
        ordersTally: { toucan: 4, zebra: 3, crocodile: 0, lion: 1 },
        blamedId: 'ann', ringerId: 'you', tokenGiven: 1,
        verdict: 'MANAGER IS FURIOUS — the orders were bad',
        stockHippos: ['dozy'], gameOver: null,
      };
      s.players[0].tokens = [1];
      s.players[0].total = 1;
      s.nextTokenValue = 2;
    },
  },
  {
    t: 'The other two Hippos',
    b: 'Only from someone’s <b>stock</b>, revealed at the bell: <b>BO</b> cancels every <b>3</b>-count, <b>PIP</b> cancels every <b>zebra</b>, Dozy naps.' + W_SIBS,
    sel: null,
  },
  {
    t: 'That is a round',
    b: 'Tokens climb 1, 2, 3… reach <b>7 and you lose</b>. <b>Fewest points wins.</b>',
    sel: null,
  },
];

let walkOn = false, walkIdx = 0, walkPrevState = null, walkPrevScreen = 'join';
const W_MODALS = ['modal-draw', 'modal-reveal', 'modal-hippo', 'modal-over', 'modal-bell'];

function walkStart() {
  walkPrevState = state;
  // remember where we came from: a stale state from a finished game would
  // otherwise drop the player back onto that dead board when the tour ends
  walkPrevScreen = Object.keys(screens).find(k => screens[k].classList.contains('active')) || 'join';
  walkOn = true;
  $('walk').classList.remove('hidden');
  show('game');
  walkGo(0);
}
function walkEnd() {
  walkOn = false;
  $('walk').classList.add('hidden');
  W_MODALS.forEach(id => $(id).classList.add('hidden'));
  drawnCard = null; selHalf = null; selHippoIdx = null;
  lastRevealKey = ''; lastDealKey = '';
  state = walkPrevState;
  if (walkPrevScreen === 'game' && state) render();
  else show(walkPrevScreen);
}
function walkGo(i) {
  walkIdx = Math.max(0, Math.min(WALK.length - 1, i));
  // rebuilt from step 0 every time, so stepping backwards is always exact
  const s = wBase();
  for (let k = 0; k <= walkIdx; k++) if (WALK[k].run) WALK[k].run(s);
  W_MODALS.forEach(id => $(id).classList.add('hidden'));
  drawnCard = null; selHalf = null; selHippoIdx = null;
  lastRevealKey = '';                                    // let the sheet reopen
  state = s;
  lastDealKey = s.room + ':' + s.round + ':' + s.phase;   // no deal animation
  render();
  const step = WALK[walkIdx];
  $('walk-title').textContent = step.t;
  $('walk-body').innerHTML = step.b;
  $('walk-count').textContent = 'STEP ' + (walkIdx + 1) + ' / ' + WALK.length;
  $('walk-dots').innerHTML = WALK.map((_, k) =>
    '<span class="wdot' + (k === walkIdx ? ' on' : '') + '"></span>').join('');
  $('walk-prev').disabled = walkIdx === 0;
  $('walk-next').textContent = walkIdx === WALK.length - 1 ? 'Play →' : 'Next ›';
  const el = step.sel ? document.querySelector(step.sel) : null;
  if (el) el.scrollIntoView({ block: 'center' });
  // paint straight away so the note never flashes in the wrong place, then
  // again next frame to settle any reflow. Not rAF-only: a backgrounded tab
  // never fires it, and the walkthrough would sit there unpositioned.
  walkPaint(step);
  requestAnimationFrame(() => walkPaint(step));
}
// spotlight the live element, then hang the note off it
function walkPaint(step) {
  const wrap = $('walk'), ring = $('walk-ring'), note = $('walk-note'), caret = $('walk-caret');
  const el = step.sel ? document.querySelector(step.sel) : null;
  wrap.classList.toggle('nospot', !el);
  note.classList.remove('above', 'below');
  const vw = window.innerWidth, vh = window.innerHeight;
  const nw = note.offsetWidth, nh = note.offsetHeight;
  if (!el) {
    caret.style.display = 'none';
    note.style.left = Math.round((vw - nw) / 2) + 'px';
    note.style.top = Math.round((vh - nh) / 2) + 'px';
    return;
  }
  const r = el.getBoundingClientRect();
  ring.style.left = (r.left - 6) + 'px';
  ring.style.top = (r.top - 6) + 'px';
  ring.style.width = (r.width + 12) + 'px';
  ring.style.height = (r.height + 12) + 'px';
  // A target taller than about half the screen (the whole table, say) has no
  // room for a note beside it: pin the note to the foot of the screen and drop
  // the caret, rather than clamping it on top of what it is describing.
  const tall = r.height > vh * 0.55;
  let top;
  if (!tall && r.bottom + 14 + nh <= vh - 8) {
    note.classList.add('below');
    top = r.bottom + 14;
  } else if (!tall && r.top - 14 - nh >= 8) {
    note.classList.add('above');
    top = r.top - 14 - nh;
  } else {
    top = vh - nh - 12;
  }
  const anchored = note.classList.contains('above') || note.classList.contains('below');
  const left = anchored
    ? Math.max(10, Math.min(Math.round(r.left + r.width / 2 - nw / 2), vw - nw - 10))
    : Math.round((vw - nw) / 2);
  note.style.left = left + 'px';
  note.style.top = Math.round(top) + 'px';
  caret.style.display = anchored ? '' : 'none';
  if (anchored) {
    caret.style.left = Math.max(12, Math.min(r.left + r.width / 2 - left - 10, nw - 32)) + 'px';
  }
}

$('btn-walk').onclick = () => walkStart();
$('walk-x').onclick = () => walkEnd();
$('walk-prev').onclick = () => walkGo(walkIdx - 1);
$('walk-next').onclick = () => {
  if (walkIdx === WALK.length - 1) walkEnd(); else walkGo(walkIdx + 1);
};
$('walk-shield').onclick = () => { if (walkIdx < WALK.length - 1) walkGo(walkIdx + 1); };
window.addEventListener('keydown', (e) => {
  if (!walkOn) return;
  if (e.key === 'ArrowRight' || e.key === ' ') walkGo(walkIdx + 1);
  else if (e.key === 'ArrowLeft') walkGo(walkIdx - 1);
  else if (e.key === 'Escape') walkEnd();
});
window.addEventListener('resize', () => { if (walkOn) walkPaint(WALK[walkIdx]); });
// test hook (?walk=6): jump straight to a step
try {
  const wi = parseInt(new URLSearchParams(location.search).get('walk') || '', 10);
  if (!isNaN(wi)) { walkStart(); walkGo(wi); }
} catch (e) { }

// ---------- boot ----------
$('btn-ring').innerHTML = window.AnimalArt.shape('bell', 44);
paintBuildTag();
connect();
