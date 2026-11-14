import { AudioWatch, FOLD_TO_51, SURROUND_GROUPS, dbToGain, webAudioPlan, type AudioMode, type AudioStage, type MediaKind, type WatchVerdict } from '@multiplex/core';
import { platform, tvDevice } from './platform';

/**
 * Lecteur du navigateur (web, Android) : mode audio par Web Audio.
 *
 *   <video> → MediaElementAudioSourceNode → [nœuds du mode] → destination
 *                                        ↘ AnalyserNode (ce que Web Audio reçoit)
 *   <video>.captureStream() → MediaStreamSource → AnalyserNode (ce que l'élément joue)
 *
 * Rien n'est construit tant qu'aucun mode n'est choisi : la lecture par défaut ne passe
 * jamais par Web Audio. Une fois branché, un élément <video> le reste pour toujours (la norme
 * ne permet pas de le rendre à sa sortie normale) : pour « Désactivé », le lecteur prend un
 * élément neuf.
 *
 * Un mode ne doit jamais rendre la lecture muette : le garde-fou (AudioWatch, dans le cœur)
 * compare ce que Web Audio reçoit à la copie captureStream de l'élément et surveille
 * l'AudioContext ; au moindre doute, le lecteur repasse sur un élément neuf, sans Web Audio.
 */

type Ctor = typeof AudioContext;
const AudioCtx = (): Ctor | undefined =>
  typeof window === 'undefined' ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext);

/** Web Audio existe dans ce navigateur (sinon : pas de mode audio proposé). */
export const webAudioAvailable = (): boolean => !!AudioCtx() && typeof AnalyserNode !== 'undefined';

/**
 * Le lecteur du navigateur peut-il appliquer un mode ici ? Pas sur téléviseur (son décodé par le
 * matériel, que Web Audio reçoit muet), pas sans Web Audio, pas sans MediaSource (Safari sur
 * iPhone ancien : HLS natif, que WebKit rend muet avec Web Audio). Réglages masque l'option
 * sinon, sauf dans l'application de bureau (lecteur natif).
 */
export const webAudioModesPossible = (): boolean =>
  !tvDevice && webAudioAvailable() && typeof window !== 'undefined' && ('MediaSource' in window || 'ManagedMediaSource' in window);

/** Éléments déjà branchés sur Web Audio : ils ne peuvent plus jouer sans. */
const claimed = new WeakMap<HTMLMediaElement, AudioGraph>();
export const graphOf = (el: HTMLMediaElement | null | undefined): AudioGraph | undefined => (el ? claimed.get(el) : undefined);

/**
 * Lectures (plateforme + type de média) où Web Audio n'a reçu que du silence alors que l'élément
 * jouait du son : plus de mode pour elles jusqu'à la fermeture de l'application, au lieu d'un
 * essai raté à chaque titre.
 */
const failedKinds = new Set<string>();
const kindKey = (kind: MediaKind) => `${platform}:${kind}`;
export const audioKindFailed = (kind: MediaKind): boolean => failedKinds.has(kindKey(kind));
export const markAudioKindFailed = (kind: MediaKind): void => void failedKinds.add(kindKey(kind));

/** Échec vu par le garde-fou, transmis au lecteur. */
export type GraphFailure = Exclude<WatchVerdict, 'ok' | 'no-centre'>;

export interface GraphHooks {
  /** Web Audio ne rend pas le son de l'élément : le lecteur doit repasser sans. */
  onFail(why: GraphFailure): void;
  /** Le navigateur attend un geste (toucher, touche) pour lancer le son de la page. */
  onWaiting(waiting: boolean): void;
}

/**
 * Le serveur répond-il en CORS ? Lecture du premier octet (`Range: bytes=0-0`) : seule une
 * réponse réussie (200 à 206) vaut, une erreur du serveur ferait échouer l'élément chargé en
 * `crossorigin="anonymous"`. La réponse est abandonnée aussitôt.
 */
export async function corsReadable(url: string, timeoutMs = 6000): Promise<boolean> {
  if (typeof fetch !== 'function' || typeof AbortController === 'undefined') return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: ac.signal });
    return r.ok && r.status >= 200 && r.status <= 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
}

/** Copie de l'élément pour le garde-fou (Chromium, Firefox) ; sans elle (Safari), seul le repli à 3 s vaut. */
type CaptureEl = HTMLMediaElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };

/** Pas du garde-fou. */
const WATCH_MS = 250;

export interface AttachOptions {
  channels?: number;
  /** Le média a une piste audio (sinon, des zéros ne prouvent rien). */
  hasAudio: boolean;
}

export class AudioGraph {
  readonly ctx: AudioContext;
  private source: MediaElementAudioSourceNode | null = null;
  private tap: AnalyserNode | null = null;
  private ref: { node: MediaStreamAudioSourceNode; analyser: AnalyserNode; stream: MediaStream } | null = null;
  private centreTap: { centre: AnalyserNode; front: AnalyserNode } | null = null;
  private nodes: AudioNode[] = [];
  private mode: AudioMode;
  private opts: AttachOptions;
  private readonly watch = new AudioWatch();
  private timer = 0;
  private lastTime = -1;
  private tripped = false;
  private waiting = false;
  private disposed = false;
  private readonly buf = new Float32Array(1024);

  private constructor(
    readonly el: HTMLMediaElement,
    mode: AudioMode,
    opts: AttachOptions,
    private readonly hooks: GraphHooks,
  ) {
    const Ctx = AudioCtx()!;
    this.ctx = new Ctx();
    this.mode = mode;
    this.opts = opts;
    // Sortie 5.1 quand l'appareil en a une (sinon stéréo) : le traitement garde six canaux.
    try {
      const max = this.ctx.destination.maxChannelCount || 2;
      this.ctx.destination.channelCount = max >= 6 ? 6 : 2;
      this.ctx.destination.channelInterpretation = 'speakers';
    } catch {
      /* sortie figée en stéréo : rien à faire */
    }
    this.ctx.addEventListener('statechange', this.onState);
    el.addEventListener('emptied', this.onNewSource);
    el.addEventListener('loadeddata', this.onLoaded);
  }

  /**
   * Branche le mode sur cet élément (ou change celui du graphe déjà branché). Le son de la page
   * ne démarre qu'après un geste dans certains navigateurs : tant que l'AudioContext n'est pas
   * lancé, l'élément n'est pas branché du tout et continue de jouer normalement.
   */
  static attach(el: HTMLMediaElement, mode: AudioMode, opts: AttachOptions, hooks: GraphHooks): AudioGraph | null {
    const existing = claimed.get(el);
    if (existing) {
      existing.setMode(mode, opts);
      return existing;
    }
    if (!webAudioAvailable() || mode === 'off') return null;
    const g = new AudioGraph(el, mode, opts, hooks);
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
      // Interrompu (appel, autre application) : on tente de relancer ; si la vidéo avance sans
      // que l'AudioContext reparte, le garde-fou rend la main au lecteur (« suspended »).
      void this.ctx.resume().catch(() => {});
    }
  };

  private onNewSource = () => {
    // Nouveau média sur le même élément : on réécoute avant de juger.
    this.watch.reset();
    this.lastTime = -1;
    this.tripped = false;
  };

  /** Nouvelle source chargée : la copie captureStream est refaite (ses pistes ont changé). */
  private onLoaded = () => {
    if (this.source) this.capture();
  };

  private connect(): void {
    if (this.disposed || this.source) return;
    // Élément illisible pour la page (média d'un autre serveur sans CORS) : la copie est
    // refusée, et Web Audio ne recevrait que des zéros. On ne branche rien.
    if (this.tainted()) return this.fail('no-signal');
    try {
      this.source = this.ctx.createMediaElementSource(this.el);
    } catch {
      // Élément déjà branché ailleurs : on ne touche à rien.
      return;
    }
    claimed.set(this.el, this);
    this.tap = this.ctx.createAnalyser();
    this.tap.fftSize = this.buf.length;
    this.capture();
    this.build();
    this.timer = window.setInterval(this.tick, WATCH_MS);
  }

  private tainted(): boolean {
    const el = this.el as CaptureEl;
    const cap = el.captureStream ?? el.mozCaptureStream;
    if (!cap) return false;
    try {
      cap.call(el).getTracks().forEach((t) => t.stop());
      return false;
    } catch (e) {
      return (e as DOMException)?.name === 'SecurityError';
    }
  }

  private capture(): void {
    if (this.ref) {
      this.ref.node.disconnect();
      this.ref.stream.getTracks().forEach((t) => t.stop());
      this.ref = null;
    }
    const el = this.el as CaptureEl;
    const cap = el.captureStream ?? el.mozCaptureStream;
    if (!cap) return;
    try {
      const stream = cap.call(el);
      stream.getVideoTracks().forEach((t) => t.stop());
      if (!stream.getAudioTracks().length) {
        // Pistes pas encore là (chargement) : refait à « loadeddata ».
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const node = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = this.buf.length;
      node.connect(analyser);
      this.ref = { node, analyser, stream };
    } catch (e) {
      if ((e as DOMException)?.name === 'SecurityError') this.fail('no-signal');
    }
  }

  setMode(mode: AudioMode, opts: Partial<AttachOptions> = {}): void {
    const next = { ...this.opts, ...opts };
    const rebuild = mode !== this.mode || next.channels !== this.opts.channels;
    this.mode = mode;
    this.opts = next;
    if (this.source && rebuild) this.build();
  }

  /** (Re)construit la chaîne du mode entre la source et la sortie. */
  private build(): void {
    const ctx = this.ctx;
    const src = this.source!;
    for (const n of this.nodes) n.disconnect();
    src.disconnect();
    src.connect(this.tap!);
    this.nodes = [];
    this.centreTap = null;
    const keep = <T extends AudioNode>(n: T): T => (this.nodes.push(n), n);
    const plan = webAudioPlan(this.mode, this.opts.channels);
    if (!plan) return void src.connect(ctx.destination);

    if (plan.layout === 'stereo') {
      // Six canaux au plus (une piste 7.1 mal annoncée ne garderait sinon que ses deux premiers
      // canaux en stéréo) ; mono et stéréo passent tels quels.
      const clamp = keep(ctx.createGain());
      clamp.channelCount = 6;
      clamp.channelCountMode = 'clamped-max';
      clamp.channelInterpretation = 'speakers';
      src.connect(clamp);
      this.chain(clamp, plan.stages, keep).connect(ctx.destination);
      return;
    }

    // 5.1 : la source mise à six canaux (6.1 et 7.1 réduites d'abord), un gain par canal, puis
    // le traitement par groupe ; les six canaux arrivent à la sortie.
    let six: AudioNode;
    if (plan.fold) {
      const n = plan.fold;
      const shape = keep(ctx.createGain());
      shape.channelCount = n;
      shape.channelCountMode = 'explicit';
      shape.channelInterpretation = 'discrete';
      const split = keep(ctx.createChannelSplitter(n));
      const merge = keep(ctx.createChannelMerger(6));
      src.connect(shape);
      shape.connect(split);
      FOLD_TO_51[n].forEach((row, out) =>
        row.forEach((k, inp) => {
          if (!k) return;
          const g = keep(ctx.createGain());
          g.gain.value = k;
          split.connect(g, inp);
          g.connect(merge, 0, out);
        }),
      );
      six = merge;
    } else {
      const shape = keep(ctx.createGain());
      shape.channelCount = 6;
      shape.channelCountMode = 'explicit';
      shape.channelInterpretation = 'speakers';
      src.connect(shape);
      six = shape;
    }
    const split = keep(ctx.createChannelSplitter(6));
    six.connect(split);
    const gains = plan.gains.map((db, i) => {
      const g = keep(ctx.createGain());
      g.gain.value = dbToGain(db);
      split.connect(g, i);
      return g;
    });
    const out = keep(ctx.createChannelMerger(6));
    for (const group of SURROUND_GROUPS) {
      let input: AudioNode = gains[group[0]];
      if (group.length > 1) {
        const m = keep(ctx.createChannelMerger(group.length));
        group.forEach((ch, j) => gains[ch].connect(m, 0, j));
        input = m;
      }
      const last = this.chain(input, plan.stages, keep);
      if (group.length === 1) last.connect(out, 0, group[0]);
      else {
        const s = keep(ctx.createChannelSplitter(group.length));
        last.connect(s);
        group.forEach((ch, j) => s.connect(out, j, ch));
      }
    }
    out.connect(ctx.destination);
    // Écoute du centre et de l'avant gauche : un centre toujours muet trahit une piste que le
    // navigateur a déjà réduite en stéréo.
    const centre = keep(ctx.createAnalyser());
    const front = keep(ctx.createAnalyser());
    centre.fftSize = front.fftSize = this.buf.length;
    split.connect(centre, 2);
    split.connect(front, 0);
    this.centreTap = { centre, front };
  }

  private chain(from: AudioNode, stages: AudioStage[], keep: <T extends AudioNode>(n: T) => T): AudioNode {
    let last = from;
    for (const stage of stages) {
      const n = keep(this.stage(stage));
      last.connect(n);
      last = n;
    }
    return last;
  }

  private stage(stage: AudioStage): AudioNode {
    const ctx = this.ctx;
    switch (stage.type) {
      case 'compressor': {
        // Deux canaux au plus : le plan n'y fait passer qu'un groupe (ou une piste stéréo).
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = stage.threshold;
        c.knee.value = stage.knee;
        c.ratio.value = stage.ratio;
        c.attack.value = stage.attack;
        c.release.value = stage.release;
        return c;
      }
      case 'gain': {
        const g = ctx.createGain();
        g.gain.value = dbToGain(stage.db);
        return g;
      }
      case 'peaking': {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = stage.frequency;
        f.Q.value = stage.q;
        f.gain.value = stage.db;
        return f;
      }
    }
  }

  private loud(a: AnalyserNode): boolean {
    a.getFloatTimeDomainData(this.buf);
    for (let i = 0; i < this.buf.length; i++) if (Math.abs(this.buf[i]) > 1e-6) return true;
    return false;
  }

  private fail(why: GraphFailure): void {
    if (this.tripped || this.disposed) return;
    this.tripped = true;
    this.hooks.onFail(why);
  }

  /** Tous les quarts de seconde : la lecture a-t-elle du son ? */
  private tick = () => {
    if (this.tripped || this.disposed) return;
    const el = this.el;
    const t = el.currentTime;
    const advancing = this.lastTime >= 0 && t > this.lastTime && t - this.lastTime < 2;
    this.lastTime = t;
    const wantsPlay = !el.paused && !el.ended;
    const playing = advancing && wantsPlay && !el.muted && el.volume > 0 && el.readyState >= 3;
    const live = playing && this.ctx.state === 'running';
    const verdict = this.watch.tick({
      dt: WATCH_MS / 1000,
      playing,
      wantsPlay,
      running: this.ctx.state === 'running',
      hasAudio: this.opts.hasAudio,
      tapLoud: live && this.loud(this.tap!),
      refLoud: this.ref ? live && this.loud(this.ref.analyser) : null,
      centre: this.centreTap && live ? { centreLoud: this.loud(this.centreTap.centre), frontLoud: this.loud(this.centreTap.front) } : undefined,
    });
    if (verdict === 'no-centre') this.setMode(this.mode, { channels: 2 });
    else if (verdict !== 'ok') this.fail(verdict);
  };

  /** L'élément est abandonné (lecteur fermé, élément remplacé) : on libère tout. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.stopWaiting();
    this.ctx.removeEventListener('statechange', this.onState);
    this.el.removeEventListener('emptied', this.onNewSource);
    this.el.removeEventListener('loadeddata', this.onLoaded);
    for (const n of this.nodes) n.disconnect();
    this.source?.disconnect();
    if (this.ref) {
      this.ref.node.disconnect();
      this.ref.stream.getTracks().forEach((t) => t.stop());
    }
    void this.ctx.close().catch(() => {});
  }
}
