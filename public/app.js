const CHUNK_SIZE = 64 * 1024;
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const $ = (id) => document.getElementById(id);
const myIdEl = $('myId');
const dot = $('dot');
const statusText = $('statusText');
const peerInput = $('peerInput');
const connectBtn = $('connectBtn');
const drop = $('drop');
const fileInput = $('fileInput');
const pickBtn = $('pickBtn');
const logEl = $('log');

let ws;
let myId = null;
let pc = null;
let dc = null;
let remoteId = null;
let isInitiator = false;
let incoming = null;

function setStatus(text, cls) {
  statusText.textContent = text;
  dot.className = 'dot' + (cls ? ' ' + cls : '');
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function addLogEntry({ name, size, direction }) {
  const li = document.createElement('li');
  li.className = direction;
  li.innerHTML = `
    <div class="name"></div>
    <div class="meta"></div>
    <div class="bar"><i></i></div>
  `;
  li.querySelector('.name').textContent = name;
  li.querySelector('.meta').textContent = fmtBytes(size);
  logEl.prepend(li);
  return {
    update(received) {
      const pct = Math.min(100, (received / size) * 100);
      li.querySelector('i').style.width = pct + '%';
      li.querySelector('.meta').textContent = `${fmtBytes(received)} / ${fmtBytes(size)}`;
    },
    done(blobUrl) {
      li.classList.add('done');
      li.querySelector('i').style.width = '100%';
      li.querySelector('.meta').textContent = fmtBytes(size);
      if (blobUrl) {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = name;
        a.textContent = '下载';
        a.className = 'download';
        li.querySelector('.meta').appendChild(a);
      }
    },
  };
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setStatus('已连接信令服务器', 'online');
  ws.onclose = () => setStatus('信令断开', 'error');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') {
      myId = msg.id;
      myIdEl.textContent = myId;
    } else if (msg.type === 'signal') {
      handleSignal(msg.from, msg.payload);
    } else if (msg.type === 'error') {
      setStatus(msg.error, 'error');
    }
  };
}

function signal(to, payload) {
  ws.send(JSON.stringify({ type: 'signal', to, payload }));
}

function newPeerConnection() {
  pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = (ev) => {
    if (ev.candidate && remoteId) {
      signal(remoteId, { kind: 'ice', candidate: ev.candidate });
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus(`已与 ${remoteId} 建立 P2P`, 'connected');
    else if (pc.connectionState === 'failed') setStatus('P2P 连接失败', 'error');
  };
  pc.ondatachannel = (ev) => bindDataChannel(ev.channel);
}

function bindDataChannel(channel) {
  dc = channel;
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    setStatus(`已与 ${remoteId} 建立 P2P`, 'connected');
    drop.classList.remove('disabled');
  };
  dc.onclose = () => setStatus('数据通道关闭', 'error');
  dc.onmessage = (ev) => onChannelMessage(ev.data);
}

function onChannelMessage(data) {
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    if (msg.type === 'meta') {
      incoming = {
        name: msg.name,
        size: msg.size,
        received: 0,
        chunks: [],
        entry: addLogEntry({ name: msg.name, size: msg.size, direction: 'recv' }),
      };
    } else if (msg.type === 'done') {
      const blob = new Blob(incoming.chunks);
      const url = URL.createObjectURL(blob);
      incoming.entry.done(url);
      incoming = null;
    }
  } else {
    incoming.chunks.push(data);
    incoming.received += data.byteLength;
    incoming.entry.update(incoming.received);
  }
}

async function startCall(targetId) {
  remoteId = targetId;
  isInitiator = true;
  newPeerConnection();
  const channel = pc.createDataChannel('file');
  bindDataChannel(channel);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signal(remoteId, { kind: 'sdp', sdp: pc.localDescription });
  setStatus(`呼叫 ${remoteId}…`, 'online');
}

async function handleSignal(from, payload) {
  if (!pc) {
    remoteId = from;
    newPeerConnection();
  }
  if (payload.kind === 'sdp') {
    await pc.setRemoteDescription(payload.sdp);
    if (payload.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signal(from, { kind: 'sdp', sdp: pc.localDescription });
    }
  } else if (payload.kind === 'ice') {
    try { await pc.addIceCandidate(payload.candidate); } catch (e) { console.warn(e); }
  }
}

async function sendFile(file) {
  if (!dc || dc.readyState !== 'open') {
    setStatus('请先连接对方', 'error');
    return;
  }
  const entry = addLogEntry({ name: file.name, size: file.size, direction: 'send' });
  dc.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size }));
  let offset = 0;
  const reader = file.stream().getReader();
  dc.bufferedAmountLowThreshold = 512 * 1024;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    let buf = value.buffer;
    let pos = 0;
    while (pos < buf.byteLength) {
      const slice = buf.slice(pos, pos + CHUNK_SIZE);
      while (dc.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise((r) => (dc.onbufferedamountlow = r));
      }
      dc.send(slice);
      pos += slice.byteLength;
      offset += slice.byteLength;
      entry.update(offset);
    }
  }
  dc.send(JSON.stringify({ type: 'done' }));
  entry.done(null);
}

// UI events
connectBtn.onclick = () => {
  const id = peerInput.value.trim().toUpperCase();
  if (!id || id.length !== 4) {
    setStatus('请输入 4 位 ID', 'error');
    return;
  }
  if (id === myId) {
    setStatus('不能连接自己', 'error');
    return;
  }
  startCall(id);
};
peerInput.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

pickBtn.onclick = () => fileInput.click();
fileInput.onchange = () => { if (fileInput.files[0]) sendFile(fileInput.files[0]); };
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  if (e.dataTransfer.files[0]) sendFile(e.dataTransfer.files[0]);
});

connectWs();
