// Règle de synchronisation de « Regarder ensemble » : commandes simultanées, présences périmées,
// commande perdue, retour après coupure, et ce qui ne circule jamais (volume, sous-titres…).
import { describe, expect, it } from 'vitest';
import { TogetherSync, newer, type IntentIn, type IntentOut, type SyncPlayer, type TickIn } from '../src';

let clock = 0;
const now = () => clock;

/** Lecteur factice : avance avec l'horloge quand il joue ; volume et sous-titres à lui. */
class FakePlayer implements SyncPlayer {
  pos = 0;
  isPaused = true;
  since = 0;
  volume = 0.8;
  subtitle = 'fr';
  volumeWrites = 0;
  seeks: number[] = [];
  time() {
    return this.pos + (this.isPaused ? 0 : (clock - this.since) / 1000);
  }
  paused() {
    return this.isPaused;
  }
  ready() {
    return true;
  }
  play() {
    if (!this.isPaused) return;
    this.since = clock;
    this.isPaused = false;
  }
  pause() {
    if (this.isPaused) return;
    this.pos = this.time();
    this.isPaused = true;
  }
  seek(t: number) {
    this.seeks.push(t);
    this.pos = t;
    this.since = clock;
  }
  rate() {}
  setVolume(v: number) {
    this.volume = v;
    this.volumeWrites++;
  }
}

/** Un participant : sa règle, son lecteur, et ce qu'il enverrait. */
function member(id: string, host = false, playing = false) {
  const sync = new TogetherSync(id, now);
  const player = new FakePlayer();
  if (playing) player.play();
  sync.attach(player);
  sync.poll({ host, online: true }); // la vidéo est prête : premier relevé
  return { id, host, sync, player };
}
type Member = ReturnType<typeof member>;

const intentOf = (m: Member, out: IntentOut): IntentIn => ({ id: m.id, ...out });
const tickOf = (m: Member): TickIn => ({ id: m.id, host: m.host, live: true, time: m.player.time(), playing: !m.player.paused(), ...m.sync.stamp() });

/** Geste local, relevé par la surveillance suivante. */
function gesture(m: Member, act: (p: FakePlayer) => void): IntentIn {
  clock += 100;
  act(m.player);
  const out = m.sync.poll({ host: m.host, online: true });
  expect(out).not.toBeNull();
  return intentOf(m, out!);
}

describe('ordre des commandes', () => {
  it('tampons : horloge d’abord, puis identifiant ; jamais plus récent que soi-même', () => {
    expect(newer({ c: 2, by: 'a' }, { c: 1, by: 'z' })).toBe(true);
    expect(newer({ c: 2, by: 'b' }, { c: 2, by: 'a' })).toBe(true);
    expect(newer({ c: 2, by: 'a' }, { c: 2, by: 'a' })).toBe(false);
  });

  it('commandes simultanées : tout le monde converge sur la même, quel que soit l’ordre d’arrivée', () => {
    clock = 1_000_000;
    const h = member('h', true);
    const a = member('a');
    const b = member('b');
    // A met en pause à 100 s, B saute à 300 s, chacun sans avoir vu l'autre.
    const ia = gesture(a, (p) => (p.seek(100), p.pause()));
    const ib = gesture(b, (p) => p.seek(300));
    expect(ia.c).toBe(ib.c); // même horloge : départagés par l'identifiant (« b » > « a »)
    // Le relais les livre dans un ordre différent à chacun.
    h.sync.onIntent(ib);
    h.sync.onIntent(ia);
    a.sync.onIntent(ib);
    b.sync.onIntent(ia);
    for (const m of [h, a, b]) {
      expect(m.sync.stamp()).toEqual({ c: ib.c, by: 'b' });
      expect(Math.abs(m.player.time() - 300)).toBeLessThan(0.9);
    }
    // B n'a jamais reculé : la commande perdante, arrivée après, est ignorée sans rien toucher.
    expect(b.player.seeks).toEqual([300]);
  });

  it('commande suivante (qui a vu la précédente) : elle gagne partout', () => {
    clock = 2_000_000;
    const h = member('h', true, true);
    const z = member('z', false, true);
    const a = member('a', false, true);
    const iz = gesture(z, (p) => p.pause());
    a.sync.onIntent(iz);
    h.sync.onIntent(iz);
    // « a » < « z », mais A a vu la commande de Z : son horloge est plus grande.
    clock += 2000;
    const ia = gesture(a, (p) => p.play());
    expect(ia.c).toBeGreaterThan(iz.c ?? Infinity);
    h.sync.onIntent(ia);
    z.sync.onIntent(ia);
    for (const m of [h, z, a]) {
      expect(m.sync.stamp()).toEqual({ c: ia.c, by: 'a' });
      expect(m.player.paused()).toBe(false);
    }
  });

  it('présence périmée de l’hôte (partie avant la commande) : ignorée, pas de retour en arrière', () => {
    clock = 3_000_000;
    const h = member('h', true, true);
    const a = member('a', false, true);
    const stale = tickOf(h); // l'hôte n'a pas encore reçu la commande
    const ia = gesture(a, (p) => p.seek(500));
    expect(a.sync.onTick(stale, false)).toBe('ignore');
    expect(Math.abs(a.player.time() - 500)).toBeLessThan(0.2);
    h.sync.onIntent(ia);
    clock += 1000;
    // Présence suivante de l'hôte, au même tampon : elle sert d'horloge.
    expect(a.sync.onTick(tickOf(h), false)).toBe('follow');
  });

  it('commandes d’un ancien client (sans tampon) : rangées dans l’ordre d’arrivée', () => {
    clock = 4_000_000;
    const a = member('a');
    expect(a.sync.onIntent({ id: 'old', action: 'pause', time: 10, playing: false })).toBe(true);
    expect(a.sync.onIntent({ id: 'old2', action: 'seek', time: 20, playing: false })).toBe(true);
    expect(a.player.time()).toBeCloseTo(20, 1);
  });
});

describe('coupures et reprises', () => {
  it('commande manquée pendant une coupure : rattrapée par la première présence reçue', () => {
    clock = 5_000_000;
    const h = member('h', true, true);
    const a = member('a', false, true);
    const c = member('c', false, true);
    // C est coupé : il ne reçoit pas la commande de A (pause à 42 s).
    const ia = gesture(a, (p) => (p.seek(42), p.pause()));
    h.sync.onIntent(ia);
    clock += 4000;
    // De retour, C demande l'état ; la présence de l'hôte porte un tampon plus récent : adoptée.
    expect(c.sync.onTick(tickOf(h), false)).toBe('adopt');
    expect(c.player.paused()).toBe(true);
    expect(c.player.time()).toBeCloseTo(42, 0);
    expect(c.sync.stamp()).toEqual(h.sync.stamp());
  });

  it('commande perdue en route (relais) : la présence de son auteur la renvoie', () => {
    clock = 6_000_000;
    const h = member('h', true, true);
    const a = member('a', false, true);
    gesture(a, (p) => p.pause()); // jamais arrivée chez l'hôte
    clock += 3000;
    expect(h.sync.onTick(tickOf(a), true)).toBe('adopt');
    expect(h.player.paused()).toBe(true);
  });

  it('geste fait hors connexion : rien n’est envoyé ni tamponné ; au retour, la séance l’emporte', () => {
    clock = 7_000_000;
    const h = member('h', true, true);
    const a = member('a', false, true);
    h.sync.onTick(tickOf(a), true);
    a.sync.onTick(tickOf(h), false);
    clock += 500;
    expect(a.sync.poll({ host: false, online: false })).toBeNull(); // lecture relevée, hors ligne
    const before = a.sync.stamp();
    clock += 500;
    a.player.pause();
    expect(a.sync.poll({ host: false, online: false })).toBeNull();
    expect(a.sync.stamp()).toEqual(before);
    clock += 3000;
    // Reconnecté : présence de l'hôte (même tampon), qui joue toujours.
    a.sync.onTick(tickOf(h), false);
    clock += 500;
    a.sync.poll({ host: false, online: true });
    expect(a.player.paused()).toBe(false);
    expect(Math.abs(a.player.time() - h.player.time())).toBeLessThan(2.1);
  });

  it('nouvel arrivant sans référence : la première présence de l’hôte la lui donne', () => {
    clock = 8_000_000;
    const h = member('h', true);
    h.player.seek(1200);
    h.player.play();
    const n = new TogetherSync('n', now);
    expect(n.onTick(tickOf(h), false)).toBe('adopt');
    clock += 2000;
    expect(n.position()).toBeCloseTo(1202, 0);
  });
});

describe('ce qui reste propre à chacun', () => {
  it('le volume (et les sous-titres) changés ne partent jamais', () => {
    clock = 9_000_000;
    const a = member('a', false, true);
    for (const v of [0.1, 0, 1]) {
      clock += 500;
      a.player.setVolume(v);
      a.player.subtitle = v ? 'en' : 'off';
      expect(a.sync.poll({ host: false, online: true })).toBeNull();
    }
  });

  it('une commande reçue ne touche ni au volume ni aux sous-titres ; elle ne porte que position et lecture', () => {
    clock = 10_000_000;
    const a = member('a');
    const b = member('b');
    b.player.setVolume(0.3);
    b.player.volumeWrites = 0;
    const ia = gesture(a, (p) => (p.seek(77), p.play()));
    expect(Object.keys(ia).sort()).toEqual(['action', 'c', 'id', 'playing', 'time']);
    b.sync.onIntent(ia);
    expect(b.player.volume).toBe(0.3);
    expect(b.player.volumeWrites).toBe(0);
    expect(b.player.subtitle).toBe('fr');
    expect(b.player.time()).toBeCloseTo(77, 0);
  });
});
