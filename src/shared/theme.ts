export const PRIMARY_THEME_ID = 'planetexpress' as const;
export const PRIMARY_APP_NAME = 'Planet Express';
export const PRIMARY_BOSS_NAME = 'Professor Farnsworth';

export type PrimaryThemeId = typeof PRIMARY_THEME_ID;
export type LegacyThemeId =
  | 'office'
  | 'friends'
  | 'brooklyn99'
  | 'siliconvalley'
  | 'got'
  | 'hogwarts';
export type StoredThemeId = PrimaryThemeId | LegacyThemeId;
export type ThemeId = PrimaryThemeId;

export const LEGACY_THEME_IDS: LegacyThemeId[] = [
  'office',
  'friends',
  'brooklyn99',
  'siliconvalley',
  'got',
  'hogwarts',
];

export function normalizeThemeId(_value?: string | null): ThemeId {
  return PRIMARY_THEME_ID;
}
