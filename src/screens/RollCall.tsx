import { useMemo, useState } from 'react';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getAll, where, save, newId, today } from '../lib/data';
import { consumePackageSession, releasePackageSession } from '../lib/packages';
import { toast } from '../lib/toast';
import type { AttendanceStatus, Batch, Coach, Player } from '../types/db';

const CYCLE: AttendanceStatus[] = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'];
const LABEL: Record<AttendanceStatus, string> = {
  PRESENT: 'Present',
  ABSENT: 'Absent',
  LATE: 'Late',
  EXCUSED: 'Excused',
};

export default function RollCall() {
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const batches = useLiveQuery(() => getAll('batches'), []);
  const coaches = useLiveQuery<Coach[]>(() => getAll('coaches'), []);
  const coachName = (id: string | null | undefined) => (coaches ?? []).find((c) => c.id === id)?.name ?? null;
  // Sorted by start time so the picker (and the default selection) reads
  // top-to-bottom the way a coach's day runs.
  const sortedBatches = useMemo(
    () => (batches ?? []).slice().sort((a, b) => a.start_time.localeCompare(b.start_time)),
    [batches],
  );
  // Previously this always resolved to sortedBatches[0] regardless of which
  // batch the coach wanted — there was no way to reach a second batch's roll
  // call at all. The chip row below lets the coach pick; this just falls
  // back to the first batch until they do (or if they only have one).
  const batch: Batch | undefined = useMemo(
    () => sortedBatches.find((b) => b.id === selectedBatchId) ?? sortedBatches[0],
    [sortedBatches, selectedBatchId],
  );

  const roster = useLiveQuery(async () => {
    if (!batch) return [] as Player[];
    const links = await where('player_batches', (pb) => pb.batch_id === batch.id && pb.is_active);
    const players = await getAll('players');
    const byId = new Map(players.map((p) => [p.id, p]));
    return links
      .map((l) => byId.get(l.player_id))
      .filter((p): p is Player => !!p && p.status !== 'DROPPED')
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [batch?.id]);

  const marks = useLiveQuery(async () => {
    if (!batch) return new Map<string, AttendanceStatus>();
    const d = today();
    const logs = await where(
      'attendance_logs',
      (a) => a.batch_id === batch.id && a.date === d,
    );
    return new Map(logs.map((l) => [l.player_id, l.status]));
  }, [batch?.id]);

  const isCancelled = useLiveQuery(async () => {
    if (!batch) return false;
    const d = today();
    const cancellations = await where(
      'session_cancellations',
      (c) => c.batch_id === batch.id && c.date === d,
    );
    return cancellations.length > 0;
  }, [batch?.id]);

  async function cycle(player: Player, current?: AttendanceStatus) {
    if (!batch) return;
    // A player with no log yet is *shown* as PRESENT (the row default below),
    // but that's a display default, not a written mark — no attendance_logs
    // row exists and no package session has been consumed for them. Cycling
    // has to start from that shown default (`from`) so the very first tap
    // advances PRESENT -> ABSENT instead of writing PRESENT again (comparing
    // against the raw, possibly-undefined `current` made CYCLE.indexOf(-1)+1
    // land back on index 0). But the package consume/release logic below
    // still keys off the raw `current`, not `from` — only an actual existing
    // PRESENT log means a session was really drawn down, so only that case
    // should trigger a release when the mark moves away from PRESENT.
    const from = current ?? 'PRESENT';
    const next = CYCLE[(CYCLE.indexOf(from) + 1) % CYCLE.length];
    const d = today();
    const existing = (
      await where('attendance_logs', (a) => a.batch_id === batch.id && a.player_id === player.id && a.date === d)
    )[0];
    const attendanceId = existing?.id ?? newId();
    await save('attendance_logs', {
      id: attendanceId,
      player_id: player.id,
      batch_id: batch.id,
      date: d,
      status: next,
      created_at: existing?.created_at ?? new Date().toISOString(),
    });

    // Package-billed players draw down their session card on PRESENT, and
    // give it back if the mark is corrected away from PRESENT afterwards.
    if (player.billing_type === 'PACKAGE') {
      if (next === 'PRESENT') {
        const updated = await consumePackageSession(player.id, attendanceId);
        if (updated && updated.sessions_remaining <= 2) {
          toast(
            `${player.full_name}: ${updated.sessions_remaining} session${updated.sessions_remaining === 1 ? '' : 's'} left`,
            'error',
          );
        } else if (!updated) {
          toast(`${player.full_name} has no active session package`, 'error');
        }
      } else if (current === 'PRESENT') {
        await releasePackageSession(attendanceId);
      }
    }
  }

  async function markAllPresent() {
    if (!batch || !roster) return;
    const d = today();
    for (const p of roster) {
      if (marks?.get(p.id)) continue;
      const attendanceId = newId();
      await save('attendance_logs', {
        id: attendanceId,
        player_id: p.id,
        batch_id: batch.id,
        date: d,
        status: 'PRESENT',
        created_at: new Date().toISOString(),
      });
      if (p.billing_type === 'PACKAGE') {
        await consumePackageSession(p.id, attendanceId);
      }
    }
  }

  async function cancelSession() {
    if (!batch) return;
    await save('session_cancellations', {
      id: newId(),
      batch_id: batch.id,
      date: today(),
      reason: cancelReason || null,
      created_at: new Date().toISOString(),
    });
    setCancelConfirm(false);
    setCancelReason('');
  }

  if (!batch) return <p className="muted">No batch yet. Create one under Batches, or seed demo data from Home.</p>;

  const present = roster?.filter((p) => (marks?.get(p.id) ?? 'PRESENT') === 'PRESENT').length ?? 0;

  return (
    <section>
      {sortedBatches.length > 1 && (
        <div className="batch-picker">
          {sortedBatches.map((b) => (
            <button
              key={b.id}
              className={b.id === batch.id ? 'batch-chip on' : 'batch-chip'}
              onClick={() => setSelectedBatchId(b.id)}
            >
              {b.batch_name}
            </button>
          ))}
        </div>
      )}

      {isCancelled && (
        <div className="cancelled-banner">
          ✕ Session cancelled today
        </div>
      )}

      <header className="screen-head">
        <div>
          <h2>{batch.batch_name}</h2>
          <p className="muted">
            {batch.court_number ? `Court ${batch.court_number} · ` : ''}
            {batch.start_time}–{batch.end_time} · {today()}
            {coachName(batch.coach_id) ? ` · ${coachName(batch.coach_id)}` : ''}
          </p>
        </div>
        <div className="count">
          <strong>{present}</strong>
          <span>/ {roster?.length ?? 0}</span>
        </div>
      </header>

      <button className="ghost wide" onClick={markAllPresent}>
        Mark remaining present
      </button>

      <ul className="rows" style={{ marginTop: 10 }}>
        {roster?.map((p) => {
          const status = marks?.get(p.id);
          const shown = status ?? 'PRESENT';
          return (
            <li key={p.id}>
              <button
                className={`row status-${shown.toLowerCase()}`}
                onClick={() => cycle(p, status)}
              >
                <span className="name">
                  {p.full_name}
                  {p.billing_type === 'PACKAGE' && <span className="chip" style={{ marginLeft: 6 }}>Package</span>}
                </span>
                <span className="pill">{LABEL[shown]}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="hint">Tap a name to cycle: Present → Absent → Late → Excused.</p>

      {/* Session cancellation */}
      {!isCancelled && !cancelConfirm && (
        <button className="danger-ghost wide" onClick={() => setCancelConfirm(true)}>
          Cancel today's session…
        </button>
      )}
      {cancelConfirm && (
        <div style={{ marginTop: 14, background: 'var(--card)', border: '1px solid rgba(229,72,77,0.3)', borderRadius: 'var(--radius)', padding: 14 }}>
          <p style={{ fontWeight: 600, color: 'var(--absent)', marginBottom: 10 }}>Cancel this session?</p>
          <input
            style={{ width: '100%', height: 44, padding: '0 12px', border: '1px solid var(--line)', borderRadius: 'var(--radius)', font: 'inherit', marginBottom: 10 }}
            placeholder="Reason (rain, holiday…)"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="primary"
              style={{ flex: 1, background: 'var(--absent)' }}
              onClick={cancelSession}
            >
              Yes, cancel
            </button>
            <button className="ghost" style={{ flex: 1, marginTop: 0 }} onClick={() => setCancelConfirm(false)}>
              Keep session
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
