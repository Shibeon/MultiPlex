import { dbToGain, webAudioStages, type AudioMode, type AudioStage } from '@multiplex/core';

/**
 * Lecteur du navigateur (web, Android, téléviseurs) : mode audio par Web Audio.
 *
 *   <video> → MediaElementAudioSourceNode → [nœuds du mode] → destination
 *                                        ↘ AnalyserNode (garde-fou contre le silence)
 *
 * Rien n'est construit tant qu'aucun mode n'est choisi : la lecture par défaut ne passe
 * jamais par Web Audio. Une fois branché, un élément <video> le reste pour toujours (la norme
 * ne permet pas de le rendre à sa sortie normale) : « Désactivé » relie alors directement la
 * source à la sortie, et le lecteur remplace l'élément au média suivant.
 *
 * Ne brancher qu'un média que la page a le droit de lire (même origine, CORS vérifié, ou flux
 * MediaSource de hls.js : voir webAudioSafe) : sinon le navigateur ne livre que du silence.
 * Le garde-fou le détecte quand même (aucun échantillon non nul pendant des secondes de
 * lecture) et prévient le lecteur, qui repasse alors sur un élément neuf, sans Web Audio.
 */

type Ctor = typeof AudioContext;
const AudioCtx = (): Ctor | undefined =>
  typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext);

/** Web Audio existe dans ce navigateur (sinon : pas de mode audio proposé). */
export const webAudioAvailable = (): boolean => !!AudioCtx() && typeof AnalyserNode !== 'undefined';

/** Éléments déjà branchés sur Web Audio : ils ne peuvent plus jouer sans. */
const claimed = new WeakMap<HTMLMediaElement, AudioGraph>();
export const graphOf = (el: HTMLMediaElement | null | undefined): AudioGraph | undefined => (el ? claimed.get(el) : undefined);

/** Durée de lecture sans le moindre échantillon non nul après laquelle on conclut au silence forcé. */
const SILENT_AFTER_S = 8;
/** Piste annoncée multicanal dont le centre reste muet (le navigateur l'a réduite en stéréo) : repli. */
const NO_CENTRE_AFTER_S = 4;

export interface GraphHooks {
  /** La source ne rend que du silence (média protégé, décodage matériel du téléviseur…). */
  onSilent(): void;
  /** Le navigateur attend un geste (toucher, touche) pour lancer le son de la page. */
  onWaiting(waiting: boolean): void;
}

/**
 * Le serveur répond-il avec des en-têtes CORS ? Requête HEAD (sans contrôle préalable) : si
 * elle aboutit, quelle que soit la réponse, le navigateur a accepté les en-têtes et l'élément
 * pourra être chargé en `crossorigin="anonymous"` sans être muet.
 */
export async function corsReadable(url: string, timeoutMs = 6000): Promise<boolean> {
  if (typeof fetch !== 'function' || typeof AbortController === 'undefined') return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await fetch(url, { method: 'HEAD', mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ac.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class AudioGraph {
  readonly ctx: AudioContext;
  private source: MediaElementAudioSourceNode | null = null;
  private tap: AnalyserNode | null = null;
  private centreTap: { centre: AnalyserNode; front: AnalyserNode } | null = null;
  private nodes: AudioNode[] = [];
  private mode: AudioMode;
  private channels: number | undefined;
  private timer = 0;
  private heard = false;
  private silentFor = 0;
  private centreSilentFor = 0;
  private lastTime = -1;
  private tripped = false;
  private waiting = false;
  private disposed = false;
  private readonly buf = new Float32Array(2048);

  private constructor(
    readonly el: HTMLMediaElement,
    mode: AudioMode,
    channels: number | undefined,
    private readonly hooks: GraphHooks,
  ) {
    const Ctx = AudioCtx()!;
    this.ctx = new Ctx();
    this.mode = mode;
    this.channels = channels;
    // Sortie multicanal quand l'appareil en a une (sinon 2) : « Désactivé » ne réduit rien.
    try {
      this.ctx.destination.channelCount = Math.max(2, Math.min(8, this.ctx.destination.maxChannelCount || 2));
      this.ctx.destination.channelInterpretation = 'speakers';
    } catch {
      /* sortie figée en stéréo : rien à faire */
    }
    this.ctx.addEventListener('statechange', this.onState);
    el.addEventListener('emptied', this.onNewSource);
  }

  /**
   * Branche le mode sur cet élément (ou change celui du graphe déjà branché). Le son de la page
   * ne démarre qu'après un geste dans certains navigateurs : tant que l'AudioContext n'est pas
   * lancé, l'élément n'est pas branché du tout et continue de jouer normalement.
   */
  static attach(el: HTMLMediaElement, mode: AudioMode, channels: number | undefined, hooks: GraphHooks): AudioGraph | null {
    const existing = claimed.get(el);
    if (existing) {
      existing.setMode(mode, channels);
      return existing;
    }
    if (!webAudioAvailable() || mode === 'off') return null;
    const g = new AudioGraph(el, mode, channels, hooks);
    g.start();
    return g;
  }

  /** Branché pour de bon (la source existe). */
  get connected(): boolean {
    return !!this.source;
  }

  private start(): void {
    if (this.ctx.state === 'running') return this.connect();
    void this.ctx.resume().catch(() => {});
    // Pas tout de suite : resume() peut aboutir sans geste (activation déjà acquise).
    setTimeout(() => {
      if (this.disposed || this.source) return;
      if (this.ctx.state === 'running') this.connect();
      else this.wait();
    }, 300);
  }

  private wait(): void {
    if (this.waiting) return;
    this.waiting = true;
    this.hooks.onWaiting(true);
    for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, this.onGesture, true);
  }

  private stopWaiting(): void {
    if (!this.waiting) return;
    this.waiting = false;
    this.hooks.onWaiting(false);
    for (const ev of ['pointerdown', 'keydown', 'touchend']) removeEventListener(ev, this.onGesture, true);
  }

  private onGesture = () => void this.ctx.resume().catch(() => {});

  private onState = () => {
    if (this.disposed) return;
    if (this.ctx.state === 'running') {
      this.stopWaiting();
      if (!this.source) this.connect();
    } else if (this.ctx.state !== 'closed') {
      // Interrompu (appel, autre application) : relancé au prochain geste. Une source déjà
      // branchée est muette pendant ce temps : le garde-fou ne compte pas ce silence.
      void this.ctx.resume().catch(() => {});
      this.wait();
    }
  };

  private onNewSource = () => {
    // Nouveau média sur le même élément : on réécoute avant de juger.
    this.heard = false;
    this.silentFor = 0;
    this.centreSilentFor = 0;
    this.lastTime = -1;
    this.tripped = false;
  };

  private connect(): void {
    if (this.disposed || this.source) return;
    try {
      this.source = this.ctx.createMediaElementSource(this.el);
    } catch {
      // Élément déjà branché ailleurs : on ne touche à rien.
      return;
    }
    claimed.set(this.el, this);
    this.tap = this.ctx.createAnalyser();
    this.tap.fftSize = this.buf.length;
    this.source.connect(this.tap);
    this.build();
    this.timer = window.setInterval(this.watch, 500);
  }

  setMode(mode: AudioMode, channels = this.channels): void {
    if (mode === this.mode && channels === this.channels) return;
    this.mode = mode;
    this.channels = channels;
    this.centreSilentFor = 0;
    if (this.source) this.build();
  }

  /** (Re)construit la chaîne du mode entre la source et la sortie. */
  private build(): void {
    const src = this.source!;
    for (const n of this.nodes) n.disconnect();
    src.disconnect();
    src.connect(this.tap!);
    this.nodes = [];
    this.centreTap = null;
    let last: AudioNode = src;
    for (const stage of webAudioStages(this.mode, this.channels)) last = this.add(last, stage);
    last.connect(this.ctx.destination);
  }

  private add(from: AudioNode, stage: AudioStage): AudioNode {
    const ctx = this.ctx;
    const keep = <T extends AudioNode>(n: T): T => (this.nodes.push(n), n);
    switch (stage.type) {
      case 'compressor': {
        // Un compresseur Web Audio traite deux canaux au plus : une piste 5.1 y est réduite en
        // stéréo (selon la norme, centre et arrières mêlés à gauche et à droite).
        const c = keep(ctx.createDynamicsCompressor());
        c.threshold.value = stage.threshold;
        c.knee.value = stage.knee;
        c.ratio.value = stage.ratio;
        c.attack.value = stage.attack;
        c.release.value = stage.release;
        from.connect(c);
        return c;
      }
      case 'gain': {
        const g = keep(ctx.createGain());
        g.gain.value = dbToGain(stage.db);
        from.connect(g);
        return g;
      }
      case 'peaking': {
        const f = keep(ctx.createBiquadFilter());
        f.type = 'peaking';
        f.frequency.value = stage.frequency;
        f.Q.value = stage.q;
        f.gain.value = stage.db;
        from.connect(f);
        return f;
      }
      case 'centre': {
        // Mise au format (5.1 ou 7.1, ordre Web Audio : L, R, C, LFE, …), puis un gain par canal.
        const n = stage.channels;
        const shape = keep(ctx.createGain());
        shape.channelCount = n;
        shape.channelCountMode = 'explicit';
        shape.channelInterpretation = 'speakers';
        const split = keep(ctx.createChannelSplitter(n));
        const merge = keep(ctx.createChannelMerger(n));
        from.connect(shape);
        shape.connect(split);
        for (let i = 0; i < n; i++) {
          const g = keep(ctx.createGain());
          g.gain.value = dbToGain(i === 2 ? stage.centreDb : stage.othersDb);
          split.connect(g, i);
          g.connect(merge, 0, i);
        }
        // Écoute du centre et de l'avant gauche, avant gain : un centre toujours muet trahit
        // une piste réduite en stéréo par le navigateur.
        const centre = keep(ctx.createAnalyser());
        const front = keep(ctx.createAnalyser());
        centre.fftSize = front.fftSize = this.buf.length;
        split.connect(centre, 2);
        split.connect(front, 0);
        this.centreTap = { centre, front };
        return merge;
      }
    }
  }

  private loud(a: AnalyserNode): boolean {
    a.getFloatTimeDomainData(this.buf);
    for (let i = 0; i < this.buf.length; i++) if (Math.abs(this.buf[i]) > 1e-6) return true;
    return false;
  }

  /** Toutes les demi-secondes, pendant une vraie lecture : y a-t-il du son ? */
  private watch = () => {
    const el = this.el;
    const t = el.currentTime;
    const advancing = this.lastTime >= 0 && t > this.lastTime && t - this.lastTime < 2;
    this.lastTime = t;
    if (!advancing || el.paused || el.muted || el.volume === 0 || el.readyState < 3 || this.ctx.state !== 'running' || this.tripped) return;
    if (!this.heard) {
      if (this.loud(this.tap!)) this.heard = true;
      else if ((this.silentFor += 0.5) >= SILENT_AFTER_S) {
        this.tripped = true;
        this.hooks.onSilent();
        return;
      }
    }
    if (this.centreTap) {
      if (this.loud(this.centreTap.centre)) this.centreSilentFor = 0;
      else if (this.loud(this.centreTap.front) && (this.centreSilentFor += 0.5) >= NO_CENTRE_AFTER_S) this.setMode(this.mode, 2);
    }
  };

  /** L'élément est abandonné (lecteur fermé, élément remplacé) : on libère tout. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.stopWaiting();
    this.ctx.removeEventListener('statechange', this.onState);
    this.el.removeEventListener('emptied', this.onNewSource);
    for (const n of this.nodes) n.disconnect();
    this.source?.disconnect();
    void this.ctx.close().catch(() => {});
  }
}
