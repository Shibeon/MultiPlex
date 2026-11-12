// « Regarder ensemble » : plusieurs personnes lisent le même titre, chacune avec son propre accès
// Plex, et l'application garde tout le monde au même endroit.
//
// Les messages passent par un relais (à héberger soi-même, par exemple sur un NAS) qui ne fait
// que les faire suivre. Tout est chiffré de bout en bout (AES-GCM) avec une clé qui n'existe que
// dans l'invitation : le relais ne voit ni titre, ni pseudo, ni position.
//
// La synchronisation ne dépend pas du lecteur : chaque lecteur (web, mpv) fournit un petit
// adaptateur (position, pause, lecture, saut, vitesse) et ce module s'occupe du reste.
import type { Metadata } from '@multiplex/core';
import { signal } from '@preact/signals';
import { settings } from './settings';
import { auth, server } from './store';

export interface Playback {
  time(): number;
  paused(): boolean;
  play(): void;
  pause(): void;
  seek(time: number): void;
  /** Vitesse de lecture, pour rattraper un petit décalage sans saut visible. */
  rate?(rate: number): void;
  /** La vidéo est chargée et avance vraiment (avant : rien n'est surveillé ni annoncé). */
  ready(): boolean;
}

/** Ce que l'on regarde : retrouvé chez chacun par son identifiant Plex. */
export interface SharedItem {
  guid: string;
  /** Serveur et numéro chez l'hôte : suffisent si l'invité a accès au même serveur. */
  server?: string;
  key?: string;
  type: string;
  title: string;
  sub?: string;
}

export interface Peer {
  id: string;
  name: string;
  thumb?: string;
  host: boolean;
  playing: boolean;
  time: number;
  item?: SharedItem;
  seen: number;
}

interface Tick {
  t: 'tick';
  id: string;
  name: string;
  thumb?: string;
  host: boolean;
  playing: boolean;
  time: number;
  item?: SharedItem;
  /** Le joueur est dans le lecteur (et non sur une fiche). */
  live: boolean;
}
interface Intent {
  t: 'intent';
  id: string;
  name: string;
  action: 'play' | 'pause' | 'seek';
  playing: boolean;
  time: number;
  item?: SharedItem;
}
interface Bye {
  t: 'bye';
  id: string;
}
type Message = Tick | Intent | Bye;

export interface TogetherState {
  code: string;
  host: boolean;
  status: 'connecting' | 'open' | 'closed';
  /** Titre de la séance (celui de l'hôte). */
  item?: SharedItem;
  /** Dernière action d'un autre participant, pour l'annoncer. */
  notice?: { name: string; action: Intent['action']; at: number };
}

export const together = signal<TogetherState | null>(null);
export const peers = signal<Peer[]>([]);
/** Titre que lit ce lecteur-ci dans la séance (pour suivre l'hôte d'un épisode à l'autre). */
export const playingGuid = signal<string | undefined>(undefined);

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Invitation : relais, salle et clé, en un seul texte à partager. */
export function makeCode(relay: string, room: string, key: string): string {
  return `MPX-${b64(new TextEncoder().encode(JSON.stringify({ r: relay, i: room, k: key })))}`;
}

export function parseCode(code: string): { relay: string; room: string; key: string } | null {
  const m = /MPX-([A-Za-z0-9_-]{20,600})/.exec(code.trim());
  if (!m) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(unb64(m[1]))) as { r?: string; i?: string; k?: string };
    if (!j.r || !/^wss?:\/\//.test(j.r) || !j.i || !/^[A-Za-z0-9_-]{16,64}$/.test(j.i) || !j.k || unb64(j.k).length !== 32) return null;
    return { relay: j.r, room: j.i, key: j.k };
  } catch {
    return null;
  }
}

/** Adresse du relais saisie dans les réglages : https://… ou wss://… (sans chemin). */
export function relayUrl(input = settings.value.togetherRelay): string {
  const s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol === 'https:') u.protocol = 'wss:';
    else if (u.protocol === 'http:') u.protocol = 'ws:';
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const me = { id: b64(crypto.getRandomValues(new Uint8Array(6))) };
const myName = () => auth.value?.user?.title || auth.value?.user?.username || 'MultiPlex';
const myThumb = () => auth.value?.user?.thumb;

let ws: WebSocket | null = null;
let key: CryptoKey | null = null;
let ticker = 0;
let retry = 0;
let closing = false;
let current: { relay: string; room: string; key: string } | null = null;

// Lecture en cours, synchronisée.
let player: Playback | null = null;
let playingItem: SharedItem | undefined;
/** Référence : où en est la séance (position, lecture/pause) et à quel instant on l'a apprise. */
let ref: { time: number; playing: boolean; at: number } | null = null;
let applyingUntil = 0;
let last = { time: 0, paused: true, at: 0 };
let watcher = 0;

async function encrypt(msg: Message): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key!, new TextEncoder().encode(JSON.stringify(msg))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out.buffer;
}

async function decrypt(data: ArrayBuffer): Promise<Message | null> {
  try {
    const bytes = new Uint8Array(data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key!, bytes.slice(12));
    const m = JSON.parse(new TextDecoder().decode(plain)) as Message;
    return m && typeof m.id === 'string' && m.id !== me.id ? m : null;
  } catch {
    return null; // mauvaise clé ou message abîmé : ignoré
  }
}

async function send(msg: Message): Promise<void> {
  if (!ws || ws.readyState !== WebSocket.OPEN || !key) return;
  ws.send(await encrypt(msg));
}

const isHost = () => !!together.value?.host;

function tick(): Tick {
  const p = player;
  return {
    t: 'tick',
    id: me.id,
    name: myName(),
    thumb: myThumb(),
    host: isHost(),
    playing: !!p && !p.paused(),
    time: p ? p.time() : (ref?.time ?? 0),
    item: playingItem ?? together.value?.item,
    live: !!p,
  };
}

function upsertPeer(m: Tick | Intent) {
  const list = peers.value.filter((p) => p.id !== m.id);
  const prev = peers.value.find((p) => p.id === m.id);
  list.push({
    id: m.id,
    name: String(m.name).slice(0, 60),
    thumb: m.t === 'tick' && typeof m.thumb === 'string' && /^https:\/\//.test(m.thumb) ? m.thumb : prev?.thumb,
    host: m.t === 'tick' ? !!m.host : (prev?.host ?? false),
    playing: !!m.playing,
    time: Number(m.time) || 0,
    item: m.item ?? prev?.item,
    seen: Date.now(),
  });
  peers.value = list.sort((a, b) => Number(b.host) - Number(a.host) || a.name.localeCompare(b.name));
}

function onMessage(m: Message) {
  if (m.t === 'bye') {
    peers.value = peers.value.filter((p) => p.id !== m.id);
    return;
  }
  upsertPeer(m);
  const t = together.value;
  if (!t) return;
  if (m.t === 'tick' && m.host && m.item && (!t.item || itemId(t.item) !== itemId(m.item))) together.value = { ...t, item: m.item };
  // Position de référence : les ticks de l'hôte, et toute action de n'importe qui.
  if (m.t === 'intent' || (m.t === 'tick' && m.host && !isHost() && m.live)) {
    ref = { time: Number(m.time) || 0, playing: !!m.playing, at: performance.now() };
  }
  if (m.t === 'intent') {
    together.value = { ...together.value!, notice: { name: m.name, action: m.action, at: Date.now() } };
    apply(true);
  }
}

/** Met le lecteur local au diapason de la référence. `hard` : action explicite d'un participant. */
function apply(hard: boolean) {
  const p = player;
  if (!p || !ref) return;
  const now = performance.now();
  const expected = ref.time + (ref.playing ? (now - ref.at) / 1000 : 0);
  const diff = p.time() - expected;
  const paused = p.paused();
  if (ref.playing === paused || Math.abs(diff) > (hard ? 0.8 : 2)) applyingUntil = now + 1500;
  if (Math.abs(diff) > (hard ? 0.8 : 2)) {
    p.seek(expected);
    p.rate?.(1);
  } else if (!hard && ref.playing && !paused && p.rate) {
    // Petit écart : on accélère ou ralentit à peine, sans saut visible.
    p.rate(Math.abs(diff) < 0.25 ? 1 : 1 - Math.max(-0.05, Math.min(0.05, diff * 0.08)));
  }
  if (ref.playing && paused) p.play();
  else if (!ref.playing && !paused) p.pause();
  last = { time: expected, paused: !ref.playing, at: now };
}

/**
 * Surveille le lecteur local : une pause, une reprise ou un saut fait ici par la personne est
 * annoncé aux autres. Ce que l'on vient d'appliquer pour suivre la séance ne compte pas.
 */
let wasReady = false;
function watch() {
  const p = player;
  if (!p) return;
  const now = performance.now();
  const time = p.time();
  const paused = p.paused();
  if (!p.ready()) {
    wasReady = false;
    last = { time, paused, at: now };
    return;
  }
  if (!wasReady) {
    // La vidéo démarre : pas une action de la personne. On se cale sur la séance si elle existe.
    wasReady = true;
    last = { time, paused, at: now };
    if (!isHost() && ref) apply(true);
    return;
  }
  const expected = last.time + (last.paused ? 0 : (now - last.at) / 1000);
  if (now > applyingUntil) {
    const jumped = Math.abs(time - expected) > 1.6;
    if (paused !== last.paused || jumped) {
      const action: Intent['action'] = jumped ? 'seek' : paused ? 'pause' : 'play';
      ref = { time, playing: !paused, at: now };
      void send({ t: 'intent', id: me.id, name: myName(), action, playing: !paused, time, item: playingItem });
    } else if (!isHost()) apply(false);
  }
  last = { time, paused, at: now };
}

function connect() {
  if (!current) return;
  const t = together.value;
  if (t) together.value = { ...t, status: 'connecting' };
  const sock = new WebSocket(`${current.relay}/r/${current.room}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    if (together.value) together.value = { ...together.value, status: 'open' };
    void send(tick());
  };
  sock.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) void decrypt(e.data).then((m) => m && onMessage(m));
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (closing || !together.value) return;
    together.value = { ...together.value, status: 'connecting' };
    // Réseau coupé ou relais redémarré : on se reconnecte, de plus en plus patiemment.
    setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
  };
}

/** Ouvre une séance (hôte) et renvoie le code d'invitation. */
export async function startTogether(item?: Metadata): Promise<string> {
  const relay = relayUrl();
  if (!relay) throw new Error('relay');
  const room = b64(crypto.getRandomValues(new Uint8Array(16)));
  const k = b64(crypto.getRandomValues(new Uint8Array(32)));
  await open({ relay, room, key: k }, true, item ? sharedOf(item) : undefined);
  return together.value!.code;
}

/** Rejoint une séance à partir d'un code d'invitation. */
export async function joinTogether(code: string): Promise<void> {
  const c = parseCode(code);
  if (!c) throw new Error('code');
  await open(c, false);
}

async function open(c: { relay: string; room: string; key: string }, host: boolean, item?: SharedItem) {
  leaveTogether();
  closing = false;
  current = c;
  key = await crypto.subtle.importKey('raw', unb64(c.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  together.value = { code: makeCode(c.relay, c.room, c.key), host, status: 'connecting', item };
  peers.value = [];
  connect();
  // Présence : un signe de vie toutes les 3 secondes ; un participant muet depuis 12 s est parti.
  ticker = window.setInterval(() => {
    void send(tick());
    const gone = Date.now() - 12_000;
    if (peers.value.some((p) => p.seen < gone)) peers.value = peers.value.filter((p) => p.seen >= gone);
    // L'hôte est parti : le premier participant (par identifiant) prend la main.
    const t = together.value;
    if (t && !t.host && !peers.value.some((p) => p.host) && peers.value.every((p) => p.id > me.id) && t.status === 'open' && peers.value.length) {
      together.value = { ...t, host: true };
    }
  }, 3000);
}

export function leaveTogether(): void {
  if (!together.value) return;
  closing = true;
  void send({ t: 'bye', id: me.id });
  clearInterval(ticker);
  const sock = ws;
  ws = null;
  setTimeout(() => sock?.close(), 100);
  together.value = null;
  peers.value = [];
  current = null;
  ref = null;
}

/** Identité d'un titre dans la séance. */
export const itemId = (i: SharedItem) => i.guid || `${i.server}/${i.key}`;

export const sharedOf = (m: Metadata): SharedItem => ({
  guid: m.guid ?? '',
  server: server.value?.id,
  key: m.ratingKey,
  type: m.type,
  title: m.type === 'episode' ? (m.grandparentTitle ?? m.title) : m.title,
  sub: m.type === 'episode' ? `S${m.parentIndex ?? 0} · E${m.index ?? 0} — ${m.title}` : m.year ? String(m.year) : undefined,
});

/**
 * Le lecteur annonce qu'il lit `item` : la séance suit ce lecteur jusqu'à `detach`. L'hôte
 * change aussi le titre de la séance (épisode suivant, par exemple).
 */
export function attachPlayer(p: Playback, item: Metadata): () => void {
  if (!together.value) return () => {};
  player = p;
  playingItem = sharedOf(item);
  playingGuid.value = itemId(playingItem);
  const t = together.value;
  if (t.host && (!t.item || itemId(t.item) !== itemId(playingItem))) together.value = { ...t, item: playingItem };
  last = { time: p.time(), paused: p.paused(), at: performance.now() };
  wasReady = false;
  clearInterval(watcher);
  watcher = window.setInterval(watch, 500);
  void send(tick());
  return () => {
    if (player !== p) return;
    clearInterval(watcher);
    p.rate?.(1);
    player = null;
    playingItem = undefined;
    playingGuid.value = undefined;
    void send(tick());
  };
}

/** Position de la séance maintenant (pour lancer la lecture au bon endroit en la rejoignant). */
export function sessionTime(): number {
  if (!ref) {
    const host = peers.value.find((p) => p.host);
    return host?.time ?? 0;
  }
  return ref.time + (ref.playing ? (performance.now() - ref.at) / 1000 : 0);
}
