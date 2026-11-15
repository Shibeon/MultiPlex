// « Regarder ensemble » : la règle qui garde tout le monde au même endroit. Ce module ne touche ni
// au réseau ni au lecteur réel : il reçoit les messages déjà déchiffrés et un petit adaptateur du
// lecteur, et rend ce qu'il faut envoyer. Le client web l'emploie tel quel ; le client natif LG
// en reprend la règle (voir apps/relay/README.md, « Protocole de synchronisation »).
//
// Règle : dernier écrivain gagnant, dans l'ordre de Lamport.
// - Chaque commande (lecture, pause, saut) porte un tampon { c, by } : `c` = 1 + le plus grand `c`
//   vu jusque-là par son auteur, `by` = identifiant de l'auteur. Un tampon est plus récent qu'un
//   autre si son `c` est plus grand, ou, à `c` égal, si son `by` est plus grand (ordre des chaînes).
//   Deux commandes simultanées (chacune lancée sans avoir vu l'autre) sont donc départagées de la
//   même façon chez tout le monde, quel que soit l'ordre d'arrivée : on converge.
// - Chacun garde la référence la plus récente reçue (position, lecture/pause, tampon) et ignore
//   toute commande ou présence d'un tampon plus ancien.
// - Les présences (toutes les 3 s) portent le tampon de la référence suivie par leur auteur et
//   l'état de son lecteur. Une présence d'un tampon plus récent que le sien est adoptée comme une
//   commande : c'est ainsi qu'on rattrape une commande perdue (relais limité, coupure) et qu'on se
//   resynchronise en revenant. À tampon égal, seules les présences de l'hôte servent d'horloge
//   (petits écarts rattrapés par la vitesse de lecture, grands par un saut).
// - Hors connexion, un geste local n'est ni tamponné ni envoyé : en revenant, la séance l'emporte.
// - Seuls la position et l'état lecture/pause circulent : volume, sous-titres, pistes, qualité et
//   vitesse choisie restent propres à chacun (l'adaptateur ne les expose même pas).

/** Ce que le lecteur expose à la séance, et rien d'autre. */
export interface SyncPlayer {
  time(): number;
  paused(): boolean;
  play(): void;
  pause(): void;
  seek(time: number): void;
  /** Vitesse de lecture, pour rattraper un petit écart sans saut visible. */
  rate?(rate: number): void;
  /** La vidéo est chargée et avance vraiment (avant : rien n'est surveillé ni annoncé). */
  ready(): boolean;
}

export type SyncAction = 'play' | 'pause' | 'seek';

/** Tampon d'une commande : horloge de Lamport et auteur. */
export interface Stamp {
  c: number;
  by: string;
}

/** Référence de la séance : où elle en est, à quel instant (horloge locale) on l'a apprise. */
export interface SyncRef extends Stamp {
  time: number;
  playing: boolean;
  at: number;
}

/** Commande reçue d'un autre participant (`c` absent : ancien client, rangé à l'arrivée). */
export interface IntentIn {
  id: string;
  action: SyncAction;
  time: number;
  playing: boolean;
  c?: number;
}

/** Présence reçue (`c`/`by` absents : ancien client). */
export interface TickIn {
  id: string;
  host: boolean;
  /** L'auteur est dans le lecteur (sinon sa position ne dit rien). */
  live: boolean;
  time: number;
  playing: boolean;
  c?: number;
  by?: string;
}

/** Commande locale à envoyer, exactement ces champs (avec l'identité, ajoutée par l'appelant). */
export interface IntentOut {
  action: SyncAction;
  time: number;
  playing: boolean;
  c: number;
}

/** Seuils (secondes, millisecondes pour `settleMs`). */
export const SYNC = {
  /** Écart corrigé par un saut après une commande. */
  hard: 0.8,
  /** Écart corrigé par un saut en suivant l'hôte ; en dessous, la vitesse s'ajuste. */
  soft: 2,
  /** Écart d'avec la position attendue au-delà duquel un geste local est un saut. */
  jump: 1.6,
  /** Après une correction, les changements du lecteur ne sont pas des gestes de la personne. */
  settleMs: 1500,
} as const;

export const NO_STAMP: Stamp = { c: 0, by: '' };

/** Vrai si `a` est strictement plus récent que `b`. */
export const newer = (a: Stamp, b: Stamp): boolean => a.c > b.c || (a.c === b.c && a.by > b.by);

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const stampOf = (c: unknown, by: unknown): Stamp | null => (typeof c === 'number' && Number.isFinite(c) && c >= 0 ? { c: Math.floor(c), by: typeof by === 'string' ? by : '' } : null);

/**
 * Deux hôtes à la fois : après une coupure de plus de 12 s, un participant a pris la main pendant
 * que l'hôte d'origine revenait. Chaque hôte dit dans ses ticks quand il a pris la main (`hc`,
 * l'horloge de Lamport à ce moment ; 0 pour l'hôte d'origine). La prise de main la plus récente
 * l'emporte (puis le plus grand identifiant) : c'est celui qui a mené la séance pendant l'absence,
 * et celui qui en tient l'annonce au relais. `a` cède la main à `b` quand `hostYields(a, b)`.
 */
export const hostYields = (a: { hc: number; id: string }, b: { hc: number; id: string }): boolean => b.hc > a.hc || (b.hc === a.hc && b.id > a.id);

export class TogetherSync {
  ref: SyncRef | null = null;
  /** Plus grand `c` vu ou émis. */
  clock = 0;
  private player: SyncPlayer | null = null;
  private last = { time: 0, paused: true, at: 0 };
  private applyingUntil = 0;
  private wasReady = false;

  constructor(
    readonly me: string,
    private now: () => number = () => performance.now(),
  ) {}

  attach(p: SyncPlayer): void {
    this.player = p;
    this.last = { time: p.time(), paused: p.paused(), at: this.now() };
    this.wasReady = false;
  }

  detach(p?: SyncPlayer): void {
    if (p && this.player !== p) return;
    this.player?.rate?.(1);
    this.player = null;
  }

  get attached(): boolean {
    return !!this.player;
  }

  /** Séance quittée : plus de référence. */
  reset(): void {
    this.ref = null;
    this.clock = 0;
  }

  /** Tampon de la référence suivie, à porter dans les présences. */
  stamp(): Stamp {
    return this.ref ? { c: this.ref.c, by: this.ref.by } : NO_STAMP;
  }

  /** Position de la séance maintenant, ou null sans référence. */
  position(): number | null {
    const r = this.ref;
    return r ? r.time + (r.playing ? (this.now() - r.at) / 1000 : 0) : null;
  }

  /** Référence apprise autrement que par un message (invitation d'un ami : état donné par l'hôte). */
  adopt(state: { time: number; playing: boolean } & Partial<Stamp>): void {
    const s = stampOf(state.c, state.by) ?? NO_STAMP;
    this.clock = Math.max(this.clock, s.c);
    this.ref = { time: num(state.time), playing: !!state.playing, at: this.now(), ...s };
  }

  /** Commande d'un autre participant. Vrai si elle devient la référence (et est appliquée). */
  onIntent(m: IntentIn): boolean {
    const s = stampOf(m.c, m.id) ?? { c: this.clock + 1, by: m.id };
    this.clock = Math.max(this.clock, s.c);
    if (this.ref && !newer(s, this.ref)) return false;
    this.ref = { time: num(m.time), playing: !!m.playing, at: this.now(), ...s };
    this.apply(true);
    return true;
  }

  /**
   * Présence d'un autre participant. « adopt » : elle suit une commande plus récente que la nôtre
   * (manquée ou perdue), adoptée et appliquée ; « follow » : présence de l'hôte au même tampon,
   * qui recale l'horloge ; « ignore » sinon.
   */
  onTick(m: TickIn, iAmHost: boolean): 'adopt' | 'follow' | 'ignore' {
    const s = stampOf(m.c, m.by);
    if (s) this.clock = Math.max(this.clock, s.c);
    if (!m.live) return 'ignore';
    const ref = { time: num(m.time), playing: !!m.playing, at: this.now() };
    if (!this.ref) {
      if (!s && !m.host) return 'ignore';
      this.ref = { ...ref, ...(s ?? NO_STAMP) };
      this.apply(true);
      return 'adopt';
    }
    if (s && newer(s, this.ref)) {
      this.ref = { ...ref, ...s };
      this.apply(true);
      return 'adopt';
    }
    const same = !s || (s.c === this.ref.c && s.by === this.ref.by);
    if (m.host && !iAmHost && same) {
      this.ref = { ...ref, c: this.ref.c, by: this.ref.by };
      return 'follow';
    }
    return 'ignore';
  }

  /**
   * Surveille le lecteur local (toutes les 500 ms) : rend la commande à envoyer quand la personne
   * vient de mettre en pause, de reprendre ou de sauter ; suit la séance sinon. `online` : le
   * message partira vraiment (sinon le geste reste local et la séance l'emportera au retour).
   */
  poll(opts: { host: boolean; online: boolean }): IntentOut | null {
    const p = this.player;
    if (!p) return null;
    const now = this.now();
    const time = p.time();
    const paused = p.paused();
    if (!p.ready()) {
      this.wasReady = false;
      this.last = { time, paused, at: now };
      return null;
    }
    if (!this.wasReady) {
      // La vidéo démarre : pas un geste de la personne. On se cale sur la séance si elle existe.
      this.wasReady = true;
      this.last = { time, paused, at: now };
      if (!opts.host && this.ref) this.apply(true);
      return null;
    }
    const expected = this.last.time + (this.last.paused ? 0 : (now - this.last.at) / 1000);
    let out: IntentOut | null = null;
    if (now > this.applyingUntil) {
      const jumped = Math.abs(time - expected) > SYNC.jump;
      if (paused !== this.last.paused || jumped) {
        if (opts.online) {
          const c = ++this.clock;
          this.ref = { time, playing: !paused, at: now, c, by: this.me };
          out = { action: jumped ? 'seek' : paused ? 'pause' : 'play', time, playing: !paused, c };
        }
      } else if (!opts.host && opts.online) this.apply(false);
    }
    this.last = { time, paused, at: now };
    return out;
  }

  /** Met le lecteur local au diapason de la référence. `hard` : commande explicite. */
  apply(hard: boolean): void {
    const p = this.player;
    const r = this.ref;
    if (!p || !r || !p.ready()) return;
    const now = this.now();
    const expected = r.time + (r.playing ? (now - r.at) / 1000 : 0);
    const diff = p.time() - expected;
    const paused = p.paused();
    const limit = hard ? SYNC.hard : SYNC.soft;
    if (r.playing === paused || Math.abs(diff) > limit) this.applyingUntil = now + SYNC.settleMs;
    if (Math.abs(diff) > limit) {
      p.seek(expected);
      p.rate?.(1);
    } else if (!hard && r.playing && !paused && p.rate) {
      // Petit écart : on accélère ou ralentit à peine, sans saut visible.
      p.rate(Math.abs(diff) < 0.25 ? 1 : 1 - Math.max(-0.05, Math.min(0.05, diff * 0.08)));
    }
    if (r.playing && paused) p.play();
    else if (!r.playing && !paused) p.pause();
    this.last = { time: expected, paused: !r.playing, at: now };
  }
}
