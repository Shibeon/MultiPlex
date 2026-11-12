// « Qui est à l'écran ? » : à la pause, on cherche les visages de l'image et on les
// compare aux photos de la distribution. Tout est calculé sur la machine ; aucune
// image ne la quitte. Le modèle (face-api, TensorFlow.js) n'est chargé qu'au premier besoin.
import { native } from './native';
import { load, save } from './settings';

export interface XrayPerson {
  key?: string;
  name: string;
  thumb?: string;
}

export interface XrayResult {
  /** Visages trouvés dans l'image. */
  faces: number;
  /** Personnes de la distribution reconnues, de la plus sûre à la moins sûre (indices dans la liste fournie). */
  onScreen: number[];
}

type FaceApi = typeof import('@vladmandic/face-api');

/** Distance en dessous de laquelle deux visages sont tenus pour la même personne (0 = identiques). */
const SAME_PERSON = 0.55;
const CACHE_KEY = 'mp.xray.faces';
const MAX_CACHED = 400;

let api: Promise<FaceApi> | null = null;

/** Charge la bibliothèque et ses modèles, lus par l'application de bureau (pas de téléchargement). */
function engine(): Promise<FaceApi> {
  api ??= (async () => {
    const faceapi = await import('@vladmandic/face-api');
    // Les poids sont lus par l'application (fichiers embarqués) puis décodés ici : la page n'a
    // ni accès au disque ni réseau à solliciter pour eux.
    const read = async (name: string) => {
      const bytes = await native!.xray!.model(name);
      if (!bytes) throw new Error(`modèle absent : ${name}`);
      return bytes;
    };
    const loadNet = async (net: { loadFromWeightMap(map: unknown): unknown }, base: string) => {
      const manifest = JSON.parse(new TextDecoder().decode(await read(`${base}-weights_manifest.json`))) as { paths: string[]; weights: unknown[] }[];
      const parts = await Promise.all(manifest.flatMap((g) => g.paths).map(read));
      const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let offset = 0;
      for (const p of parts) {
        all.set(p, offset);
        offset += p.byteLength;
      }
      const specs = manifest.flatMap((g) => g.weights);
      await net.loadFromWeightMap(faceapi.tf.io.decodeWeights(all.buffer, specs as Parameters<typeof faceapi.tf.io.decodeWeights>[1]));
    };
    await Promise.all([loadNet(faceapi.nets.ssdMobilenetv1, 'ssd_mobilenetv1_model'), loadNet(faceapi.nets.faceLandmark68Net, 'face_landmark_68_model'), loadNet(faceapi.nets.faceRecognitionNet, 'face_recognition_model')]);
    return faceapi;
  })();
  api.catch(() => (api = null));
  return api;
}

function image(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image illisible'));
    img.src = src;
  });
}

/** Empreintes de visages déjà calculées, par personne ; null = photo sans visage exploitable. */
const prints = new Map<string, Float32Array | null>();
for (const [k, v] of Object.entries(load<Record<string, number[] | null>>(CACHE_KEY) ?? {})) prints.set(k, v ? new Float32Array(v) : null);

function remember(key: string, print: Float32Array | null): void {
  prints.set(key, print);
  const entries = [...prints.entries()].slice(-MAX_CACHED);
  // Trois décimales suffisent pour comparer, et tiennent bien moins de place.
  save(CACHE_KEY, Object.fromEntries(entries.map(([k, v]) => [k, v ? [...v].map((x) => Math.round(x * 1000) / 1000) : null])));
}

async function printOf(faceapi: FaceApi, p: XrayPerson): Promise<Float32Array | null> {
  const id = p.key ?? p.thumb ?? p.name;
  if (prints.has(id)) return prints.get(id)!;
  if (!p.thumb) return null;
  try {
    const photo = await native!.xray!.photo(p.thumb);
    if (!photo) return null;
    const found = await faceapi.detectSingleFace(await image(photo), new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 })).withFaceLandmarks().withFaceDescriptor();
    const print = found?.descriptor ?? null;
    remember(id, print);
    return print;
  } catch {
    return null;
  }
}

/**
 * Prépare la reconnaissance pendant la lecture : modèle chargé, photos de la distribution
 * analysées une à une. La première pause répond alors en une seconde au lieu de quinze.
 */
export async function warmUp(cast: XrayPerson[], alive: () => boolean): Promise<void> {
  if (!native?.xray) return;
  const faceapi = await engine();
  for (const p of cast) {
    if (!alive()) return;
    await printOf(faceapi, p);
    // On laisse respirer l'interface entre deux photos.
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Fenêtre invisible de reconnaissance : exécute les travaux demandés par les contrôles du
 * lecteur, l'un après l'autre. Une reprise de lecture abandonne ceux en cours.
 */
export function startXrayWorker(): void {
  const w = native?.xrayWorker;
  if (!w) return;
  let generation = 0;
  let chain: Promise<unknown> = Promise.resolve();
  w.onCancel(() => generation++);
  w.onJob((id, kind, cast) => {
    const mine = generation;
    const alive = () => mine === generation;
    chain = chain.then(async () => {
      try {
        if (!alive()) return w.result(id, null);
        if (kind === 'warm') {
          await warmUp(cast, alive);
          w.result(id, null);
        } else w.result(id, await whoIsOnScreen(cast, alive));
      } catch (e) {
        console.warn('[xray]', e);
        w.result(id, null);
      }
    });
  });
  w.ready();
}

/** Contrôles du lecteur : confie le calcul à la fenêtre dédiée (jamais dans la leur). */
export function runXray(kind: 'who' | 'warm', cast: XrayPerson[]): Promise<XrayResult | null> {
  return native?.xray?.run ? native.xray.run(kind, cast.map((p) => ({ key: p.key, name: p.name, thumb: p.thumb }))) : Promise.resolve(null);
}

export function cancelXray(): void {
  native?.xray?.cancel?.();
}

/** Vrai si cette application sait faire la reconnaissance (application de bureau). */
export const xrayAvailable = !!native?.xray?.run;

/**
 * Cherche dans l'image en pause les personnes de la distribution.
 * `alive` permet d'abandonner si la lecture a repris entre-temps.
 */
export async function whoIsOnScreen(cast: XrayPerson[], alive: () => boolean): Promise<XrayResult | null> {
  if (!native?.xray) return null;
  const [faceapi, frame] = await Promise.all([engine(), native.xray.frame()]);
  if (!frame || !alive()) return null;
  const faces = await faceapi.detectAllFaces(await image(frame), new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35, maxResults: 12 })).withFaceLandmarks().withFaceDescriptors();
  if (!faces.length || !alive()) return { faces: faces.length, onScreen: [] };

  // Empreintes de la distribution : calculées une fois par personne, trois à la fois.
  const known: (Float32Array | null)[] = new Array(cast.length).fill(null);
  let next = 0;
  await Promise.all(
    [0, 1, 2].map(async () => {
      while (next < cast.length && alive()) {
        const i = next++;
        known[i] = await printOf(faceapi, cast[i]);
      }
    }),
  );
  if (!alive()) return null;

  // Chaque visage désigne au plus une personne : la plus proche, si elle l'est assez.
  const best = new Map<number, number>();
  for (const face of faces) {
    let who = -1;
    let dist = SAME_PERSON;
    known.forEach((print, i) => {
      if (!print) return;
      const d = faceapi.euclideanDistance(face.descriptor, print);
      if (d < dist) {
        dist = d;
        who = i;
      }
    });
    if (who >= 0 && dist < (best.get(who) ?? 1)) best.set(who, dist);
  }
  return { faces: faces.length, onScreen: [...best.entries()].sort((a, b) => a[1] - b[1]).map(([i]) => i) };
}
