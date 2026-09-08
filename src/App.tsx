import { useEffect, useState } from 'react';
import Home from './screens/Home';
import RollCall from './screens/RollCall';
import AttendanceReport from './screens/AttendanceReport';
import Batches from './screens/Batches';
import CollectPayment from './screens/CollectPayment';
import PlayerList from './screens/PlayerList';
import PlayerProfile from './screens/PlayerProfile';
import PlayerForm from './screens/PlayerForm';
import Settings from './screens/Settings';
import StringingBoard from './screens/StringingBoard';
import PinLock from './screens/PinLock';
import PinSetup from './screens/PinSetup';
import Toaster from './components/Toaster';
import { installSyncTriggers } from './lib/sync';
import { runMonthStartCatchUp } from './lib/billing';
import { installHoldSweepTriggers } from './lib/holds';
import { getOne } from './lib/data';
import { getSettings } from './lib/settings';
import { onDataChange } from './lib/events';
import type { Player, AppSettings } from './types/db';

type MainTab = 'home' | 'roll' | 'pay' | 'players' | 'settings' | 'string';

type PlayersView =
  | { screen: 'list' }
  | { screen: 'profile'; playerId: string }
  | { screen: 'form'; player?: Player };

export default function App() {
  const [tab, setTab] = useState<MainTab>('home');
  const [playersView, setPlayersView] = useState<PlayersView>({ screen: 'list' });
  // Batches was a fully built screen (create/edit a batch, assign or
  // remove players from its roster — src/screens/Batches.tsx) that was
  // never reachable from any tab or button, anywhere. Nothing was broken
  // in it; there was just no way to get to it, which meant there was no
  // way to create a batch at all outside the demo seed — a real user
  // could never take attendance for anything of their own. Folding it in
  // as a third segment here, next to Roll call/Reports, since batches are
  // the thing Attendance operates on.
  const [rollView, setRollView] = useState<'roll' | 'report' | 'batches'>('roll');
  const [settings, setSettings] = useState<AppSettings | undefined>(undefined);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    installSyncTriggers();
    installHoldSweepTriggers();
    void runMonthStartCatchUp();
    // No "no PIN set → unlocked" fallback anymore: this is a single-coach
    // app, so a PIN is mandatory rather than an opt-in Settings toggle. The
    // only way settings loads with no PIN is a brand-new profile that
    // hasn't been through first-run setup yet — that's handled below by
    // rendering PinSetup instead of skipping the lock.
    getSettings().then(setSettings);
    // A brand-new browser has an empty local app_settings row, so this can
    // render PinSetup even though a real PIN already exists server-side —
    // the initial sync (installSyncTriggers, above) pulls it down moments
    // later, but nothing previously re-checked settings once that finished.
    // Re-read on every sync/data change so PinSetup flips to PinLock as
    // soon as the real settings row lands, instead of needing a reload.
    return onDataChange(() => {
      getSettings().then(setSettings);
    });
  }, []);

  function switchTab(t: MainTab) {
    setTab(t);
    if (t !== 'players') setPlayersView({ screen: 'list' });
  }

  function renderPlayers() {
    if (playersView.screen === 'list') {
      return (
        <PlayerList
          onAdd={() => setPlayersView({ screen: 'form' })}
          onSelect={(id) => setPlayersView({ screen: 'profile', playerId: id })}
        />
      );
    }
    if (playersView.screen === 'profile') {
      return (
        <PlayerProfile
          playerId={playersView.playerId}
          onEdit={async () => {
            const p = await getOne('players', playersView.playerId);
            if (p) setPlayersView({ screen: 'form', player: p });
          }}
          onBack={() => setPlayersView({ screen: 'list' })}
        />
      );
    }
    if (playersView.screen === 'form') {
      return (
        <PlayerForm
          initial={playersView.player}
          onSave={(saved) => setPlayersView({ screen: 'profile', playerId: saved.id })}
          onCancel={() => {
            if (playersView.player) {
              setPlayersView({ screen: 'profile', playerId: playersView.player.id });
            } else {
              setPlayersView({ screen: 'list' });
            }
          }}
        />
      );
    }
    return null;
  }

  // Still loading PIN state
  if (settings === undefined) return null;

  // Brand-new profile: no PIN has ever been created. PIN is mandatory for
  // this single-coach app, so setup happens before anything else is
  // reachable — there is deliberately no "skip for now" path out of it.
  if (!settings.coach_pin_hash || !settings.coach_pin_salt) {
    return (
      <PinSetup
        onDone={() => {
          // Re-fetch so `settings` carries the hash PinSetup just wrote,
          // and mark unlocked in the same batch — updating them separately
          // would re-render once with the old (still-PIN-less) settings and
          // flash straight back into this same setup screen.
          getSettings().then((s) => {
            setSettings(s);
            setUnlocked(true);
          });
        }}
      />
    );
  }

  // A PIN exists — require it once per session.
  if (!unlocked) {
    return <PinLock settings={settings} onUnlock={() => setUnlocked(true)} />;
  }

  const TAB_CONFIG: { id: MainTab; icon: string; label: string }[] = [
    { id: 'home', icon: '🏠', label: 'Today' },
    { id: 'roll', icon: '📋', label: 'Attendance' },
    { id: 'pay', icon: '💰', label: 'Fees' },
    { id: 'players', icon: '👥', label: 'Players' },
    { id: 'string', icon: '🎾', label: 'Stringing' },
    { id: 'settings', icon: '⚙️', label: 'Settings' },
  ];

  return (
    <div className="app">
      <Toaster />
      <main>
        {tab === 'home' && <Home go={(t) => switchTab(t as MainTab)} />}
        {tab === 'roll' && (
          <>
            <div className="segmented" style={{ marginBottom: 14 }}>
              <button className={rollView === 'roll' ? 'seg on' : 'seg'} onClick={() => setRollView('roll')}>Roll call</button>
              <button className={rollView === 'report' ? 'seg on' : 'seg'} onClick={() => setRollView('report')}>Reports</button>
              <button className={rollView === 'batches' ? 'seg on' : 'seg'} onClick={() => setRollView('batches')}>Batches</button>
            </div>
            {rollView === 'roll' && <RollCall />}
            {rollView === 'report' && <AttendanceReport />}
            {rollView === 'batches' && <Batches />}
          </>
        )}
        {tab === 'pay' && <CollectPayment />}
        {tab === 'players' && renderPlayers()}
        {tab === 'string' && <StringingBoard />}
        {tab === 'settings' && <Settings />}
      </main>

      <nav className="tabbar">
        {TAB_CONFIG.map(({ id, icon, label }) => (
          <button
            key={id}
            className={tab === id ? 'on' : ''}
            onClick={() => switchTab(id)}
            aria-label={label}
          >
            <span className="tab-icon">{icon}</span>
            <span className="tab-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
