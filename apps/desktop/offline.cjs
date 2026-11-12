// Bibliothèque hors ligne de l'application de bureau.
//
// Chaque titre téléchargé pour le hors ligne occupe un dossier lisible (Films/Titre (année),
// Séries/Série/Saison N) : le fichier d'origine, son affiche, son image de fond, ses sous-titres
// externes. L'index (library.json, à la racine du dossier choisi) garde la fiche du titre,
// la position de lecture et ce qui reste à renvoyer au serveur.
//
// La page ne manipule jamais de chemin : elle désigne les titres par leur identifiant, et
// c'est ce module qui retrouve les fichiers sur le disque.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const clean = (s) =>
  String(s ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '') || 'Sans titre';

class OfflineLibrary {
  constructor(app, dirOverride) {
    this.app = app;
    this.fixed = !!dirOverride;
    this.cfgFile = path.join(app.getPath('userData'), 'offline.json');
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(this.cfgFile, 'utf8'));
    } catch {
      /* premier lancement */
    }
    // Tests : un dossier imposé, jamais celui de l'utilisateur.
    this.dir = dirOverride ? dirOverride : typeof cfg.dir === 'string' && path.isAbsolute(cfg.dir) ? cfg.dir : path.join(app.getPath('videos'), 'MultiPlex');
    this.load();
  }

  get indexFile() {
    return path.join(this.dir, 'library.json');
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      this.entries = Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      this.entries = [];
    }
    // Un téléchargement coupé par la fermeture de l'application ne reprendra pas seul.
    for (const e of this.entries) if (e.state === 'downloading') e.state = 'failed';
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }, null, 1));
    fs.renameSync(tmp, this.indexFile);
  }

  setDir(dir) {
    if (this.entries.length) throw new Error('not-empty');
    if (this.fixed) throw new Error('fixed');
    this.dir = dir;
    fs.writeFileSync(this.cfgFile, JSON.stringify({ dir }));
    this.load();
  }

  /** Identifiant d'un titre : serveur et numéro, lisibles dans un nom de dossier. */
  idOf(p) {
    return `${clean(p.serverId)}-${clean(p.ratingKey)}`;
  }

  get(id) {
    return this.entries.find((e) => e.id === id);
  }

  abs(e, rel) {
    return rel ? path.join(this.dir, e.folder, rel) : undefined;
  }

  /** Ce que la page affiche : fiches, images (adresses file:), état, place occupée et libre. */
  info() {
    let free;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const s = fs.statfsSync(this.dir);
      free = s.bavail * s.bsize;
    } catch {
      free = undefined;
    }
    const url = (e, rel) => (rel && fs.existsSync(this.abs(e, rel)) ? pathToFileURL(this.abs(e, rel)).href : undefined);
    return {
      dir: this.dir,
      free,
      used: this.entries.reduce((n, e) => n + (e.size || 0), 0),
      entries: this.entries.map((e) => ({
        ...e,
        poster: url(e, e.poster),
        art: url(e, e.art),
        missing: e.state === 'ready' && !fs.existsSync(this.abs(e, e.file)),
      })),
    };
  }

  /** Prépare le dossier d'un titre ; renvoie l'entrée créée (ou remise à zéro pour un nouvel essai). */
  prepare(p) {
    const id = this.idOf(p);
    const m = p.meta ?? {};
    const folder =
      m.type === 'episode'
        ? path.join('Séries', clean(m.grandparentTitle), `Saison ${Number(m.parentIndex) || 0}`)
        : path.join('Films', clean(m.year ? `${m.title} (${m.year})` : m.title));
    // Noms courts et lisibles : Windows refuse les chemins de plus de 260 caractères, et les noms
    // d'origine (« … [WEBDL-1080p][AAC 2.0][h265]-Groupe.mkv ») les dépassent vite.
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(String(p.fileName ?? '')) ?? [])[1] ?? 'mkv';
    const pad = (n) => String(Number(n) || 0).padStart(2, '0');
    const code = `S${pad(m.parentIndex)}E${pad(m.index)}`;
    const named = (title) => (m.type === 'episode' ? (title ? `${code} - ${title}` : code) : title || 'Film');
    let file = `${clean(named(String(m.title ?? '').slice(0, 60)))}.${ext}`;
    if (path.join(this.dir, folder, file).length > 240) file = `${m.type === 'episode' ? code : clean(String(m.title ?? 'Film').slice(0, 20))}.${ext}`;
    const previous = this.get(id);
    const entry = {
      id,
      serverId: String(p.serverId),
      ratingKey: String(p.ratingKey),
      type: m.type === 'episode' ? 'episode' : 'movie',
      title: String(p.title ?? m.title ?? ''),
      sub: String(p.sub ?? ''),
      show: m.type === 'episode' ? { ratingKey: String(m.grandparentRatingKey ?? ''), title: String(m.grandparentTitle ?? '') } : undefined,
      season: m.type === 'episode' ? Number(m.parentIndex) || 0 : undefined,
      episode: m.type === 'episode' ? Number(m.index) || 0 : undefined,
      meta: m,
      folder,
      file,
      subs: [],
      state: 'downloading',
      received: 0,
      size: 0,
      addedAt: Date.now(),
      viewOffset: previous?.viewOffset ?? (Number(m.viewOffset) || 0),
      watched: previous?.watched ?? !!m.viewCount,
      dirty: previous?.dirty ?? false,
    };
    this.entries = [...this.entries.filter((e) => e.id !== id), entry];
    fs.mkdirSync(path.join(this.dir, folder), { recursive: true });
    this.save();
    return entry;
  }

  /** Enregistre une image ou un sous-titre à côté du fichier ; les erreurs ne bloquent rien. */
  async fetchExtra(entry, url, headers, name) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!res.ok) return undefined;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 30 * 1024 * 1024) return undefined;
      fs.writeFileSync(path.join(this.dir, entry.folder, name), bytes);
      return name;
    } catch {
      return undefined;
    }
  }

  update(id, patch) {
    const e = this.get(id);
    if (!e) return;
    Object.assign(e, patch);
    this.save();
  }

  remove(id) {
    const e = this.get(id);
    if (!e) return;
    const dir = path.join(this.dir, e.folder);
    for (const rel of [e.file, e.poster, e.art, ...e.subs.map((s) => s.file)]) if (rel) fs.rmSync(path.join(dir, rel), { force: true });
    // Le dossier part s'il est vide, puis le dossier de la série s'il l'est aussi.
    for (const d of [dir, path.dirname(dir)]) {
      try {
        if (d.startsWith(this.dir) && d !== this.dir && !fs.readdirSync(d).length) fs.rmdirSync(d);
      } catch {
        /* déjà absent */
      }
    }
    this.entries = this.entries.filter((x) => x.id !== id);
    this.save();
  }

  /** Ce que le lecteur doit ouvrir pour ce titre, ou null si le fichier n'est plus là. */
  playable(id) {
    const e = this.get(id);
    if (!e || e.state !== 'ready') return null;
    const file = this.abs(e, e.file);
    if (!fs.existsSync(file)) return null;
    return { entry: e, file, subFiles: e.subs.map((s) => this.abs(e, s.file)).filter((f) => fs.existsSync(f)) };
  }
}

module.exports = { OfflineLibrary };
