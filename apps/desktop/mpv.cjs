// Lecteur natif : lance mpv dans la fenêtre de l'application et le pilote par
// son canal JSON (tube nommé). mpv lit le fichier d'origine tel quel — HEVC,
// AV1, HDR, Dolby Vision, DTS, TrueHD, sous-titres ASS et PGS — sans aucune
// conversion par le serveur.
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const { existsSync } = fs;
const net = require('node:net');
const path = require('node:path');

/** Propriétés suivies en continu ; chaque changement est transmis à l'interface. */
const OBSERVED = ['time-pos', 'duration', 'pause', 'paused-for-cache', 'aid', 'sid', 'eof-reached', 'volume', 'mute', 'speed', 'track-list', 'chapter-list', 'demuxer-cache-time', 'current-ao', 'container-fps', 'audio-device', 'audio-out-params'];

/**
 * Transmission du son à un ampli : du plus riche au plus simple. Quand la sortie refuse
 * une étape, on passe à la suivante au lieu de tout abandonner d'un coup :
 *   1. tous les formats bruts (Dolby TrueHD / Atmos, DTS-HD, Dolby Digital Plus…) ;
 *   2. sans les formats haute définition (liaisons ARC ou optiques) : le cœur DTS passe encore ;
 *   3. Dolby Digital et DTS seulement ;
 *   4. plus de son brut : son décodé, envoyé en multicanal (mode exclusif) ;
 *   5. son décodé en mode partagé, comme n'importe quelle application.
 */
const AUDIO_STAGES = [
  { spdif: 'ac3,eac3,dts-hd,truehd', exclusive: true },
  { spdif: 'ac3,eac3,dts', exclusive: true },
  { spdif: 'ac3,dts', exclusive: true },
  { spdif: '', exclusive: true },
  { spdif: '', exclusive: false },
];

/** Sorties audio du système, dans l'ordre où mpv les essaie. */
const NATIVE_AO = process.platform === 'win32' ? 'wasapi' : process.platform === 'darwin' ? 'coreaudio' : 'pipewire,pulse,alsa';

/** Les sorties audio que mpv voit sur cette machine : [{ id, label }]. */
function listAudioDevices(app) {
  const exe = findMpv(app);
  if (!exe) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(exe, ['--no-config', '--audio-device=help'], { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (_err, stdout) => {
      const devices = [];
      for (const line of String(stdout ?? '').split(/\r?\n/)) {
        const m = /^\s*'([^']+)'\s+\((.*)\)\s*$/.exec(line);
        // Seules les vraies sorties (« wasapi/… », « coreaudio/… ») ; « auto » est proposé à part.
        if (m && m[1].includes('/') && /^[\w./{}:@-]{1,200}$/.test(m[1])) devices.push({ id: m[1], label: m[2] });
      }
      resolve(devices);
    });
  });
}

function findMpv(app) {
  const exe = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  const candidates = [
    process.env.MULTIPLEX_MPV,
    app.isPackaged ? path.join(process.resourcesPath, 'mpv', exe) : path.join(__dirname, 'vendor', 'mpv', exe),
  ].filter(Boolean);
  // À défaut de mpv embarqué (Linux, macOS), celui du système.
  return candidates.find((p) => existsSync(p)) ?? (process.platform === 'win32' ? null : 'mpv');
}

class MpvPlayer {
  constructor(app, win, emit) {
    this.app = app;
    this.win = win;
    this.emit = emit;
    this.proc = null;
    this.sock = null;
    this.state = {};
    this.requests = new Map();
    this.nextId = 1;
    this.session = 0;
  }

  available() {
    return !!findMpv(this.app);
  }

  /**
   * opts : url, title, start (secondes), aid / sid (rang de la piste dans le
   * fichier, 0 = aucune), subFiles (URL de sous-titres externes), passthrough.
   */
  async play(opts) {
    await this.stop();
    const exe = findMpv(this.app);
    if (!exe) throw new Error('mpv introuvable');
    const session = ++this.session;
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\multiplex-mpv-${process.pid}-${session}` : path.join(this.app.getPath('temp'), `multiplex-mpv-${process.pid}-${session}.sock`);
    // Identifiant natif de la fenêtre : mpv y crée sa surface de rendu.
    const handle = this.win.getNativeWindowHandle();
    const wid = handle.length === 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString();

    const args = [
      `--wid=${wid}`,
      `--input-ipc-server=${pipe}`,
      '--no-terminal',
      '--no-config',
      // mpv démarre à vide : le fichier et le jeton lui sont donnés ensuite par son canal
      // privé, pour qu'ils n'apparaissent pas dans la ligne de commande du processus.
      '--idle=yes',
      '--keep-open=no',
      '--force-window=immediate',
      // Pas de commandes mpv à l'écran : celles de MultiPlex sont dessinées par une
      // fenêtre transparente posée par-dessus la vidéo (voir main.cjs).
      '--osc=no',
      '--osd-bar=no',
      '--osd-level=0',
      '--input-default-bindings=yes',
      '--input-vo-keyboard=yes',
      // Rendu : libplacebo sur Direct3D 11, décodage matériel quand il est sûr.
      '--vo=gpu-next',
      '--hwdec=auto-safe',
      // HDR : signale à l'écran l'espace colorimétrique de la source (HDR10, HLG) ;
      // sur un écran SDR, mpv fait lui-même la conversion des tons, Dolby Vision compris.
      '--target-colorspace-hint=yes',
      '--audio-channels=auto-safe',
      '--sub-auto=no',
      '--volume-max=150',
      '--save-position-on-quit=no',
      `--force-media-title=${opts.title ?? 'MultiPlex'}`,
      // Échap et Retour quittent la lecture et rendent la main à l'interface.
      `--input-conf=${path.join(__dirname, 'mpv-input.conf').replace('app.asar', 'app.asar.unpacked')}`,
    ];
    // Transmission du flux audio brut à un ampli ou une barre de son (Dolby, DTS, Atmos).
    // Si la sortie refuse ce flux (casque, écran, enceintes), mpv se fige en cherchant son
    // propre repli : on lui donne donc une sortie muette de secours, et dès qu'il s'y rabat
    // on repasse au son décodé (voir onMessage). La lecture démarre dans tous les cas.
    this.spdif = !!opts.passthrough;
    this.stage = 0;
    // Le mode exclusif donne la main à MultiPlex sur la sortie : c'est ce qui permet le son brut,
    // et le multicanal décodé (5.1, 7.1) même si Windows est réglé en stéréo.
    if (this.spdif) args.push(`--audio-spdif=${AUDIO_STAGES[0].spdif}`, '--audio-exclusive=yes', '--audio-channels=auto', `--ao=${NATIVE_AO},null`);
    // Sortie audio choisie dans les réglages ; sinon celle du système.
    if (opts.audioDevice) args.push(`--audio-device=${opts.audioDevice}`);
    // Tests automatiques : aucun son.
    if (this.muted) args.push('--mute=yes');

    this.state = {};
    const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
    this.proc = proc;
    proc.on('error', (e) => session === this.session && this.emit('error', { message: e.message }));
    proc.on('exit', (code) => {
      if (session !== this.session) return;
      this.proc = null;
      this.sock?.destroy();
      this.sock = null;
      this.emit('ended', { code, time: this.state['time-pos'] ?? 0, duration: this.state.duration ?? 0, eof: !!this.state['eof-reached'] || this.reachedEnd });
    });
    this.reachedEnd = false;
    this.stepping = false;
    this.loaded = false;
    this.enteredFullscreen = false;
    await this.connect(pipe, session);
    for (const [i, name] of OBSERVED.entries()) this.send(['observe_property', i + 1, name]);
    // Le jeton part en en-tête HTTP : l'adresse affichée par mpv (statistiques, titre) reste propre.
    if (opts.headers?.length) await this.send(['set_property', 'http-header-fields', opts.headers]);
    const options = { start: String(Math.max(0, Number(opts.start) || 0)) };
    if (opts.aid !== undefined) options.aid = opts.aid > 0 ? String(opts.aid) : 'no';
    if (opts.sid !== undefined) options.sid = opts.sid > 0 ? String(opts.sid) : 'no';
    if (opts.buffered) {
      // Flux converti par le serveur, parfois à peine plus vite que la lecture : après un
      // arrêt, on attend d'avoir quelques secondes d'avance plutôt que de repartir aussitôt
      // et de s'arrêter de nouveau (moins d'interruptions, plus espacées).
      options['cache-pause-wait'] = '6';
      options['cache-pause-initial'] = 'yes';
      options['demuxer-readahead-secs'] = '60';
    }
    if (opts.subFiles?.length) options['sub-files'] = opts.subFiles.join(process.platform === 'win32' ? ';' : ':');
    this.loaded = true;
    await this.send({ name: 'loadfile', url: opts.url, flags: 'replace', options });
    return { ok: true };
  }

  connect(pipe, session) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        if (session !== this.session || !this.proc) return reject(new Error('mpv s’est arrêté au démarrage'));
        const sock = net.connect(pipe);
        sock.once('connect', () => {
          this.sock = sock;
          let buf = '';
          sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (line) this.onMessage(line);
            }
          });
          sock.on('error', () => {});
          resolve();
        });
        sock.once('error', () => {
          sock.destroy();
          // Le tube n'existe qu'une fois mpv initialisé : on réessaie brièvement.
          if (++tries > 60) reject(new Error('mpv ne répond pas'));
          else setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  onMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.request_id && this.requests.has(msg.request_id)) {
      const { resolve } = this.requests.get(msg.request_id);
      this.requests.delete(msg.request_id);
      resolve(msg.error === 'success' ? msg.data : undefined);
      return;
    }
    if (msg.event === 'property-change') {
      this.state[msg.name] = msg.data;
      if (msg.name === 'eof-reached' && msg.data) this.reachedEnd = true;
      // Sortie de secours muette : la sortie réelle a refusé ce qu'on lui proposait.
      if (msg.name === 'current-ao' && msg.data === 'null' && this.spdif) void this.nextAudioStage();
      this.emit('state', { name: msg.name, value: msg.data });
    } else if (msg.event === 'end-file' && this.loaded) {
      // Démarré à vide, mpv resterait ouvert sur un écran noir : on le ferme à la fin du fichier.
      if (msg.reason === 'eof') this.reachedEnd = true;
      if (msg.reason === 'error') this.emit('error', { message: `Lecture impossible (${msg.file_error ?? 'erreur'})` });
      else void this.send(['quit']);
    }
  }

  /** Passe à l'étape de transmission suivante, jusqu'à ce que la sortie réelle accepte. */
  async nextAudioStage() {
    if (this.stepping) return;
    this.stepping = true;
    const session = this.session;
    while (session === this.session && this.stage < AUDIO_STAGES.length - 1) {
      const from = AUDIO_STAGES[this.stage];
      const to = AUDIO_STAGES[++this.stage];
      if (to.spdif !== from.spdif) await this.send(['set_property', 'audio-spdif', to.spdif]);
      if (to.exclusive !== from.exclusive) await this.send(['set_property', 'audio-exclusive', to.exclusive]);
      await this.send(['ao-reload']);
      // On laisse la sortie se rouvrir, puis on regarde si elle a accepté.
      await new Promise((r) => setTimeout(r, 700));
      if (session !== this.session) break;
      if ((await this.send(['get_property', 'current-ao'])) !== 'null') break;
    }
    if (session === this.session) this.emit('notice', { code: 'passthrough', stage: this.stage });
    this.stepping = false;
  }

  send(command) {
    if (!this.sock) return Promise.resolve(undefined);
    const request_id = this.nextId++;
    return new Promise((resolve) => {
      this.requests.set(request_id, { resolve });
      this.sock.write(JSON.stringify({ command, request_id }) + '\n');
      setTimeout(() => this.requests.delete(request_id) && resolve(undefined), 3000);
    });
  }

  /** Commandes autorisées depuis l'interface : jamais de commande mpv arbitraire. */
  command(name, value) {
    switch (name) {
      case 'toggle':
        return this.send(['cycle', 'pause']);
      case 'pause':
        return this.send(['set_property', 'pause', !!value]);
      case 'seek':
        return this.send(['seek', Number(value) || 0, 'absolute']);
      case 'seekBy':
        return this.send(['seek', Number(value) || 0, 'relative']);
      case 'volume':
        return this.send(['set_property', 'volume', Math.max(0, Math.min(150, Number(value) || 0))]);
      case 'mute':
        return value === undefined ? this.send(['cycle', 'mute']) : this.send(['set_property', 'mute', !!value]);
      case 'speed':
        return this.send(['set_property', 'speed', Math.max(0.25, Math.min(4, Number(value) || 1))]);
      case 'aid':
      case 'sid':
        // Numéro de piste donné par mpv (track-list), ou 0 pour aucune.
        return this.send(['set_property', name, Number.isInteger(value) && value > 0 ? value : 'no']);
      case 'stats':
        return this.send(['script-binding', 'stats/display-stats-toggle']);
      case 'key':
        return /^[A-Za-z0-9_+]{1,20}$/.test(String(value)) ? this.send(['keypress', String(value)]) : undefined;
      default:
        return undefined;
    }
  }

  /** L'image affichée en ce moment (telle qu'on la voit, HDR converti compris), en adresse « data: ». */
  async frame() {
    if (!this.sock) return null;
    const file = path.join(this.app.getPath('temp'), `multiplex-frame-${process.pid}-${Date.now()}.jpg`);
    try {
      await this.send(['screenshot-to-file', file, 'window']);
      // mpv répond avant d'avoir fini d'écrire : on attend que le fichier soit là et stable.
      let size = -1;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const now = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (now > 0 && now === size) break;
        size = now;
      }
      if (!fs.existsSync(file)) return null;
      return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
      return null;
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  }

  /** Ce que mpv décode et affiche réellement (diagnostic et tests). */
  async info() {
    const names = ['time-pos', 'duration', 'video-codec', 'audio-codec-name', 'hwdec-current', 'current-vo', 'width', 'height', 'video-params/primaries', 'video-params/gamma', 'audio-params/channel-count', 'audio-out-params/format', 'track-list/count', 'mpv-version'];
    const out = {};
    for (const n of names) out[n] = await this.send(['get_property', n]);
    return out;
  }

  async stop() {
    this.session++;
    const proc = this.proc;
    this.proc = null;
    if (this.sock) {
      try {
        this.sock.write(JSON.stringify({ command: ['quit'] }) + '\n');
      } catch {
        /* tube déjà fermé */
      }
      this.sock.destroy();
      this.sock = null;
    }
    if (proc && proc.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => (proc.kill(), resolve()), 1500);
        proc.once('exit', () => (clearTimeout(timer), resolve()));
      });
    }
  }
}

module.exports = { MpvPlayer, listAudioDevices, findMpv };
