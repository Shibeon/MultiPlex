import { describe, expect, it } from 'vitest';
import { isManagedProfile, type HomeUser } from '../src';

const home: HomeUser[] = [
  { id: 1, uuid: 'aaaa0001', title: 'Camille', admin: true, restricted: false, protected: false },
  { id: 2, uuid: 'aaaa0002', title: 'Les enfants', admin: false, restricted: true, protected: false },
];

describe('isManagedProfile', () => {
  it('sans compte : non', () => {
    expect(isManagedProfile(null, home)).toBe(false);
    expect(isManagedProfile(undefined, [])).toBe(false);
  });

  it('la fiche du foyer fait foi', () => {
    expect(isManagedProfile({ uuid: 'aaaa0002' }, home)).toBe(true);
    expect(isManagedProfile({ uuid: 'aaaa0001' }, home)).toBe(false);
    // Même si l'identité enregistrée disait l'inverse (profil modifié depuis).
    expect(isManagedProfile({ uuid: 'aaaa0001', restricted: true }, home)).toBe(false);
    expect(isManagedProfile({ uuid: 'aaaa0002', restricted: false }, home)).toBe(true);
  });

  it('sans fiche dans le foyer : ce que plex.tv a dit du compte', () => {
    expect(isManagedProfile({ uuid: 'aaaa0009', restricted: true }, home)).toBe(true);
    expect(isManagedProfile({ uuid: 'aaaa0009', restricted: true }, [])).toBe(true);
    expect(isManagedProfile({ uuid: 'aaaa0009' }, [])).toBe(false);
    expect(isManagedProfile({ uuid: 'aaaa0009', restricted: false }, [])).toBe(false);
  });
});
