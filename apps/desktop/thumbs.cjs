// Aperçu en image sur la barre de lecture. Un second mpv, sans fenêtre ni son, ouvre
// le même fichier et écrit une petite image à chaque déplacement demandé : on voit où
// l'on va avant d'y aller, même quand le serveur n'a pas préparé de vignettes.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

/** Pas des aperçus, en secondes : deux positions voisines partagent la même image. */
const STEP = 5;
const MAX_CACHED = 240;

class Thumbnailer {
  constructor(app, findMpv) {
    this.app = app;
    this.findMpv = findMpv;
    this.proc = null;
    this.sock = null;
    this.dir = '';
    this.cache = new Map();
    this.wanted = null;
    this.busy = false;
    this.session = 0;
    /** Nom de la dernière image lue (les images sont effacées au fur et à mesure). */
    this.last = '';
  }

  /** Prépare les aperçus du fichier en cours de lecture. */
  async start(url, headers = []) {
    this.stop();
    const exe = this.findMpv(this.app);
    if (!exe) return;
    const session = ++this.session;
    this.dir = fs.mkdtempSync(path.join(this.app.getPath('temp'), 'multiplex-thumbs-'));
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\multiplex-thumbs-${process.pid}-${session}` : path.join(this.dir, 'ipc.sock');
    const proc = spawn(
      exe,
      [
        '--no-config',
        '--idle=yes',
        '--no-terminal',
        `--input-ipc-server=${pipe}`,
        '--pause=yes',
        '--no-audio',
        '--no-sub',
        // Image clé la plus proche, décodage au plus rapide : c'est un aperçu, pas la lecture.
        '--hr-seek=no',
        '--hwdec=auto-copy-safe',
        '--vd-lavc-skiploopfilter=all',
        '--vd-lavc-fast',
        '--demuxer-max-bytes=8MiB',
        '--demuxer-max-back-bytes=0',
        '--vf=scale=320:-2',
        '--vo=image',
        '--vo-image-format=jpg',
        '--vo-image-jpeg-quality=72',
        `--vo-image-outdir=${this.dir}`,
      ],
      { stdio: 'ignore', windowsHide: true },
    );
    this.proc = proc;
    proc.on('error', () => {});
    proc.on('exit', () => session === this.session && (this.proc = null));
    try {
      this.sock = await this.connect(pipe, session);
    } catch {
      return this.stop();
    }
    if (headers.length) this.send(['set_property', 'http-header-fields', headers]);
    this.send(['loadfile', url]);
  }

  connect(pipe, session) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        if (session !== this.session || !this.proc) return reject(new Error('arrêté'));
        const sock = net.connect(pipe);
        sock.once('connect', () => {
          sock.on('data', () => {});
          sock.on('error', () => {});
          resolve(sock);
        });
        sock.once('error', () => {
          sock.destroy();
          if (++tries > 50) reject(new Error('mpv ne répond pas'));
          else setTimeout(attempt, 100);
        });
      };
      attempt();
    });
  }

  send(command) {
    try {
      this.sock?.write(JSON.stringify({ command }) + '\n');
    } catch {
      /* tube fermé */
    }
  }

  images() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.jpg')).sort();
    } catch {
      return [];
    }
  }

  /** L'aperçu à cette position (secondes), en adresse « data: », ou null s'il n'est pas disponible. */
  get(time) {
    const key = Math.max(0, Math.round((Number(time) || 0) / STEP) * STEP);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (!this.sock) return Promise.resolve(null);
    // Une seule demande à la fois ; si la souris a bougé entre-temps, seule la dernière position compte.
    return new Promise((resolve) => {
      this.wanted?.resolve(null);
      this.wanted = { key, resolve };
      void this.pump();
    });
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    const session = this.session;
    while (this.wanted && session === this.session) {
      const { key, resolve } = this.wanted;
      this.wanted = null;
      // mpv numérote ses images : la nouvelle est celle dont le nom dépasse la dernière vue.
      const last = this.images().pop() ?? this.last ?? '';
      this.send(['seek', key, 'absolute+keyframes']);
      let file = null;
      for (let waited = 0; waited < 4000 && session === this.session; waited += 25) {
        await new Promise((r) => setTimeout(r, 25));
        const fresh = this.images().filter((f) => f > last).pop();
        if (fresh) {
          file = fresh;
          break;
        }
      }
      let data = null;
      if (file && session === this.session) {
        try {
          // L'image vient d'être créée : on laisse mpv finir de l'écrire.
          await new Promise((r) => setTimeout(r, 30));
          data = `data:image/jpeg;base64,${fs.readFileSync(path.join(this.dir, file)).toString('base64')}`;
          if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value);
          this.cache.set(key, data);
        } catch {
          data = null;
        }
        this.last = file;
        for (const f of this.images()) fs.rm(path.join(this.dir, f), { force: true }, () => {});
      }
      resolve(data);
    }
    this.busy = false;
  }

  stop() {
    this.session++;
    this.wanted?.resolve(null);
    this.wanted = null;
    this.cache.clear();
    this.last = '';
    if (this.sock) {
      this.send(['quit']);
      this.sock.destroy();
      this.sock = null;
    }
    const proc = this.proc;
    this.proc = null;
    const dir = this.dir;
    this.dir = '';
    if (proc) setTimeout(() => proc.exitCode === null && proc.kill(), 1000);
    if (dir) setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 1500);
  }
}

module.exports = { Thumbnailer };
