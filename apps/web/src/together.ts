// « Regarder ensemble » : plusieurs personnes lisent le même titre, chacune avec son propre accès
// Plex, et l'application garde tout le monde au même endroit.
//
// Les messages passent par un relais (à héberger soi-même, par exemple sur un NAS) qui ne fait
// que les faire suivre. Tout est chiffré de bout en bout (AES-GCM) avec une clé qui n'existe que
// dans l'invitation : le relais ne voit ni titre, ni pseudo, ni position.
//
// La synchronisation ne dépend pas du lecteur : chaque lecteur (web, mpv) fournit un petit
// adaptateur (position, pause, lecture, saut, vitesse) et la règle commune (@multiplex/core,
// togethersync.ts : dernier écrivain gagnant dans l'ordre de Lamport) s'occupe du reste. Hôte et
// participants commandent la lecture de la même façon ; volume, sous-titres, pistes et qualité
// restent propres à chacun.
//
// Séances visibles par les amis : un hôte peut rendre sa séance visible à ses amis Plex, et à eux
// seuls. Il joint à son annonce les numéros de compte de ses amis (lus ici, sur plex.tv, avec son
// propre jeton) ; le relais reconnaît chacun grâce aux partages du propriétaire du serveur et ne
// la liste qu'à eux. Un ami la voit dans la liste et y entre sans code : l'hôte lui remet le
// secret de l'invitation, chiffré pour lui seul.
import {
  DemoServer,
  MAX_ROOM_LOOKUP,
  PlexServer,
  RelayBackoff,
  TogetherSync,
  b64,
  hostYields,
  deriveLegacy,
  deriveSession,
  findRelay,
  findRoom,
  formatInvite,
  friendAllowList,
  friendsForAnnounce,
  friendsUrl,
  getServers,
  grantRequestKeys,
  inviteText,
  isFriendsAnswer,
  makeSecret,
  openGrant,
  parseInvite,
  plexFriends,
  relayCandidates,
  relayDiscoverable,
  relayUrl as coreRelayUrl,
  roomsUrl,
  sealGrant,
  serverCredential,
  type FriendCard,
  type FriendsAnswer,
  type FriendsSent,
  type GrantPayload,
  type Metadata,
  type PlexResource,
  type SyncAction,
  type SyncPlayer,
} from '@multiplex/core';
import { signal } from '@preact/signals';
import { settings } from './settings';
import { auth, client, resources, server } from './store';

/** Ce que le lecteur expose à la séance : position et lecture/pause, rien d'autre. */
export type Playback = SyncPlayer;

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
  /** Dans le lecteur (et non sur une fiche). */
  live: boolean;
  item?: SharedItem;
  seen: number;
}

/**
 * Présence, toutes les 3 s. `c`/`by` : tampon de la commande que suit son auteur (togethersync.ts).
 * `want` : son auteur arrive ou revient, et demande une présence tout de suite à chacun.
 * `vis` (hôte) : séance visible par les amis. Qui deviendrait hôte la reprend à son compte, mais le
 * relais ne liste une séance que pour le compte qui l'a annoncée le premier : chez un autre, elle
 * reste « non listée » (les invitations par code marchent toujours).
 * `hc` (hôte) : quand il a pris la main (horloge de Lamport ; 0 pour l'hôte d'origine). Deux hôtes
 * après une coupure : celui qui l'a prise le plus récemment reste (voir hostYields).
 */
interface Tick {
  t: 'tick';
  id: string;
  name: string;
  thumb?: string;
  host: boolean;
  playing: boolean;
  time: number;
  item?: SharedItem;
  live: boolean;
  c: number;
  by: string;
  vis?: boolean;
  hc?: number;
  want?: boolean;
}
/** Commande : lecture, pause ou saut, tamponnée (`c` = horloge de Lamport de son auteur `id`). */
interface Intent {
  t: 'intent';
  id: string;
  name: string;
  action: SyncAction;
  playing: boolean;
  time: number;
  item?: SharedItem;
  c: number;
}
interface Bye {
  t: 'bye';
  id: string;
}
type Message = Tick | Intent | Bye;

export interface TogetherState {
  /** Invitation à partager : « MPX-K7Q2-9XFD ». */
  code: string;
  /**
   * Hôte seulement, faux quand ses amis ne trouveront pas le relais grâce au serveur Plex : il
   * faut alors leur donner `fullCode`, qui porte l'adresse du relais.
   */
  discoverable?: boolean;
  fullCode?: string;
  host: boolean;
  status: 'connecting' | 'open' | 'closed';
  /** Titre de la séance (celui de l'hôte). */
  item?: SharedItem;
  /** Dernière action d'un autre participant, pour l'annoncer. */
  notice?: { name: string; action: SyncAction; at: number };
  /** Séance visible par les amis (choix de l'hôte). */
  visible: boolean;
  /** Hôte : la séance est-elle vraiment listée par le relais ? (« no » : ce relais ne le peut pas). */
  listed?: 'pending' | 'yes' | 'no';
}

export const together = signal<TogetherState | null>(null);
export const peers = signal<Peer[]>([]);
/** Titre que lit ce lecteur-ci dans la séance (pour suivre l'hôte d'un épisode à l'autre). */
export const playingGuid = signal<string | undefined>(undefined);

/**
 * Invitation : « MPX-K7Q2-9XFD », 8 signes sans adresse (voir @multiplex/core, together.ts). Le
 * secret, salé par l'identifiant du serveur Plex de l'hôte, donne la clé de chiffrement et le
 * numéro de salle ; le relais ne reçoit que ce numéro. L'application de l'invité retrouve le relais
 * grâce aux serveurs Plex qu'elle voit (voir joinTogether). Quand l'hôte sait que ses amis ne le
 * trouveront pas, il peut donner la forme de secours « MPX-K7Q2-9XFD@relais.exemple.fr ».
 *
 * Les anciennes invitations (« MPX-<secret>@<relais> », et « MPX- » suivi de JSON) restent acceptées.
 */
export const parseCode = parseInvite;

/** Adresse du relais saisie dans les réglages : https://… ou wss://… (sans chemin). */
export const relayUrl = (input = settings.value.togetherRelay): string => coreRelayUrl(input);

/**
 * Serveurs Plex que voit ce compte (avec leurs connexions publiées par plex.tv) : ceux de la liste
 * des serveurs s'ils sont déjà chargés, sinon demandés une fois à plex.tv.
 */
let directory: Promise<PlexResource[]> | null = null;
function servers(): Promise<PlexResource[]> {
  if (resources.value.length) return Promise.resolve(resources.value);
  const a = auth.value;
  if (!a || server.value instanceof DemoServer) return Promise.resolve([]);
  directory ??= getServers(client, a.token).catch(() => {
    directory = null;
    return [];
  });
  return directory;
}

/** Relais déjà reconnus (ou écartés : ce n'est pas un relais MultiPlex) pendant ce lancement. */
const knownRelays = new Map<string, boolean>();
/** Relais injoignables, sans liste ou d'un autre serveur : redemandés de plus en plus rarement. */
const relayBackoff = new RelayBackoff();

/** Demande à un relais lesquelles de ces salles existent (4 secondes au plus). */
async function askRelay(relay: string, rooms: string[]): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(roomsUrl(relay, rooms), { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

const me = { id: b64(crypto.getRandomValues(new Uint8Array(6))) };
const myName = () => auth.value?.user?.title || auth.value?.user?.username || 'MultiPlex';
const myThumb = () => auth.value?.user?.thumb;

/** La règle de synchronisation (voir @multiplex/core, togethersync.ts). */
const sync = new TogetherSync(me.id);

let ws: WebSocket | null = null;
let key: CryptoKey | null = null;
let ticker = 0;
let ticks = 0;
let retry = 0;
let closing = false;
let current: { relay: string; room: string; owner?: string } | null = null;
/** Secret de l'invitation et serveur qui la sale (invitations courtes) : de quoi faire entrer un ami. */
let grant: { secret: string; server: string } | null = null;
/**
 * Annonce de la séance au relais depuis la dernière connexion : « asking » pendant qu'on prouve
 * l'accès au serveur, « on » une fois annoncée avec un ticket (les rafraîchissements suivent alors
 * sans ticket).
 */
let announcing: 'off' | 'asking' | 'on' = 'off';
/** Dernière fiche envoyée : on ne réannonce que sur un changement utile, pas à chaque geste. */
let cardSent = { sig: '', at: 0 };
/** Relais qui ne peut pas lister la séance : on réessaie de plus en plus rarement (état « no » stable). */
let listRetry = { at: 0, delay: 0 };
/** Hôte : quand il a pris la main (0 : il a ouvert la séance). */
let hostClaim = 0;
/** Amis à qui la clé a déjà été remise (une fois chacun) et quand (quelques-unes par 10 s). */
let granted = new Set<string>();
let grantTimes: number[] = [];
let lastWantReply = 0;

// Lecture en cours, synchronisée.
let player: Playback | null = null;
let playingItem: SharedItem | undefined;
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

const online = () => !!ws && ws.readyState === WebSocket.OPEN && !!key;

async function send(msg: Message): Promise<void> {
  if (!online()) return;
  ws!.send(await encrypt(msg));
}

/** Message au relais lui-même (texte, en clair) : annonce et remise de clé. */
function sendControl(msg: Record<string, unknown>): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const isHost = () => !!together.value?.host;

/** Où en est ce lecteur-ci, ou la séance quand on n'est pas dans le lecteur. */
function here(): { time: number; playing: boolean } {
  const p = player;
  if (p) return { time: p.time(), playing: !p.paused() };
  const r = sync.ref;
  return { time: sync.position() ?? 0, playing: !!r?.playing };
}

function tick(want = false): Tick {
  const h = here();
  const t = together.value;
  return {
    t: 'tick',
    id: me.id,
    name: myName(),
    thumb: myThumb(),
    host: isHost(),
    ...h,
    item: playingItem ?? t?.item,
    live: !!player,
    ...sync.stamp(),
    vis: t?.host ? t.visible : undefined,
    hc: t?.host ? hostClaim : undefined,
    want: want || undefined,
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
    live: m.t === 'tick' ? !!m.live : (prev?.live ?? true),
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
  if (m.t === 'tick') {
    // Deux hôtes (retour après une coupure) : un seul reste, l'autre redevient participant.
    if (m.host && t.host && hostYields({ hc: hostClaim, id: me.id }, { hc: Number(m.hc) || 0, id: m.id })) {
      stepDown();
      return onMessage(m);
    }
    if (m.host && m.item && (!t.item || itemId(t.item) !== itemId(m.item))) together.value = { ...together.value!, item: m.item };
    if (m.host && !t.host && typeof m.vis === 'boolean' && m.vis !== t.visible) together.value = { ...together.value!, visible: m.vis };
    sync.onTick(m, t.host);
    // Quelqu'un arrive ou revient : il a besoin de notre état tout de suite (au plus une fois par seconde).
    if (m.want && Date.now() - lastWantReply > 1000) {
      lastWantReply = Date.now();
      void send(tick());
    }
    return;
  }
  // Commande : appliquée seulement si elle est la plus récente (voir togethersync.ts).
  if (sync.onIntent(m)) {
    together.value = { ...together.value!, notice: { name: String(m.name).slice(0, 60), action: m.action, at: Date.now() } };
    // La fiche ne change que pour lecture/pause (la position suit au rafraîchissement suivant).
    if (isHost()) announce();
  }
}

/** Message texte du relais : annonce acceptée ou refusée, demande d'entrée d'un ami. */
function onControl(m: { t?: string; error?: string; peer?: string; pub?: string }) {
  const t = together.value;
  if (!t) return;
  if (m.t === 'announced') {
    listRetry = { at: 0, delay: 0 };
    if (t.listed !== 'yes') together.value = { ...t, listed: 'yes' };
  } else if (m.t === 'error' && ['ticket', 'unavailable', 'owner', 'private', 'proof', 'card', 'friends'].includes(m.error ?? '')) {
    notListed();
  } else if (m.t === 'key-request' && typeof m.peer === 'string' && typeof m.pub === 'string') {
    void handOver(m.peer, m.pub);
  }
}

/**
 * Un ami autorisé (vérifié par le relais auprès du serveur Plex) demande à entrer : l'hôte lui
 * remet le secret de l'invitation et l'état de la séance, chiffrés pour sa clé éphémère seule.
 */
async function handOver(peer: string, pub: string): Promise<void> {
  const t = together.value;
  if (!t?.host || !t.visible || !grant || announcing !== 'on') return;
  // Une seule réponse par demandeur, et quelques-unes par 10 s : une rafale de demandes ne prend
  // pas le budget de messages de l'hôte (le relais borne aussi ce qu'il fait suivre).
  const now = Date.now();
  grantTimes = grantTimes.filter((at) => now - at < 10_000);
  if (granted.has(peer) || grantTimes.length >= 5) return;
  granted.add(peer);
  grantTimes.push(now);
  try {
    const sealed = await sealGrant(pub, { secret: grant.secret, server: grant.server, state: { ...here(), ...sync.stamp() } });
    sendControl({ t: 'key-grant', peer, pub: sealed.pub, box: sealed.box });
  } catch {
    /* clé publique invalide : ignorée */
  }
}

function connect() {
  if (!current) return;
  const t = together.value;
  if (t) together.value = { ...t, status: 'connecting' };
  const sock = new WebSocket(`${current.relay}/r/${current.room}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  announcing = 'off';
  granted = new Set();
  sock.onopen = () => {
    retry = 0;
    if (together.value) together.value = { ...together.value, status: 'open' };
    // Arrivée ou retour : on demande l'état de chacun (resynchronisation, voir togethersync.ts).
    void send(tick(true));
    if (isHost()) announce();
  };
  sock.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) void decrypt(e.data).then((m) => m && onMessage(m));
    else if (typeof e.data === 'string') {
      try {
        onControl(JSON.parse(e.data));
      } catch {
        /* message illisible : ignoré */
      }
    }
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

// ----- Jetons présentés au relais (séances visibles) --------------------------------------------

/** Jeton délégué par le serveur actuel (quand plex.tv ne donne pour lui que le jeton du compte). */
let delegated: { server: string; token: string; until: number } | null = null;

/**
 * Jeton qui prouve au relais d'un serveur qu'on y a accès : le jeton propre à ce serveur, ou un
 * jeton délégué par lui. Jamais le jeton du compte plex.tv (voir @multiplex/core, serverCredential).
 */
async function credentialFor(res: PlexResource): Promise<string | null> {
  const own = serverCredential(res, auth.value?.token);
  if (own) return own;
  const srv = server.value;
  if (!(srv instanceof PlexServer) || srv.id !== res.clientIdentifier) return null;
  if (delegated && delegated.server === srv.id && delegated.until > Date.now()) return delegated.token;
  try {
    const token = await srv.delegationToken();
    if (token === auth.value?.token) return null;
    delegated = { server: srv.id, token, until: Date.now() + 10 * 60_000 };
    return token;
  } catch {
    return null;
  }
}

/** Amis Plex de ce compte (numéros de compte plex.tv), relus au plus toutes les 2 minutes. */
let myFriends: { token: string; ids: string[]; at: number } | null = null;
const FRIENDS_TTL_MS = 2 * 60_000;

/**
 * Liste d'amis à joindre à l'annonce : lue sur plex.tv avec le jeton du compte, ici (ni le jeton
 * ni la liste ne passent par le relais ; seuls les numéros partent avec l'annonce). null quand
 * plex.tv ne répond pas : la séance n'est alors plus listée (jamais une liste périmée).
 */
async function friendIds(): Promise<string[] | null> {
  const a = auth.value;
  if (!a?.token) return null;
  if (myFriends && myFriends.token === a.token && Date.now() - myFriends.at < FRIENDS_TTL_MS) return myFriends.ids;
  try {
    const ids = friendAllowList(await plexFriends(client, a.token), a.user.id);
    myFriends = { token: a.token, ids, at: Date.now() };
    return ids;
  } catch {
    return null;
  }
}

/**
 * Liste d'amis remise au relais pendant cette annonce, et la lecture de plex.tv dont elle vient.
 * Renvoyée quand elle change ET après chaque relecture : le relais ne garde que les comptes qu'il
 * connaît déjà, et un ami qui vient de recevoir un partage n'y entre qu'au renvoi suivant.
 */
let friendsSent: FriendsSent = { ids: '', at: 0 };

/** Liste du relais pour ce jeton (jeton dans le corps : ni dans l'adresse, ni en en-tête). */
async function askFriends(relay: string, token: string): Promise<FriendsAnswer | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    // text/plain : requête « simple », sans aller-retour OPTIONS.
    const r = await fetch(friendsUrl(relay), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ token }), cache: 'no-store', signal: ctl.signal });
    if (!r.ok) return null;
    const a: unknown = await r.json();
    return isFriendsAnswer(a) ? a : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fiche annoncée : titre, position (et le nom de l'hôte, que le relais remplace par celui de son
 * compte plex.tv). Rien sur l'appareil, l'adresse ou le flux.
 */
function card(): FriendCard | null {
  const t = together.value;
  const it = t?.item ?? playingItem;
  if (!it) return null;
  return { name: myName(), title: it.title, sub: it.sub, type: it.type, guid: it.guid || undefined, key: it.key, ...here() };
}

const cardSig = (c: FriendCard) => [c.title, c.sub, c.key, c.guid, c.playing].join('|');

/** Le relais ne liste pas la séance : état « no » stable, nouvel essai de plus en plus tard. */
function notListed(): void {
  announcing = 'off';
  const delay = listRetry.delay ? Math.min(30 * 60_000, listRetry.delay * 2) : 60_000;
  listRetry = { at: Date.now() + delay, delay };
  if (together.value && together.value.listed !== 'no') together.value = { ...together.value, listed: 'no' };
}

/**
 * Hôte d'une séance visible : l'annonce au relais. La première fois, il prouve qui il est (ticket
 * obtenu avec le jeton du serveur), présente la preuve d'hôte tirée du secret et la liste de ses
 * amis Plex ; ensuite, la fiche n'est renvoyée que quand elle change (titre, lecture/pause), au
 * plus toutes les 5 s, et toutes les 15 s pour la position (`refresh`). La liste d'amis est relue à
 * chaque annonce (au plus toutes les 2 minutes auprès de plex.tv) et renvoyée quand elle change :
 * un ami retiré perd la séance. Le jeton du serveur ne part que vers un relais trouvé sur les noms
 * publics de ce serveur, dont le Plex est ce serveur ET qui ne liste qu'aux amis de l'hôte
 * (vérifié sur /rooms, avant tout jeton).
 */
function announce(refresh = false): void {
  const t = together.value;
  if (!t?.host || !t.visible || !grant || !current?.owner || !online()) return;
  const c = card();
  if (!c) return;
  const now = Date.now();
  if (announcing === 'asking') return;
  if (announcing === 'on') {
    const sig = cardSig(c);
    if (!refresh && (sig === cardSent.sig || now - cardSent.at < 5000)) return;
    cardSent = { sig, at: now };
    const sock = ws;
    const proof = current.owner;
    void friendIds().then((ids) => {
      if (ws !== sock || announcing !== 'on') return;
      // plex.tv muet : on ne garde pas une liste qui n'est peut-être plus la bonne. L'annonce est
      // libérée (la séance n'est plus listée) ; elle reprendra, avec une liste fraîche, plus tard.
      const next = friendsForAnnounce(ids, friendsSent, myFriends?.at ?? 0);
      if (!next) {
        sendControl({ t: 'release' });
        return notListed();
      }
      friendsSent = next.sent;
      sendControl({ t: 'announce', proof, card: card() ?? c, ...(next.friends ? { friends: next.friends } : {}) });
    });
    return;
  }
  if (now < listRetry.at) return;
  announcing = 'asking';
  const sock = ws;
  const relay = current.relay;
  const proof = current.owner;
  const srvId = grant.server;
  if (t.listed !== 'yes' && t.listed !== 'no') together.value = { ...t, listed: 'pending' };
  void (async () => {
    const res = (await servers()).find((r) => r.clientIdentifier === srvId);
    const found = res && relayDiscoverable(relay, [res]) ? await findRelay([relay], (r) => askRelay(r, []), { server: srvId }) : null;
    const token = found?.friends && res ? await credentialFor(res) : null;
    const answer = token ? await askFriends(relay, token) : null;
    // Sans liste d'amis (plex.tv muet), pas d'annonce : jamais de séance visible par tous.
    const ids = answer ? await friendIds() : null;
    if (ws !== sock || !together.value) return;
    if (!answer || answer.server !== srvId || !answer.friendsOnly || !ids) return notListed();
    const c2 = card();
    if (!c2 || !together.value.visible || !together.value.host) {
      announcing = 'off';
      return;
    }
    announcing = 'on';
    cardSent = { sig: cardSig(c2), at: Date.now() };
    friendsSent = { ids: ids.join(','), at: myFriends?.at ?? 0 };
    sendControl({ t: 'announce', ticket: answer.ticket, proof, card: c2, friends: ids });
  })();
}

/** Hôte qui cède la main (un autre hôte l'a prise plus récemment) : il libère l'annonce. */
function stepDown(): void {
  const t = together.value;
  if (!t?.host) return;
  if (announcing === 'on') sendControl({ t: 'release' });
  announcing = 'off';
  together.value = { ...t, host: false, listed: undefined };
}

/** Hôte : rend la séance visible par ses amis, ou la retire de leur liste. */
export function setVisible(on: boolean): void {
  const t = together.value;
  if (!t) return;
  together.value = { ...t, visible: on, listed: on ? t.listed : undefined };
  if (!t.host) return;
  if (on) {
    listRetry = { ...listRetry, at: 0 };
    announce();
  } else {
    sendControl({ t: 'unlist' });
    announcing = 'off';
  }
  void send(tick());
}

// ----- Séances des amis ---------------------------------------------------------------------------

/** Une séance visible d'un ami, telle qu'un relais la liste. */
export interface FriendSession {
  relay: string;
  /** Serveur Plex du relais (celui dont l'accès a été vérifié). */
  server: string;
  serverName: string;
  room: string;
  card: FriendCard;
  count: number;
  /** Instant (Date.now) de la dernière annonce de l'hôte. */
  at: number;
  ticket: string;
  ticketUntil: number;
}

export const friendSessions = signal<FriendSession[]>([]);

/**
 * Demande aux relais des serveurs que l'on voit les séances visibles. Pour chaque serveur : son
 * relais (cherché sur ses noms publics, comme pour une invitation), puis la liste, en présentant
 * le jeton de CE serveur. La séance que l'on est en train de suivre n'y figure pas.
 */
export async function refreshFriendSessions(): Promise<FriendSession[]> {
  if (!auth.value || server.value instanceof DemoServer) return friendSessions.value;
  const list = (await servers()).slice(0, MAX_ROOM_LOOKUP);
  const found = await Promise.all(
    list.map(async (res): Promise<FriendSession[]> => {
      try {
        // Seulement un relais qui sait lister et dont le Plex est ce serveur : vérifié avant que
        // le jeton ne parte ; les échecs sont mis de côté (voir RelayBackoff).
        const relay = await findRelay(relayCandidates([res]), (r) => askRelay(r, []), { known: knownRelays, backoff: relayBackoff, server: res.clientIdentifier });
        if (!relay) return [];
        const token = await credentialFor(res);
        const answer = token ? await askFriends(relay.relay, token) : null;
        if (!answer || answer.server !== res.clientIdentifier || !answer.friendsOnly) return [];
        const now = Date.now();
        return answer.sessions.map((s) => ({
          relay: relay.relay,
          server: res.clientIdentifier,
          serverName: res.name,
          room: s.room,
          card: s.card,
          count: s.count,
          at: now - s.age,
          ticket: answer.ticket,
          ticketUntil: now + answer.ttl * 1000 - 15_000,
        }));
      } catch {
        return [];
      }
    }),
  );
  setFriendSessions(found.flat());
  return friendSessions.value;
}

/** Nouvelle liste (la séance suivie ici en est retirée). */
export function setFriendSessions(list: FriendSession[]): void {
  friendSessions.value = list.filter((s) => s.room !== current?.room);
}

/** Titre d'une séance d'ami, pour le retrouver chez soi. */
export const friendItem = (s: Pick<FriendSession, 'card' | 'server'>): SharedItem => ({
  guid: s.card.guid ?? '',
  server: s.server,
  key: s.card.key,
  type: s.card.type ?? 'movie',
  title: s.card.title,
  sub: s.card.sub,
});

/** Position d'une séance d'ami maintenant (d'après l'annonce de l'hôte). */
export const friendTime = (s: FriendSession): number => s.card.time + (s.card.playing ? (Date.now() - s.at) / 1000 : 0);

/**
 * Entre dans la séance d'un ami, sans code : le relais, qui a vérifié l'accès au serveur, laisse
 * entrer avec le ticket ; l'hôte remet alors le secret de l'invitation, chiffré pour une clé
 * éphémère créée ici. La salle qu'on en tire doit être celle qui était listée.
 */
export async function joinFriend(s: FriendSession): Promise<void> {
  let session = s;
  if (Date.now() > session.ticketUntil) {
    const fresh = (await refreshFriendSessions()).find((x) => x.room === s.room && x.relay === s.relay);
    if (!fresh) throw new Error('notfound');
    session = fresh;
  }
  const req = await grantRequestKeys();
  const payload = await new Promise<GrantPayload>((resolve, reject) => {
    let done = false;
    // Le ticket voyage dans le premier message, jamais dans l'adresse (que les proxys journalisent).
    const sock = new WebSocket(`${session.relay}/r/${session.room}`);
    const finish = (err: Error | null, p?: GrantPayload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      if (err) reject(err);
      else resolve(p!);
    };
    const timer = setTimeout(() => finish(new Error('nohost')), 10_000);
    sock.onopen = () => sock.send(JSON.stringify({ t: 'key-request', ticket: session.ticket, pub: req.pub }));
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m: { t?: string; pub?: string; box?: string; error?: string };
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'key-grant' && m.pub && m.box) {
        openGrant(req.priv, req.pub, m.pub, m.box).then(
          (p) => finish(null, p),
          () => finish(new Error('failed')),
        );
      } else if (m.t === 'error') finish(new Error(m.error === 'nohost' ? 'nohost' : 'failed'));
    };
    sock.onerror = () => finish(new Error('failed'));
    sock.onclose = () => finish(new Error('notfound'));
  });
  const d = await deriveSession(payload.secret, payload.server);
  if (d.room !== session.room) throw new Error('failed');
  open({ relay: session.relay, ...d }, { code: formatInvite(payload.secret) }, false, friendItem(session), { secret: payload.secret, server: payload.server }, true);
  if (payload.state) sync.adopt(payload.state);
}

/** Ressource plex.tv d'un serveur que voit ce compte (pour y lire le titre d'une séance d'ami). */
export async function serverResource(id: string): Promise<PlexResource | undefined> {
  return (await servers()).find((r) => r.clientIdentifier === id);
}

// ----- Ouvrir, rejoindre, quitter ----------------------------------------------------------------

/** Ouvre une séance (hôte) et renvoie le code d'invitation. `visible` : visible par les amis. */
export async function startTogether(item?: Metadata, opts: { visible?: boolean } = {}): Promise<string> {
  const relay = relayUrl();
  if (!relay) throw new Error('relay');
  const secret = makeSecret();
  const srv = server.value;
  const d = await deriveSession(secret, srv?.id ?? '');
  const code = formatInvite(secret);
  const visible = (opts.visible ?? settings.value.togetherVisible) && !!srv?.id;
  open({ relay, ...d }, { code, fullCode: formatInvite(secret, relay) }, true, item ? sharedOf(item) : undefined, srv?.id ? { secret, server: srv.id } : null, visible);
  // Les amis trouveront-ils ce relais grâce au serveur ? (voir relayCandidates)
  void servers().then((list) => {
    const mine = list.filter((r) => r.clientIdentifier === srv?.id);
    const t = together.value;
    if (t?.code === code) together.value = { ...t, discoverable: relayDiscoverable(relay, mine) };
  });
  return code;
}

/**
 * Rejoint une séance à partir d'un code d'invitation. Une invitation courte ne dit ni le relais ni
 * le serveur : on calcule la salle pour chaque serveur Plex visible (le secret est salé par celui
 * de l'hôte), puis on la demande, en même temps, à son propre relais et aux relais que l'on peut
 * trouver aux adresses publiques de ces serveurs (voir relayCandidates). Le relais qui connaît
 * l'une des salles est le bon.
 */
export async function joinTogether(code: string): Promise<void> {
  const c = parseCode(code);
  if (!c) throw new Error('code');
  if (c.v !== 3) {
    open({ relay: c.relay, ...(await deriveLegacy(c)) }, { code: inviteText(c) }, false, undefined, null, false);
    return;
  }
  const list = await servers();
  const ids = [...new Set([server.value?.id, ...list.map((r) => r.clientIdentifier)].filter((id): id is string => !!id))].slice(0, MAX_ROOM_LOOKUP);
  const sessions = await Promise.all(ids.map((id) => deriveSession(c.secret, id)));
  const relays = [c.relay, relayUrl(), ...relayCandidates(list)].filter((r): r is string => !!r);
  if (!relays.length) throw new Error('relay');
  const found = await findRoom(
    relays,
    sessions.map((s) => s.room),
    askRelay,
    knownRelays,
  );
  const i = found ? sessions.findIndex((s) => s.room === found.room) : -1;
  if (!found || i < 0) throw new Error('notfound');
  open({ relay: found.relay, ...sessions[i] }, { code: inviteText(c) }, false, undefined, { secret: c.secret, server: ids[i] }, false);
}

function open(d: { relay: string; room: string; key: CryptoKey; owner?: string }, codes: { code: string; fullCode?: string }, host: boolean, item: SharedItem | undefined, g: typeof grant, visible: boolean) {
  leaveTogether();
  closing = false;
  current = { relay: d.relay, room: d.room, owner: d.owner };
  key = d.key;
  grant = g;
  hostClaim = 0;
  listRetry = { at: 0, delay: 0 };
  together.value = { ...codes, host, status: 'connecting', item, visible };
  peers.value = [];
  friendSessions.value = friendSessions.value.filter((s) => s.room !== d.room);
  connect();
  // Présence : un signe de vie toutes les 3 secondes ; un participant muet depuis 12 s est parti.
  ticks = 0;
  ticker = window.setInterval(() => {
    void send(tick());
    const gone = Date.now() - 12_000;
    if (peers.value.some((p) => p.seen < gone)) peers.value = peers.value.filter((p) => p.seen >= gone);
    const t = together.value;
    // L'hôte est parti : le premier participant (par identifiant) prend la main. Il essaie de
    // l'annoncer, mais le relais ne la liste que pour le compte de l'hôte d'origine.
    if (t && !t.host && !peers.value.some((p) => p.host) && peers.value.every((p) => p.id > me.id) && t.status === 'open' && peers.value.length) {
      hostClaim = sync.clock + 1;
      together.value = { ...t, host: true };
      announce();
    }
    // Hôte d'une séance visible : la position annoncée est rafraîchie toutes les 15 s.
    if (++ticks % 5 === 0 && isHost()) announce(true);
  }, 3000);
}

export function leaveTogether(): void {
  if (!together.value) return;
  closing = true;
  void send({ t: 'bye', id: me.id });
  // L'hôte part : l'annonce est libérée (pas rendue privée) ; seul son compte pourra la réannoncer.
  if (isHost() && announcing === 'on') sendControl({ t: 'release' });
  clearInterval(ticker);
  const sock = ws;
  ws = null;
  setTimeout(() => sock?.close(), 100);
  together.value = null;
  peers.value = [];
  current = null;
  grant = null;
  announcing = 'off';
  sync.reset();
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

/** Le titre `m` est-il celui de la séance ? */
export function isSessionItem(m: Pick<Metadata, 'guid' | 'ratingKey'>, it = together.value?.item): boolean {
  if (!it) return false;
  return (!!it.guid && m.guid === it.guid) || (it.server === server.value?.id && it.key === m.ratingKey);
}

/**
 * Une seule lecture pendant une séance. Lancer `m` est-il possible tel quel (« none » : c'est le
 * titre de la séance, ou l'hôte passe à un autre épisode de la même série), à proposer à l'hôte
 * pour tout le monde (« switch »), ou faut-il quitter la séance pour le regarder (« leave ») ?
 */
export function playConflict(m: Pick<Metadata, 'guid' | 'ratingKey' | 'type' | 'grandparentTitle'>): 'none' | 'switch' | 'leave' {
  const t = together.value;
  if (!t) return 'none';
  const it = t.item;
  if (!it) return t.host ? 'none' : 'leave';
  if (isSessionItem(m, it)) return 'none';
  if (t.host && m.type === 'episode' && it.type === 'episode' && m.grandparentTitle === it.title) return 'none';
  return t.host ? 'switch' : 'leave';
}

/** Hôte : la séance passe à ce titre, pour tout le monde. */
export function shareTitle(m: Metadata): void {
  const t = together.value;
  if (!t?.host) return;
  together.value = { ...t, item: sharedOf(m) };
  void send(tick());
  announce();
}

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
  sync.attach(p);
  clearInterval(watcher);
  watcher = window.setInterval(() => {
    const out = sync.poll({ host: isHost(), online: online() });
    if (!out) return;
    void send({ t: 'intent', id: me.id, name: myName(), ...out, item: playingItem });
    if (isHost()) announce();
  }, 500);
  void send(tick());
  return () => {
    if (player !== p) return;
    clearInterval(watcher);
    sync.detach(p);
    player = null;
    playingItem = undefined;
    playingGuid.value = undefined;
    void send(tick());
  };
}

/** Position de la séance maintenant (pour lancer la lecture au bon endroit en la rejoignant). */
export function sessionTime(): number {
  const at = sync.position();
  if (at !== null) return at;
  const host = peers.value.find((p) => p.host);
  return host?.time ?? 0;
}
