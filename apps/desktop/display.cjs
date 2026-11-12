// Accorde la fréquence de l'écran à la cadence de la vidéo (24, 25, 50, 60 images
// par seconde…) pendant la lecture, et la rétablit ensuite. Sans cela, un film à
// 24 images sur un écran à 60 Hz avance par à-coups. Windows uniquement.
const { execFile, execFileSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'display-mode.ps1').replace('app.asar', 'app.asar.unpacked');
const supported = process.platform === 'win32';

/** Windows annonce 23, 59 ou 119 Hz pour les fréquences « télé » 23,976, 59,94 ou 119,88. */
const actual = (rate) => ((rate + 1) % 24 === 0 || (rate + 1) % 30 === 0 ? (rate + 1) / 1.001 : rate);

/** Écart entre une fréquence d'écran et le multiple de la cadence le plus proche. */
function fit(fps, rate) {
  const hz = actual(rate);
  const k = Math.max(1, Math.round(hz / fps));
  return { k, err: Math.abs(hz - k * fps) / (k * fps) };
}

/** 0 = multiple exact, 1 = à un millième près (24 pour 23,976), 2 = à-coups. */
const grade = (fps, rate) => {
  const { err } = fit(fps, rate);
  return err < 0.0003 ? 0 : err < 0.0012 ? 1 : 2;
};

/**
 * La fréquence à choisir pour une cadence donnée, ou null si celle en cours convient
 * déjà ou qu'aucune ne fait mieux. À qualité égale, la plus proche de la cadence.
 */
function pickRate(fps, rates, current) {
  if (!(fps > 5 && fps < 130)) return null;
  const now = grade(fps, current);
  if (now === 0) return null;
  const best = rates
    .map((rate) => ({ rate, g: grade(fps, rate), k: fit(fps, rate).k }))
    .filter((x) => x.g < now)
    .sort((a, b) => a.g - b.g || a.k - b.k)[0];
  return best ? best.rate : null;
}

const psArgs = (args) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args];

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', psArgs(args), { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error('réponse illisible'));
      }
    });
  });
}

class RefreshMatcher {
  /**
   * hwnd : fonction donnant la fenêtre de l'application (pour savoir sur quel écran elle est).
   * test : ne change rien, demande seulement à Windows si le mode serait accepté.
   * around : appelée autour d'un changement en cours de lecture (pause le temps que l'écran se cale).
   */
  constructor({ hwnd, test = false, around }) {
    this.hwnd = hwnd;
    this.test = test;
    this.around = around ?? ((change) => change());
    this.fps = 0;
    this.focused = true;
    /** Mode d'avant nos changements : { device, hz, rates } ; null tant qu'on n'a rien touché. */
    this.original = null;
    this.applied = 0;
    this.queue = Promise.resolve();
    this.timer = null;
    /** Journal des décisions (tests et diagnostic). */
    this.log = [];
  }

  /** La lecture d'une vidéo à cette cadence commence. */
  want(fps) {
    clearTimeout(this.timer);
    this.fps = Number(fps) || 0;
    this.sync();
  }

  /** La lecture s'arrête : on rend sa fréquence à l'écran, sauf si une autre lecture enchaîne. */
  release() {
    clearTimeout(this.timer);
    if (!this.fps) return;
    this.timer = setTimeout(() => {
      this.fps = 0;
      this.sync();
    }, 4000);
  }

  /** L'application passe au premier plan, ou le quitte. */
  setFocused(focused) {
    if (this.focused === focused) return;
    this.focused = focused;
    this.sync();
  }

  sync() {
    if (!supported) return;
    this.queue = this.queue.then(() => this.step()).catch((e) => this.log.push({ error: String(e.message ?? e) }));
  }

  async step() {
    const fps = this.focused ? this.fps : 0;
    if (!fps) {
      const o = this.original;
      if (!o) return;
      this.original = null;
      if (this.applied !== o.hz) await this.set(o.device, o.hz, 'restore');
      this.applied = 0;
      return;
    }
    const base = this.original ?? (await run(['-Action', 'list', '-Hwnd', String(this.hwnd())]));
    const current = this.original ? this.applied : base.hz;
    const rate = pickRate(fps, base.rates, current);
    this.log.push({ fps, current, rates: base.rates, pick: rate });
    if (!rate) return;
    await this.around(() => this.set(base.device, rate, 'match'));
    this.original = { device: base.device, hz: this.original ? this.original.hz : base.hz, rates: base.rates };
    this.applied = rate;
  }

  async set(device, hz, why) {
    const out = await run(['-Action', 'set', '-Device', device, '-Hz', String(hz), ...(this.test ? ['-Test'] : [])]);
    this.log.push({ why, hz, result: out.result, test: !!out.test });
    if (out.result !== 0) throw new Error(`mode refusé (${out.result})`);
  }

  /** À la fermeture : on ne quitte pas en laissant l'écran dans une autre fréquence. */
  restoreSync() {
    clearTimeout(this.timer);
    const o = this.original;
    this.original = null;
    this.fps = 0;
    if (!supported || !o || this.applied === o.hz) return;
    try {
      execFileSync('powershell.exe', psArgs(['-Action', 'set', '-Device', o.device, '-Hz', String(o.hz), ...(this.test ? ['-Test'] : [])]), { windowsHide: true, timeout: 15000 });
    } catch {
      /* rien de plus à faire en quittant */
    }
  }
}

module.exports = { RefreshMatcher, pickRate, supported };
