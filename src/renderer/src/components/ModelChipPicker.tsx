import { useMemo, useState } from 'react';
import type { AccentColorName } from '@/design/tokens';
import type { ModelOption } from '@/store/config';

/** Above this many options the picker grows a filter box and a scroll cap.
 *
 *  The model lists are no longer the hand-curated dozen they were written for:
 *  the catalog now merges whatever `opencode models` reports, which is ~390
 *  entries. Rendered as the plain wrapping chip row this used to be, that is an
 *  unbounded wall that pushes the rest of the form off the modal.
 *
 *  Short lists — every provider whose list is still curated — must look EXACTLY
 *  as they did before, so the threshold sits well above the longest of them
 *  (12) and the search affordance simply does not appear for them. */
const SEARCH_THRESHOLD = 24;

/** How tall the scrolling chip area is allowed to get, in px. Roughly six rows:
 *  enough that filtering feels like it is browsing a list, short enough that the
 *  fields below the picker stay on screen in the smallest modal. */
const MAX_LIST_HEIGHT = 168;

function chipStyle(active: boolean, accent: AccentColorName): React.CSSProperties {
  return {
    padding: '3px 8px 1px',
    background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
    boxShadow: active
      ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
      : 'inset 0 0 0 1px var(--cth-ink-100)',
    fontFamily: 'var(--cth-font-ui)', fontSize: 12,
    color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
  };
}

export interface ModelChipPickerProps {
  options: ModelOption[];
  /** The selected model id; undefined means the "no --model flag" entry. */
  value?: string;
  onPick: (id?: string) => void;
  accent: AccentColorName;
  /** Tooltip for the entry that carries no id (the CLI's own default). */
  cliDefaultTitle: string;
  searchPlaceholder: string;
  /** Renders the "showing N of M" line. */
  countLabel: (shown: number, total: number) => string;
  emptyLabel: string;
}

/** The chip grid every model picker draws, with a filter box once the list is
 *  long enough to need one. */
export function ModelChipPicker({
  options, value, onPick, accent,
  cliDefaultTitle, searchPlaceholder, countLabel, emptyLabel
}: ModelChipPickerProps) {
  const [query, setQuery] = useState('');
  const searchable = options.length > SEARCH_THRESHOLD;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!searchable || !needle) return options;
    return options.filter((m) =>
      // The SELECTED chip always survives the filter. A picker whose current
      // value disappears while you type reads as "it forgot what I picked",
      // and the chip is the only thing showing what that value is.
      (value !== undefined && m.id === value)
      || m.label.toLowerCase().includes(needle)
      || (m.id?.toLowerCase().includes(needle) ?? false)
    );
  }, [options, query, searchable, value]);

  const grid = (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {shown.map((m) => (
        <button
          key={m.id ?? `cli-default:${m.label}`}
          type="button"
          onClick={() => onPick(m.id)}
          title={m.id ?? cliDefaultTitle}
          style={chipStyle((value ?? '') === (m.id ?? ''), accent)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );

  if (!searchable) return grid;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={searchPlaceholder}
        style={{
          padding: '4px 8px',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 12,
          color: 'var(--cth-ink-900)', border: 'none', outline: 'none'
        }}
      />
      <div style={{ maxHeight: MAX_LIST_HEIGHT, overflowY: 'auto' }}>
        {shown.length > 0
          ? grid
          : <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)' }}>
              {emptyLabel}
            </span>}
      </div>
      <span style={{
        fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)'
      }}>
        {countLabel(shown.length, options.length)}
      </span>
    </div>
  );
}
