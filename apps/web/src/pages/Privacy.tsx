// Confidentialité : ce que l'application envoie, à qui, et ce qu'elle garde sur l'appareil. Résumé
// de PRIVACY.md (à la racine du dépôt), qui fait foi : les deux doivent rester d'accord.
import { t } from '../i18n';
import { back } from '../router';
import { Icon } from '../ui';

const REPO = 'https://github.com/Shibeon/MultiPlex';
const LINKS: { key: string; href: string }[] = [
  { key: 'priv.full', href: `${REPO}/blob/main/PRIVACY.md` },
  { key: 'priv.issues', href: `${REPO}/issues` },
  { key: 'priv.plexPolicy', href: 'https://www.plex.tv/about/privacy-legal/' },
];
const SECTIONS = ['who', 'plex', 'others', 'together', 'device', 'contact'];

/**
 * `standalone` : ouverte avant la connexion (lien de l'écran de connexion), hors de la coque de
 * l'application, avec son propre bouton Retour. Chaque section prend le focus, pour qu'à la
 * télécommande on puisse descendre dans le texte et pas seulement sauter aux liens du bas.
 */
export function PrivacyPage({ standalone }: { standalone?: boolean }) {
  const page = (
    <div class="page settings privacy">
      {standalone && (
        <button class="btn privacy-back" onClick={back}>
          <Icon name="back" size={20} /> {t('common.back')}
        </button>
      )}
      <header class="page-head">
        <h1>{t('priv.title')}</h1>
      </header>
      <p class="muted privacy-lead">{t('priv.lead')}</p>
      <div class="privacy-body">
        {SECTIONS.map((id) => (
          <section key={id} tabIndex={0} aria-labelledby={`priv-${id}`}>
            <h2 id={`priv-${id}`}>{t(`priv.${id}.h`)}</h2>
            {t(`priv.${id}.p`)
              .split('\n')
              .map((para, i) => (
                <p key={i}>{para}</p>
              ))}
          </section>
        ))}
        <div class="actions privacy-links">
          {LINKS.map((l) => (
            <a key={l.key} class="btn" href={l.href} target="_blank" rel="noopener noreferrer">
              {t(l.key)}
              <small>{l.href.replace(/^https:\/\/(www\.)?/, '')}</small>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
  return standalone ? <main class="content privacy-standalone">{page}</main> : page;
}
