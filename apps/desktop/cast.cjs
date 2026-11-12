// Envoi de la lecture vers un appareil Google Cast (Chromecast, Google TV, téléviseurs « Chromecast
// intégré », enceintes avec écran).
//
// Deux morceaux, sans dépendance externe :
//  - la découverte : une question mDNS « _googlecast._tcp.local » sur le réseau local ;
//  - le protocole Cast v2 : une connexion TLS au port 8009, des messages protobuf (CastMessage)
//    dont la charge utile est du JSON. On lance le récepteur multimédia par défaut de Google
//    (CC1AD845), qui lit le flux HLS ou MP4 que lui prépare le serveur Plex.
//
// La page ne fournit jamais d'adresse d'appareil : elle choisit un identifiant parmi ceux trouvés
// ici, et c'est ce module qui se connecte.
const dgram = require('node:dgram');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');

const MDNS = { address: '224.0.0.251', port: 5353 };
const SERVICE = '_googlecast._tcp.local';
const MEDIA_RECEIVER = 'CC1AD845';
const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};

// --- mDNS ---

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function query() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // une question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // PTR
  tail.writeUInt16BE(0x8001, 2); // IN, réponse directe demandée (bit « QU »)
  return Buffer.concat([header, encodeName(SERVICE), tail]);
}

/** Lit un nom DNS (avec compression) ; renvoie le nom et la position qui suit. */
function readName(buf, offset, depth = 0) {
  const labels = [];
  let pos = offset;
  let end = -1;
  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      pos++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (depth > 8 || pos + 1 >= buf.length) break;
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (end < 0) end = pos + 2;
      labels.push(readName(buf, ptr, depth + 1).name);
      pos = end;
      return { name: labels.filter(Boolean).join('.'), next: end };
    }
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), next: end >= 0 ? end : pos };
}

/** Réponses mDNS : enregistrements PTR, SRV, TXT et A, sans dépasser le paquet. */
function parseRecords(buf) {
  if (buf.length < 12) return [];
  const count = (o) => buf.readUInt16BE(o);
  const qd = count(4);
  const total = count(6) + count(8) + count(10);
  let pos = 12;
  for (let i = 0; i < qd && pos < buf.length; i++) pos = readName(buf, pos).next + 4;
  const out = [];
  for (let i = 0; i < total && pos + 10 <= buf.length; i++) {
    const { name, next } = readName(buf, pos);
    pos = next;
    if (pos + 10 > buf.length) break;
    const type = buf.readUInt16BE(pos);
    const len = buf.readUInt16BE(pos + 8);
    const data = pos + 10;
    pos = data + len;
    if (pos > buf.length) break;
    const rec = { name: name.toLowerCase(), type };
    if (type === 12) rec.ptr = readName(buf, data).name;
    else if (type === 33 && len >= 6) {
      rec.port = buf.readUInt16BE(data + 4);
      rec.target = readName(buf, data + 6).name.toLowerCase();
    } else if (type === 16) {
      rec.txt = {};
      for (let p = data; p < data + len; ) {
        const l = buf[p];
        const s = buf.toString('utf8', p + 1, p + 1 + l);
        const eq = s.indexOf('=');
        if (eq > 0) rec.txt[s.slice(0, eq)] = s.slice(eq + 1);
        p += 1 + l;
      }
    } else if (type === 1 && len === 4) rec.a = [...buf.subarray(data, data + 4)].join('.');
    out.push(rec);
  }
  return out;
}

/** Cherche les appareils Cast du réseau pendant `ms` millisecondes. */
function discover(ms = 2500) {
  return new Promise((resolve) => {
    const records = [];
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* déjà fermée */
      }
      resolve(assemble(records));
    };
    sock.on('error', (e) => {
      // Port 5353 indisponible : on écoute ailleurs, les réponses directes arrivent quand même.
      if (!done && !sock.retried && e.code === 'EADDRINUSE') return;
      finish();
    });
    sock.on('message', (msg, rinfo) => {
      try {
        for (const r of parseRecords(msg)) records.push({ ...r, from: rinfo.address });
      } catch {
        /* paquet illisible : ignoré */
      }
    });
    // Port 5353 et groupe multicast : certains appareils répondent au groupe plutôt qu'à nous seuls.
    const ready = () => {
      try {
        sock.setMulticastTTL(255);
        const q = query();
        sock.send(q, MDNS.port, MDNS.address);
        // Une seconde question : certains appareils ne répondent pas à la première.
        setTimeout(() => !done && sock.send(q, MDNS.port, MDNS.address), 700);
      } catch {
        finish();
      }
    };
    sock.once('listening', () => {
      try {
        sock.addMembership(MDNS.address);
      } catch {
        /* pas de multicast sur cette interface : les réponses directes suffisent */
      }
      ready();
    });
    try {
      sock.bind(MDNS.port);
    } catch {
      finish();
    }
    setTimeout(finish, ms);
  });
}

function assemble(records) {
  const devices = new Map();
  const by = (type, name) => records.find((r) => r.type === type && r.name === name);
  for (const ptr of records.filter((r) => r.type === 12 && r.name === SERVICE.toLowerCase())) {
    const instance = ptr.ptr.toLowerCase();
    const srv = by(33, instance);
    const txt = by(16, instance)?.txt ?? {};
    const a = srv ? by(1, srv.target) : undefined;
    const host = a?.a ?? ptr.from;
    const id = txt.id || instance;
    if (!host || devices.has(id)) continue;
    devices.set(id, {
      id,
      name: txt.fn || instance.split('.')[0],
      model: txt.md || '',
      host,
      port: srv?.port || 8009,
    });
  }
  return [...devices.values()];
}

// --- Protocole Cast v2 (CastMessage en protobuf, écrit et lu à la main) ---

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

const field = (num, wire) => varint((num << 3) | wire);
const str = (num, s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([field(num, 2), varint(b.length), b]);
};

function encodeMessage({ source, destination, namespace, data }) {
  const body = Buffer.concat([
    field(1, 0), varint(0), // protocol_version CASTV2_1_0
    str(2, source),
    str(3, destination),
    str(4, namespace),
    field(5, 0), varint(0), // payload_type STRING
    str(6, JSON.stringify(data)),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function decodeMessage(buf) {
  const out = {};
  let pos = 0;
  const readVarint = () => {
    let shift = 0;
    let v = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return v;
  };
  while (pos < buf.length) {
    const key = readVarint();
    const num = key >> 3;
    const wire = key & 7;
    if (wire === 0) out[num] = readVarint();
    else if (wire === 2) {
      const len = readVarint();
      out[num] = buf.subarray(pos, pos + len);
      pos += len;
    } else break;
  }
  const s = (n) => (out[n] ? out[n].toString('utf8') : '');
  let data = null;
  try {
    data = out[6] ? JSON.parse(s(6)) : null;
  } catch {
    data = null;
  }
  return { source: s(2), destination: s(3), namespace: s(4), data };
}

/**
 * Une séance de lecture sur un appareil : connexion, lancement du récepteur, chargement du
 * média, commandes. Émet « status » ({ state, time, duration, volume, muted }) et « closed ».
 */
class CastSession extends EventEmitter {
  constructor(device) {
    super();
    this.device = device;
    this.requestId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.transportId = null;
    this.appSessionId = null;
    this.mediaSessionId = null;
    this.status = { state: 'connecting', time: 0, duration: 0, volume: 1, muted: false };
  }

  connect() {
    return new Promise((resolve, reject) => {
      // Les appareils Cast présentent un certificat signé par Google pour leur propre appareil,
      // pas pour une adresse IP : la vérification habituelle ne peut pas aboutir.
      const sock = tls.connect({ host: this.device.host, port: this.device.port, rejectUnauthorized: false, timeout: 8000 });
      this.sock = sock;
      sock.once('secureConnect', () => {
        sock.setTimeout(0);
        this.send('receiver-0', NS.connection, { type: 'CONNECT' });
        this.heartbeat = setInterval(() => this.send('receiver-0', NS.heartbeat, { type: 'PING' }), 5000);
        resolve();
      });
      sock.once('timeout', () => {
        sock.destroy();
        reject(new Error('timeout'));
      });
      sock.on('error', (e) => {
        reject(e);
        this.close('error');
      });
      sock.on('close', () => this.close('closed'));
      sock.on('data', (chunk) => this.onData(chunk));
    });
  }

  send(destination, namespace, data) {
    if (!this.sock || this.sock.destroyed) return;
    this.sock.write(encodeMessage({ source: 'sender-0', destination, namespace, data }));
  }

  request(destination, namespace, data, timeout = 10000) {
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('timeout'));
      }, timeout);
      this.pending.set(requestId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.send(destination, namespace, { ...data, requestId });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (len > 1024 * 1024) return this.close('error');
      if (this.buffer.length < 4 + len) break;
      const msg = decodeMessage(this.buffer.subarray(4, 4 + len));
      this.buffer = this.buffer.subarray(4 + len);
      this.onMessage(msg);
    }
  }

  onMessage({ namespace, data, source }) {
    if (!data) return;
    if (namespace === NS.heartbeat && data.type === 'PING') return this.send(source, NS.heartbeat, { type: 'PONG' });
    if (namespace === NS.connection && data.type === 'CLOSE' && source === this.transportId) return this.close('stopped');
    const reply = this.pending.get(data.requestId);
    if (reply) {
      this.pending.delete(data.requestId);
      reply(data);
    }
    if (namespace === NS.receiver && data.type === 'RECEIVER_STATUS') {
      const vol = data.status?.volume;
      if (vol) this.update({ volume: Number(vol.level) || 0, muted: !!vol.muted });
      // Notre récepteur n'est plus là (quelqu'un a lancé autre chose sur l'appareil) : séance finie.
      const apps = data.status?.applications ?? [];
      if (this.appSessionId && !apps.some((a) => a.sessionId === this.appSessionId)) this.close('stopped');
    }
    if (namespace === NS.media && data.type === 'MEDIA_STATUS') {
      const st = data.status?.[0];
      if (!st) return;
      this.mediaSessionId = st.mediaSessionId ?? this.mediaSessionId;
      const states = { PLAYING: 'playing', PAUSED: 'paused', BUFFERING: 'buffering', IDLE: 'idle' };
      const patch = { state: states[st.playerState] ?? this.status.state, time: Number(st.currentTime) || 0 };
      if (st.media?.duration) patch.duration = Number(st.media.duration);
      if (st.playerState === 'IDLE' && st.idleReason) patch.ended = st.idleReason === 'FINISHED';
      if (st.idleReason === 'ERROR') patch.error = 'media';
      this.update(patch);
    }
  }

  update(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  /** Lance le récepteur multimédia et y charge le flux. */
  async load(media) {
    const st = await this.request('receiver-0', NS.receiver, { type: 'LAUNCH', appId: MEDIA_RECEIVER }, 20000);
    const app = (st.status?.applications ?? []).find((a) => a.appId === MEDIA_RECEIVER);
    if (!app) throw new Error(st.reason || 'launch-failed');
    this.transportId = app.transportId;
    this.appSessionId = app.sessionId;
    this.send(this.transportId, NS.connection, { type: 'CONNECT' });
    const res = await this.request(this.transportId, NS.media, {
      type: 'LOAD',
      autoplay: true,
      currentTime: media.start || 0,
      media: {
        contentId: media.url,
        contentType: media.contentType,
        streamType: 'BUFFERED',
        duration: media.duration || undefined,
        metadata: {
          metadataType: media.kind === 'episode' ? 2 : 1,
          title: media.title,
          subtitle: media.sub || undefined,
          seriesTitle: media.kind === 'episode' ? media.title : undefined,
          images: media.image ? [{ url: media.image }] : [],
        },
      },
    }, 30000);
    if (res.type === 'LOAD_FAILED' || res.type === 'LOAD_CANCELLED' || res.type === 'INVALID_REQUEST') throw new Error(res.type);
    this.poll = setInterval(() => this.mediaSessionId && this.send(this.transportId, NS.media, { type: 'GET_STATUS', mediaSessionId: this.mediaSessionId, requestId: this.requestId++ }), 1000);
  }

  control(action, value) {
    if (action === 'volume') return this.send('receiver-0', NS.receiver, { type: 'SET_VOLUME', volume: { level: Math.min(1, Math.max(0, Number(value) || 0)) }, requestId: this.requestId++ });
    if (action === 'mute') return this.send('receiver-0', NS.receiver, { type: 'SET_VOLUME', volume: { muted: !!value }, requestId: this.requestId++ });
    if (!this.transportId || this.mediaSessionId == null) return;
    const base = { mediaSessionId: this.mediaSessionId, requestId: this.requestId++ };
    if (action === 'play') this.send(this.transportId, NS.media, { ...base, type: 'PLAY' });
    else if (action === 'pause') this.send(this.transportId, NS.media, { ...base, type: 'PAUSE' });
    else if (action === 'seek') this.send(this.transportId, NS.media, { ...base, type: 'SEEK', currentTime: Math.max(0, Number(value) || 0) });
  }

  /** Arrête la lecture sur l'appareil et ferme la connexion. */
  async stop() {
    try {
      if (this.appSessionId) await this.request('receiver-0', NS.receiver, { type: 'STOP', sessionId: this.appSessionId }, 3000);
    } catch {
      /* l'appareil ne répond plus : on ferme quand même */
    }
    this.close('stopped');
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearInterval(this.poll);
    for (const reply of this.pending.values()) reply({ type: 'CLOSED' });
    this.pending.clear();
    try {
      this.send('receiver-0', NS.connection, { type: 'CLOSE' });
      this.sock?.end();
    } catch {
      /* déjà fermée */
    }
    this.emit('closed', reason);
  }
}

module.exports = { discover, CastSession, parseRecords, encodeMessage, decodeMessage };
