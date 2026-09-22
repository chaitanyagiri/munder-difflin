import { DASH, age, clock } from './format';
import { DeskCard, Empty } from './shared';
import type { TradingData } from './useTradingData';

/** Worker table from `runtime/pipeline_status.json`. `alive` is the
 *  supervisor's own verdict per PID at its last tick. */
export function HealthPanel({ d }: { d: TradingData }) {
  const s = d.status.data;
  const dead = (s?.workers ?? []).filter(w => w.alive === false).length;
  return (
    <DeskCard
      title="Pipeline health"
      file={d.status}
      now={d.now}
      aside={s ? (
        <span className="md-desk-count">
          {s.state ?? DASH}{s.since ? ` for ${age(s.since, d.now)}` : ''}{s.by ? ` · by ${s.by}` : ''}
          {' · app '}<span className={s.appAlive ? 'md-desk-pos' : 'md-desk-neg'}>{s.appAlive === null ? DASH : s.appAlive ? 'alive' : 'gone'}</span>
          {dead > 0 && <> · <span className="md-desk-neg">{dead} dead</span></>}
        </span>
      ) : null}
    >
      {!s ? <Empty>No pipeline_status.json yet.</Empty> : s.workers.length === 0 ? <Empty>No workers recorded.</Empty> : (
        <table className="md-desk-table md-desk-table-compact">
          <thead>
            <tr><th>Worker</th><th>Role</th><th>Alive</th><th className="num">PID</th></tr>
          </thead>
          <tbody>
            {s.workers.map(w => (
              <tr key={w.name} className={w.alive === false ? 'md-desk-row-dead' : undefined}>
                <td>{w.name}</td>
                <td className="md-desk-muted">{w.role || DASH}</td>
                <td>
                  <span className={`md-desk-dot ${w.alive === true ? 'md-desk-dot-ok' : w.alive === false ? 'md-desk-dot-bad' : ''}`} aria-hidden="true" />
                  {w.alive === null ? DASH : w.alive ? (w.resting ? 'resting' : 'yes') : 'no'}
                </td>
                <td className="num md-desk-muted">{w.pid ?? DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s && <div className="md-desk-foot">last tick {clock(s.at)}</div>}
    </DeskCard>
  );
}
