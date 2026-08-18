export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span
      aria-label="The Precinct"
      style={{ display: 'inline-flex', alignItems: 'center', gap: compact ? 7 : 10, color: 'var(--cth-ink-900)' }}
    >
      <svg
        width={compact ? 20 : 40}
        height={compact ? 24 : 48}
        viewBox="0 0 40 48"
        fill="none"
        aria-hidden="true"
        focusable="false"
        style={{ flexShrink: 0 }}
      >
        <path d="M20 2 36 8v13c0 11-6.4 19.4-16 25C10.4 40.4 4 32 4 21V8L20 2Z" fill="var(--cth-ink-900)" />
        <path d="M20 7.5 31 11.6v9.1c0 7.8-4.2 14.1-11 18.7-6.8-4.6-11-10.9-11-18.7v-9.1L20 7.5Z" fill="var(--cth-lemon)" />
        <path d="M13 17h14v4H13zM17.5 13h5v14h-5z" fill="var(--cth-ink-900)" />
        <path d="M13 30h14" stroke="var(--cth-ink-900)" strokeWidth="2" />
      </svg>
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: compact ? 0 : 2 }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: compact ? 9 : 13, lineHeight: compact ? '12px' : '18px' }}>
          THE PRECINCT
        </span>
        {!compact && (
          <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', letterSpacing: 1.5 }}>
            COMMAND · COORDINATE · CLOSE
          </span>
        )}
      </span>
    </span>
  );
}
