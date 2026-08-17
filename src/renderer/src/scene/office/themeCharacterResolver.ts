export interface ThemeCharacterTheme<Name extends string> {
  cast: {
    byName: Record<string, { name: Name }>;
    defaultCharacter: Name;
  };
  boss: {
    character: Name;
  };
}

export interface ThemeCharacterSubject<Name extends string> {
  id: string;
  character?: Name;
  isGod?: boolean;
}

function castMembers<Name extends string>(theme: ThemeCharacterTheme<Name>): Array<{ name: Name }> {
  return Object.values(theme.cast.byName);
}

export function themeWorkerCastMembers<Name extends string>(
  theme: ThemeCharacterTheme<Name>,
): Array<{ name: Name }> {
  return castMembers(theme).filter((member) => member.name !== theme.boss.character);
}

export function resolveThemeWorkerCharacter<Name extends string>(
  theme: ThemeCharacterTheme<Name>,
  character?: Name,
): Name {
  if (
    character &&
    character !== theme.boss.character &&
    theme.cast.byName[character]
  ) {
    return character;
  }

  if (
    theme.cast.defaultCharacter !== theme.boss.character &&
    theme.cast.byName[theme.cast.defaultCharacter]
  ) {
    return theme.cast.defaultCharacter;
  }

  return themeWorkerCastMembers(theme)[0]?.name ?? theme.cast.defaultCharacter;
}

function stableHash(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function resolveThemeCharacter<Name extends string>(
  theme: ThemeCharacterTheme<Name>,
  subject: ThemeCharacterSubject<Name>,
): Name {
  if (subject.isGod) return theme.boss.character;
  if (
    subject.character &&
    subject.character !== theme.boss.character &&
    theme.cast.byName[subject.character]
  ) {
    return subject.character;
  }

  const members = castMembers(theme);
  const workerPool = members.filter((member) => member.name !== theme.boss.character);
  const pool = workerPool.length > 0 ? workerPool : members;
  if (pool.length === 0) return theme.cast.defaultCharacter;

  const key = subject.id || subject.character || theme.cast.defaultCharacter;
  return pool[stableHash(key) % pool.length].name;
}
