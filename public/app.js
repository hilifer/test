import qrcode from 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.5.0/qrcode.mjs';

const CHUNK_SIZE = 64 * 1024;
const HIGH_WATERMARK = 4 * 1024 * 1024;
const LOW_WATERMARK = 512 * 1024;
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
};

const views = {
  home: $('view-home'),
  host: $('view-host'),
  guest: $('view-guest'),
};
function showView(name) {
  for (const [k, el] of Object.entries(views)) el.classList.toggle('hidden', k !== name);
}

let ws;
function openWs() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(e);
  });
}
function wsSend(msg) { ws.send(JSON.stringify(msg)); }

const guestMatch = location.pathname.match(/^\/r\/([A-Z0-9]{4})$/i);
if (guestMatch) startGuest(guestMatch[1].toUpperCase());
else startHome();

// Run network probe in parallel; never blocks UI
probeNat().then(renderBanner);

// ───────────────────────── NAT / NETWORK PROBE ─────────────────────────

function setBanner({ level, title, hint }) {
  const el = $('netBanner');
  if (!level) { el.classList.add('hidden'); return; }
  el.className = 'banner ' + level;
  el.innerHTML = `
    <span class="b-icon"></span>
    <div class="b-body">
      <div class="b-title"></div>
      <div class="b-hint"></div>
    </div>
  `;
  el.querySelector('.b-icon').textContent = { probing: '⟳', ok: '✓', warn: '!', error: '✕' }[level] || '·';
  el.querySelector('.b-title').textContent = title;
  el.querySelector('.b-hint').textContent = hint || '';
  el.classList.remove('hidden');
}

function renderBanner(result) {
  if (result.ok) {
    if (result.type === 'open') return setBanner(null);
    return setBanner({
      level: 'ok',
      title: '网络支持 P2P 直连',
      hint: result.type === 'nat' ? '检测到 NAT，但能正常打洞（cone NAT）。' : '本地网络可直连。',
    });
  }
  if (result.reason === 'symmetric') {
    setBanner({
      level: 'warn',
      title: '你的网络可能不支持纯 P2P（对称型 NAT）',
      hint: '常见于公司/校园/部分蜂窝网络。建议：① 换一个网络（家庭 WiFi、手机热点）后重试；② 让管理员部署 TURN 中继服务器后再来。当前仍可尝试，但传输可能失败。',
    });
  } else {
    setBanner({
      level: 'warn',
      title: '无法访问 STUN，P2P 可能受限',
      hint: '可能是网络被防火墙限制了 UDP 出站，或处于离线环境。建议换一个网络再试。',
    });
  }
}

async function probeNat(timeoutMs = 2500) {
  setBanner({ level: 'probing', title: '正在检测网络是否支持 P2P…' });
  try {
    const [candsA, candsB] = await Promise.all([
      gatherCandidates('stun:stun.l.google.com:19302', timeoutMs),
      gatherCandidates('stun:stun1.l.google.com:19302', timeoutMs),
    ]);
    const srflxA = candsA.find((c) => c.type === 'srflx');
    const srflxB = candsB.find((c) => c.type === 'srflx');
    const hostA = candsA.find((c) => c.type === 'host');

    if (!srflxA && !srflxB) {
      if (hostA) return { ok: true, type: 'lan' }; // no internet but local works (e.g. test env / pure LAN)
      return { ok: false, reason: 'stun_unreachable' };
    }
    if (srflxA && srflxB && srflxA.address === srflxB.address && srflxA.port !== srflxB.port) {
      return { ok: false, reason: 'symmetric' };
    }
    return { ok: true, type: srflxA ? 'nat' : 'open' };
  } catch (e) {
    console.warn('probeNat failed', e);
    return { ok: true, type: 'lan' }; // be lenient
  }
}

function gatherCandidates(stunUrl, timeoutMs) {
  return new Promise(async (resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: stunUrl }] });
    const cands = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) cands.push({ type: e.candidate.type, address: e.candidate.address, port: e.candidate.port });
      else { pc.close(); resolve(cands); }
    };
    pc.createDataChannel('probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    setTimeout(() => { try { pc.close(); } catch {} resolve(cands); }, timeoutMs);
  });
}

// ───────────────────────── HOME / HOST MODE ─────────────────────────

function startHome() {
  showView('home');
  const drop = $('drop');
  const fileInput = $('fileInput');
  $('pickBtn').onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files.length) becomeHost([...fileInput.files]); };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) becomeHost([...e.dataTransfer.files]);
  });
}

// ───────────────────────── HOST ─────────────────────────

const host = {
  files: new Map(), // fileId -> File
  nextFileId: 1,
  peers: new Map(), // peerId -> { pc, dc, sendQueue: [], sending: boolean }
};

async function becomeHost(initialFiles) {
  await openWs();
  ws.onmessage = (ev) => onHostMessage(JSON.parse(ev.data));
  wsSend({ type: 'create_room' });
  initialFiles.forEach(addHostFile);
  showView('host');

  $('copyBtn').onclick = () => {
    const inp = $('shareLink');
    inp.focus();
    inp.select();
    inp.setSelectionRange(0, inp.value.length);
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(inp.value);
        ok = true;
      }
    } catch {}
    if (!ok) {
      try { ok = document.execCommand('copy'); } catch {}
    }
    $('copyBtn').textContent = ok ? '已复制' : '请按 Ctrl+C';
    setTimeout(() => ($('copyBtn').textContent = '复制'), 1800);
  };
  $('addMoreBtn').onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    inp.onchange = () => [...inp.files].forEach(addHostFile);
    inp.click();
  };
  setHostStatus('就绪，等待他人打开链接', 'online');
}

function setHostStatus(text, cls) {
  $('hostStatusText').textContent = text;
  $('hostDot').className = 'dot' + (cls ? ' ' + cls : '');
}

function renderQr(url) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  // cellSize 5, margin 0 — outer CSS provides whitespace
  $('qrcode').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });
}

function fileIcon(name) {
  const ext = (name.split('.').pop() || '').slice(0, 4).toUpperCase();
  return ext || '·';
}

function addHostFile(file) {
  const id = String(host.nextFileId++);
  host.files.set(id, file);
  const li = document.createElement('li');
  li.className = 'file';
  li.dataset.id = id;
  li.innerHTML = `
    <div class="fi-icon"></div>
    <div class="fi-main">
      <div class="fi-name"></div>
      <div class="fi-meta"></div>
    </div>
  `;
  li.querySelector('.fi-icon').textContent = fileIcon(file.name);
  li.querySelector('.fi-name').textContent = file.name;
  li.querySelector('.fi-meta').textContent = fmtBytes(file.size);
  $('hostFiles').appendChild(li);

  // Broadcast updated list to existing peers
  for (const p of host.peers.values()) {
    if (p.dc && p.dc.readyState === 'open') sendList(p.dc);
  }
}

function currentFileList() {
  return [...host.files.entries()].map(([id, f]) => ({ id, name: f.name, size: f.size }));
}

function sendList(dc) {
  dc.send(JSON.stringify({ type: 'list', files: currentFileList() }));
}

function updatePeerCount() {
  $('peerCount').textContent = `在线 ${host.peers.size}`;
}

function onHostMessage(msg) {
  if (msg.type === 'room_created') {
    const url = `${location.origin}/r/${msg.code}`;
    $('shareLink').value = url;
    renderQr(url);
    history.replaceState(null, '', `/?host=${msg.code}`);
  } else if (msg.type === 'peer_joined') {
    addClientPeer(msg.peerId);
  } else if (msg.type === 'peer_left') {
    const p = host.peers.get(msg.peerId);
    if (p) { try { p.pc.close(); } catch {} host.peers.delete(msg.peerId); }
    updatePeerCount();
  } else if (msg.type === 'signal') {
    handleHostSignal(msg.from, msg.payload);
  }
}

async function addClientPeer(peerId) {
  const pc = new RTCPeerConnection(ICE);
  const dc = pc.createDataChannel('p2p');
  dc.binaryType = 'arraybuffer';
  const peer = { pc, dc, sending: false, queue: [] };
  host.peers.set(peerId, peer);
  updatePeerCount();
  setHostStatus(`已与 ${host.peers.size} 位访客连接`, 'connected');

  pc.onicecandidate = (ev) => {
    if (ev.candidate) wsSend({ type: 'signal', to: peerId, payload: { kind: 'ice', candidate: ev.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      host.peers.delete(peerId);
      updatePeerCount();
    }
  };
  dc.onopen = () => sendList(dc);
  dc.onmessage = (ev) => onHostChannelMessage(peer, peerId, ev.data);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: 'signal', to: peerId, payload: { kind: 'sdp', sdp: pc.localDescription } });
}

async function handleHostSignal(peerId, payload) {
  const peer = host.peers.get(peerId);
  if (!peer) return;
  if (payload.kind === 'sdp') {
    await peer.pc.setRemoteDescription(payload.sdp);
  } else if (payload.kind === 'ice') {
    try { await peer.pc.addIceCandidate(payload.candidate); } catch (e) { console.warn(e); }
  }
}

function onHostChannelMessage(peer, peerId, data) {
  if (typeof data !== 'string') return;
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.type === 'request') {
    peer.queue.push(msg.id);
    pumpQueue(peer);
  }
}

async function pumpQueue(peer) {
  if (peer.sending) return;
  peer.sending = true;
  while (peer.queue.length) {
    const fileId = peer.queue.shift();
    const file = host.files.get(fileId);
    if (!file) continue;
    await streamFile(peer.dc, fileId, file);
  }
  peer.sending = false;
}

async function streamFile(dc, fileId, file) {
  dc.bufferedAmountLowThreshold = LOW_WATERMARK;
  dc.send(JSON.stringify({ type: 'meta', id: fileId, name: file.name, size: file.size }));
  const reader = file.stream().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    let pos = 0;
    while (pos < value.byteLength) {
      const slice = value.buffer.slice(value.byteOffset + pos, value.byteOffset + Math.min(pos + CHUNK_SIZE, value.byteLength));
      if (dc.bufferedAmount > HIGH_WATERMARK) {
        await new Promise((r) => (dc.onbufferedamountlow = r));
      }
      dc.send(slice);
      pos += slice.byteLength;
    }
  }
  dc.send(JSON.stringify({ type: 'done', id: fileId }));
}

// ───────────────────────── GUEST ─────────────────────────

const guest = {
  pc: null,
  dc: null,
  current: null, // { id, name, size, received, chunks, entry }
  entriesById: new Map(), // fileId -> dom entry refs
};

async function startGuest(code) {
  showView('guest');
  setGuestStatus('连接信令…', '');
  await openWs();
  ws.onmessage = (ev) => onGuestMessage(JSON.parse(ev.data));
  wsSend({ type: 'join_room', code });
}

function setGuestStatus(text, cls) {
  $('guestStatusText').textContent = text;
  $('guestDot').className = 'dot' + (cls ? ' ' + cls : '');
}

function onGuestMessage(msg) {
  if (msg.type === 'joined') {
    setGuestStatus('等待分享者建立连接…', 'online');
    initGuestPc();
  } else if (msg.type === 'join_failed') {
    setGuestStatus(msg.error, 'error');
  } else if (msg.type === 'host_gone') {
    setGuestStatus('分享者已离开', 'error');
  } else if (msg.type === 'signal') {
    handleGuestSignal(msg.payload);
  }
}

function initGuestPc() {
  guest.pc = new RTCPeerConnection(ICE);
  guest.pc.onicecandidate = (ev) => {
    if (ev.candidate) wsSend({ type: 'signal', payload: { kind: 'ice', candidate: ev.candidate } });
  };
  guest.pc.ondatachannel = (ev) => bindGuestDc(ev.channel);
  guest.pc.onconnectionstatechange = () => {
    if (guest.pc.connectionState === 'connected') setGuestStatus('已与分享者建立 P2P', 'connected');
  };
}

function bindGuestDc(dc) {
  guest.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.onmessage = (ev) => onGuestChannelMessage(ev.data);
}

async function handleGuestSignal(payload) {
  if (payload.kind === 'sdp') {
    await guest.pc.setRemoteDescription(payload.sdp);
    if (payload.sdp.type === 'offer') {
      const answer = await guest.pc.createAnswer();
      await guest.pc.setLocalDescription(answer);
      wsSend({ type: 'signal', payload: { kind: 'sdp', sdp: guest.pc.localDescription } });
    }
  } else if (payload.kind === 'ice') {
    try { await guest.pc.addIceCandidate(payload.candidate); } catch (e) { console.warn(e); }
  }
}

function onGuestChannelMessage(data) {
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    if (msg.type === 'list') renderGuestList(msg.files);
    else if (msg.type === 'meta') {
      guest.current = { ...msg, received: 0, chunks: [], entry: guest.entriesById.get(msg.id) };
      if (guest.current.entry) guest.current.entry.start();
    } else if (msg.type === 'done') {
      if (guest.current) {
        const blob = new Blob(guest.current.chunks);
        const url = URL.createObjectURL(blob);
        guest.current.entry.finish(url);
      }
      guest.current = null;
    }
  } else if (guest.current) {
    guest.current.chunks.push(data);
    guest.current.received += data.byteLength;
    guest.current.entry.progress(guest.current.received);
  }
}

function renderGuestList(files) {
  const ul = $('guestFiles');
  $('guestEmpty')?.remove();
  // diff: add new files only
  for (const f of files) {
    if (guest.entriesById.has(f.id)) continue;
    const li = document.createElement('li');
    li.className = 'file';
    li.innerHTML = `
      <div class="fi-icon"></div>
      <div class="fi-main">
        <div class="fi-name"></div>
        <div class="fi-meta"></div>
        <div class="bar"><i></i></div>
      </div>
      <div class="fi-action"><button>下载</button></div>
    `;
    li.querySelector('.fi-icon').textContent = fileIcon(f.name);
    li.querySelector('.fi-name').textContent = f.name;
    li.querySelector('.fi-meta').textContent = fmtBytes(f.size);
    const btn = li.querySelector('button');
    const bar = li.querySelector('.bar > i');
    const entry = {
      el: li,
      start() { btn.disabled = true; btn.textContent = '接收中…'; },
      progress(n) {
        bar.style.width = Math.min(100, (n / f.size) * 100) + '%';
        li.querySelector('.fi-meta').textContent = `${fmtBytes(n)} / ${fmtBytes(f.size)}`;
      },
      finish(url) {
        li.classList.add('done');
        bar.style.width = '100%';
        li.querySelector('.fi-meta').textContent = fmtBytes(f.size);
        btn.disabled = false;
        btn.textContent = '保存';
        btn.classList.add('done');
        btn.onclick = () => {
          const a = document.createElement('a');
          a.href = url; a.download = f.name;
          document.body.appendChild(a); a.click(); a.remove();
        };
        // Auto-trigger first download
        btn.onclick();
      },
    };
    btn.onclick = () => {
      if (guest.dc?.readyState !== 'open') return;
      guest.dc.send(JSON.stringify({ type: 'request', id: f.id }));
    };
    guest.entriesById.set(f.id, entry);
    ul.appendChild(li);
  }
}
