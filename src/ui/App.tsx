import { platform } from '../platform';
import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { ChevronLeft, Play, Square, RotateCw, CalendarCheck, TriangleAlert } from 'lucide-react';
import { earliestCandidate } from '../domain/dates';
import { CITIES, DEMO_APPOINTMENT, DEMO_AVAILABILITY, DEMO_DATES, DEMO_PREFERENCES, EMPTY_PREFERENCES, NO_VALUE, calendarDays, cityLabel, earliestObserved, formatDate, preferencesError, shiftMonth, type Mode, type Preferences, type Run, type RunStatus } from './model';
import { isExtension, loadUiState, saveLastMode, savePreferences, saveRun } from './storage';
import { focusVisaTab, PanelCommandError, panelCommand, retryRestartCommand } from './engine';
import { fitCurrentPanelWindow } from '../panel-window';
import type { PanelSnapshot } from '../engine/panel';
import { isPanelFailureKind, panelFailureKind, type PanelFailureKind } from '../engine/panel-errors';
import { isPanelCommandErrorMessage } from '../engine/start-errors';
import { HomeScreen } from './HomeScreen';
import { Configuration } from './Configuration';
import { Terms } from './Terms';
import { Coffee } from './Coffee';
import { History } from './History';
import type { HistoryRow } from '../domain/history';
import styles from './Panel.module.css';

type View = 'home' | 'config' | 'workflow' | 'terms' | 'coffee' | 'history';
type TermsOrigin = 'home' | 'config' | null;
const activeStatuses: RunStatus[] = ['running'];
const embedded = new URLSearchParams(location.search).has('embedded');
const detached = isExtension && new URLSearchParams(location.search).has('detached');
const engineEnabled = isExtension && new URLSearchParams(location.search).get('preview') !== '1';

function Calendar({ available, initialMonth = '2026-12' }: { available: string[]; initialMonth?: string }) {
  const [month, setMonth] = useState(initialMonth);
  return <section className={styles.calendar} aria-label="Appointment availability calendar">
    <div className={styles.month}>
      <button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><img src="assets/calendar-previous.svg" alt="" /></button>
      <strong>{new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}</strong>
      <button aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}><img src="assets/calendar-next.svg" alt="" /></button>
    </div>
    <div className={styles.weekdays}>{['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => <span key={day}>{day}</span>)}</div>
    <div className={styles.days}>{calendarDays(month).map(day => <span key={day.iso} className={`${styles.day} ${!day.inMonth ? styles.otherMonth : ''} ${available.includes(day.iso) ? styles.available : ''}`} aria-label={`${day.iso}${available.includes(day.iso) ? ', available' : ', no availability shown'}`}>{day.day}</span>)}</div>
  </section>;
}

const FAILURE_TITLES: Record<PanelFailureKind, string> = {
  generic: 'That didn’t work',
  'paid-ivr-not-found': 'Couldn’t find paid group',
  'unpaid-ivr-not-found': 'Couldn’t find unpaid group',
};
// Site maintenance stays on its existing retry/recovery panel; it never takes one
// of the failure screens even though it shares the safe-message channel.
const MAINTENANCE_MESSAGE = 'The visa website is under maintenance. Wait for it to recover, then press Start.';

function failureTitle(kind: PanelFailureKind | null | undefined): string | null {
  if (!kind) return null;
  return FAILURE_TITLES[isPanelFailureKind(kind) ? kind : 'generic'];
}

// The failure screen already conveys its diagnostic, so the banner would
// duplicate it. Unrelated safety/recovery messages still show beside it.
function isDuplicateFailureBanner(message: string, kind: PanelFailureKind | null): boolean {
  if (!message || !kind) return false;
  if (!isPanelCommandErrorMessage(message)) return false;
  return panelFailureKind(message) === kind;
}

function Workflow({ preferences, run, change, configure, openCoffee, data, failureKind, failureDetail, trackScroll }: { preferences: Preferences; run: Run; change: (status: RunStatus) => Promise<void>; configure: () => void; openCoffee: () => void; data?: PanelSnapshot | null; failureKind?: PanelFailureKind | null; failureDetail?: string; trackScroll: (event: UIEvent<HTMLElement>) => void }) {
  const active = activeStatuses.includes(run.status);
  const simulated = data === undefined;
  const hasData = simulated ? run.lastChecked !== null : data?.checkedAt !== null && data?.checkedAt !== undefined;
  const title = failureTitle(failureKind ?? (run.status === 'failure' ? 'generic' : null));
  const special = run.status === 'success' || title !== null;
  const availability = simulated ? DEMO_AVAILABILITY : data?.dates ?? [];
  const currentDate = simulated ? DEMO_APPOINTMENT : data?.currentDate ?? null;
  const candidate = preferencesError(preferences) ? null : earliestCandidate(availability, currentDate, { ...preferences, exclusions: [] });
  const observed = earliestObserved(availability);
  const cityDate = (city: Preferences['consulate']) => simulated ? DEMO_DATES[city || 'Vancouver'] : data?.rows.find(row => row.city === city)?.date ?? null;
  const successMessage = { title: 'Appointment booked', detail: formatDate(simulated ? candidate : data?.confirmedDate ?? null), footer: 'Start again to look for an earlier date' };
  const message = title ? { title, detail: 'Check configurations', footer: 'Tap to retry' } : run.status === 'success' ? successMessage : null;
  const retrying = title !== null && !active;
  return <div className={styles.workflow}>
    <div className={styles.workflowContent} onScroll={trackScroll}>
    {special && message ? <div className={`${styles.result} ${!title && run.status === 'success' ? styles.success : styles.failure}`} role="status">
      {!title && run.status === 'success' ? <CalendarCheck size={42} /> : <span className={styles.failureIcon} aria-hidden><TriangleAlert size={42} /></span>}
      <h2>{message.title}</h2>
      {title && failureDetail && <p className={styles.failureDetail}>{failureDetail}</p>}
      {title ? <button className={styles.secondary} onClick={configure}>{message.detail}</button> : <p className={styles.bookedDate}>{message.detail}</p>}
      {!title && run.status === 'success' && run.mode === 'booking' && <button className={`${styles.secondary} ${styles.coffeeLink}`} onClick={openCoffee}>Buy me a coffee?</button>}
    </div> : <>
      <div className={styles.stats}><div><h2>{run.mode === 'booking' ? 'Earliest Available' : cityLabel(preferences.consulate)}</h2><p>{hasData ? formatDate(run.mode === 'booking' ? observed : cityDate(preferences.consulate)) : NO_VALUE}</p></div><div><h2>Last Checked</h2><p>{run.lastChecked ?? NO_VALUE}</p></div></div>
      {run.mode === 'booking' ? <Calendar key={simulated ? 'preview' : observed ?? 'empty'} available={hasData ? availability : []} initialMonth={simulated ? '2026-12' : observed?.slice(0, 7) ?? new Date().toISOString().slice(0, 7)} /> : <div className={`${styles.group} ${styles.consulates}`} aria-label="Other consulate dates">{CITIES.filter(city => city !== preferences.consulate).map(city => <div className={styles.row} key={city}><span>{cityLabel(city)}</span><span className={styles.date}>{hasData ? formatDate(cityDate(city)) : NO_VALUE}</span></div>)}</div>}
    </>}
    </div>
    <button className={`${styles.runButton} ${active || title ? styles.red : styles.green}`} aria-label={`${active ? 'Stop' : run.status === 'idle' && !retrying ? 'Start' : 'Retry'}${simulated ? ' preview' : ''}`} onClick={() => void change(active ? 'idle' : 'running')}>
      {active ? <Square size={22} fill="currentColor" strokeWidth={0} /> : run.status === 'idle' && !retrying ? <Play size={24} fill="currentColor" strokeWidth={0} /> : <RotateCw size={28} />}
    </button>
    {(message || run.mode === 'booking') && <p className={`${styles.workflowFooter}${title ? ` ${styles.failureFooter}` : ''}`}>{message?.footer ?? (currentDate && (hasData || !simulated) ? `Current appointment   ${formatDate(currentDate)}` : 'No current appointment')}</p>}
  </div>;
}

export function App() {
  const [view, setView] = useState<View>('home');
  const [preferences, setPreferences] = useState<Preferences>(structuredClone(EMPTY_PREFERENCES));
  const [run, setRun] = useState<Run>({ mode: 'booking', status: 'idle', lastChecked: null });
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const [termsOrigin, setTermsOrigin] = useState<TermsOrigin>(null);
  const [coffeeFromConfig, setCoffeeFromConfig] = useState(false);
  const [previewHistory, setPreviewHistory] = useState(false);
  const [ready, setReady] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState('');
  const [previewFailure, setPreviewFailure] = useState<PanelFailureKind>('generic');
  // Local Start-command failure for the selected workflow. A thrown START
  // leaves the previous stopped/idle snapshot behind, so this persists until
  // a healthy snapshot, Stop, settings save or workflow switch clears it.
  const [panelFailure, setPanelFailure] = useState<{ kind: PanelFailureKind; mode: Mode; detail?: string } | null>(null);
  const [engineData, setEngineData] = useState<PanelSnapshot | null>(null);
  const [toolbarScrolled, setToolbarScrolled] = useState(false);
  const [focusingTab, setFocusingTab] = useState(false);
  const pendingRef = useRef<Mode | null>(null);
  const restartCommandEpoch = useRef(0);
  const restartTransportPending = useRef(false);
  const failedRestartMode = useRef<Mode | null>(null);
  const cancelRestartWait = useRef<(() => void) | null>(null);
  const cancelRestartCommand = () => {
    restartCommandEpoch.current++;
    restartTransportPending.current = false;
    failedRestartMode.current = null;
    cancelRestartWait.current?.();
    cancelRestartWait.current = null;
  };
  pendingRef.current = pendingMode;
  // The toolbar shares the panel background until content scrolls beneath it.
  useEffect(() => { setToolbarScrolled(false); }, [view, run.mode]);
  const trackScroll = (event: UIEvent<HTMLElement>) => { setToolbarScrolled(event.currentTarget.scrollTop > 2); };
  const applySnapshot = (snapshot: PanelSnapshot) => {
    // An unchanged previous success is not a successful new Start. During a
    // lost-response retry, or after its exhaustion, do not erase the new state.
    if (snapshot.status === 'success' && (restartTransportPending.current || failedRestartMode.current === snapshot.mode)) return;
    if (restartTransportPending.current && snapshot.mode === pendingRef.current &&
        (snapshot.status === 'running' || snapshot.reviewRequired)) cancelRestartCommand();
    const snapshotActive = snapshot.status !== 'idle' || snapshot.reviewRequired || snapshot.checkedAt != null;
    setEngineData(snapshot);
    // A real stopped failure carries a validated classification. Record it
    // for its own workflow even when another function is selected, so
    // returning to the failed workflow restores the exact screen. Manual
    // handoff keeps its existing banner and never takes a failure screen.
    if (snapshot.status === 'failure' && !snapshot.manualAuthentication) {
      const kind = isPanelFailureKind(snapshot.failureKind) ? snapshot.failureKind : 'generic';
      setPanelFailure({ kind, mode: snapshot.mode,
        ...(isPanelCommandErrorMessage(snapshot.reviewMessage) ? { detail: snapshot.reviewMessage } : {}) });
    } else if (snapshot.status === 'running' || snapshot.status === 'success' || snapshot.manualAuthentication || snapshot.reviewRequired) {
      // Healthy work and recovery guidance clear the local screen error for that
      // workflow. Plain idle/stopped snapshots retain it: a thrown START
      // leaves the old snapshot behind, and clearing on it would discard
      // the specific error before it is ever shown.
      setPanelFailure(current => (current && current.mode === snapshot.mode ? null : current));
    }
    // A selected function remains independent of a worker running the other
    // mode. Observations never navigate away from onboarding or Settings.
    const selected = pendingRef.current;
    if (snapshotActive && selected && snapshot.mode !== selected) {
      setError('');
      return;
    }
    if (snapshot.status === 'failure' && !snapshot.manualAuthentication) {
      setRun(current => ({ mode: snapshotActive ? snapshot.mode : current.mode,
        status: 'failure', lastChecked: snapshot.checkedAt ? new Date(snapshot.checkedAt).toLocaleTimeString() : null }));
      // The screen already conveys the diagnostic; a banner would duplicate it.
      setError(snapshot.reviewMessage && !isPanelCommandErrorMessage(snapshot.reviewMessage) ? snapshot.reviewMessage : '');
      if (snapshotActive && !selected) {
        void saveLastMode(snapshot.mode).catch(() => {});
      }
      return;
    }
    setRun(current => ({ mode: snapshotActive ? snapshot.mode : current.mode,
      status: snapshot.status, lastChecked: snapshot.checkedAt ? new Date(snapshot.checkedAt).toLocaleTimeString() : null }));
    setError(snapshot.reviewMessage ?? '');
    // With no previous selection, retain the active worker's function as the
    // initial choice. Explicit selections are persisted only by navigation.
    if (snapshotActive && !selected) {
      void saveLastMode(snapshot.mode).catch(() => {});
    }
  };
  useEffect(() => {
    let disposed = false;
    if (detached) void fitCurrentPanelWindow().catch(() => { if (!disposed) setError('Unable to size the scheduler window. You can resize it manually.'); });
    const refresh = () => { void panelCommand('STATE').then(snapshot => { if (!disposed) applySnapshot(snapshot); }).catch(() => { if (!disposed) setError('Unable to read worker status. Reopen the extension to retry.'); }); };
    const changed = (changes: Record<string, unknown>, area: string) => { if (area === 'local' && ['engineStateV1', 'engineObservationV1', 'engineSuccessV1'].some(key => key in changes)) refresh(); };
    void loadUiState(!engineEnabled).then(state => {
      if (disposed) return;
      setPreferences(state.preferences);
      if (engineEnabled) {
        // First-time use shows the home screen when mandatory configuration is
        // incomplete. A valid returning configuration goes straight to the
        // last-used booking/alerts workflow, falling back to booking.
        if (preferencesError(state.preferences)) {
          pendingRef.current = null;
          setPendingMode(null);
          setView('home');
        } else if (state.lastMode) {
          setRun(current => ({ ...current, mode: state.lastMode! }));
          setPendingMode(state.lastMode);
          pendingRef.current = state.lastMode;
          setView('workflow');
        } else {
          // No stored workflow: provisionally show booking, but leave the
          // selection empty so an active worker run still takes authority.
          setRun(current => ({ ...current, mode: 'booking' }));
          setPendingMode(null);
          pendingRef.current = null;
          setView('workflow');
        }
        refresh();
      } else {
        const mode = state.run.status === 'running' ? state.run.mode : state.lastMode ?? state.run.mode;
        setRun({ ...state.run, mode });
        if (!preferencesError(state.preferences)) {
          setPendingMode(mode);
          pendingRef.current = mode;
          setView('workflow');
        }
      }
      setReady(true);
    }).catch(() => { if (!disposed) setError('Unable to load local preferences. Reopen the extension to retry.'); });
    if (engineEnabled) platform.storage.onChanged.addListener(changed);
    return () => { disposed = true; cancelRestartCommand(); if (engineEnabled) platform.storage.onChanged.removeListener(changed); };
  }, []);
  const active = activeStatuses.includes(run.status);
  const settingsLocked = active || (engineEnabled && engineData?.status === 'running');
  const persistRun = async (next: Run) => { try { if (!engineEnabled) await saveRun(next); setRun(next); } catch { setError('Unable to save preview status. Please try again.'); } };
  const choose = async (mode: Mode) => {
    cancelRestartCommand();
    // Preview has a single simulated run, so switching stays blocked while active.
    // The worker keeps headless state, so product switching previews new stopped.
    if (!engineEnabled && active) { setView('workflow'); return; }
    setPendingMode(mode);
    pendingRef.current = mode;
    // The last-used function survives restart even when the worker still runs
    // the other workflow headlessly. Worker observations/status stay isolated
    // through applySnapshot and the mode-matched data prop below.
    try { await saveLastMode(mode); } catch { setError('Unable to save workflow selection. Please try again.'); return; }
    await persistRun({ mode, status: 'idle', lastChecked: null });
    // A fresh workflow preview starts without a screen error; a persisted
    // worker failure for the reselected workflow resyncs just below.
    if (engineEnabled) setPanelFailure(null);
    // Switching back to the live worker mode resyncs immediately.
    if (engineEnabled && engineData && engineData.mode === mode) applySnapshot(engineData);
    setView(preferencesError(preferences) ? 'config' : 'workflow');
  };
  // Tab clicks never mutate a run when the current workflow tab is already
  // selected; switching previews the new function stopped headlessly.
  const selectWorkflow = async (mode: Mode) => {
    if (view === 'workflow' && run.mode === mode) return;
    if (view === 'coffee' && run.mode === mode) {
      setView(preferencesError(preferences) ? 'config' : 'workflow');
      return;
    }
    await choose(mode);
  };
  const openTermsFromHome = () => { setTermsOrigin('home'); setView('terms'); };
  const openCoffee = () => { setCoffeeFromConfig(view === 'config'); setView('coffee'); };
  const openTermsFromConfig = () => { setTermsOrigin('config'); setView('terms'); };
  const backFromTerms = () => {
    if (termsOrigin === 'config') {
      // Configuration stays mounted hidden under Terms, so its draft,
      // expanded sections and scroll position survive the return.
      setView('config');
    } else {
      setPendingMode(null);
      setView('home');
    }
    setTermsOrigin(null);
  };
  const hide = () => { if (embedded) window.parent.postMessage({ type: 'USVISA_HIDE_PANEL' }, 'https://ais.usvisa-info.com'); else setHidden(true); };
  const scenario = async (status: RunStatus, mode: Mode = run.mode, kind: PanelFailureKind = 'generic') => {
    setPreviewBusy(true);
    try {
      await savePreferences(structuredClone(DEMO_PREFERENCES));
      setPreferences(structuredClone(DEMO_PREFERENCES)); setPendingMode(mode);
      if (status === 'failure') setPreviewFailure(isPanelFailureKind(kind) ? kind : 'generic');
      await persistRun({ ...run, mode, status, lastChecked: status === 'idle' ? null : '23:51:04' }); setView('workflow'); setHidden(false);
    } catch { setError('Unable to load the preview scenario.'); }
    finally { setPreviewBusy(false); }
  };
  const scenarioValue = run.status === 'failure' && !engineEnabled ? `failure:${previewFailure}` : run.status;
  const SCENARIO_OPTIONS: { value: string; label: string }[] = [
    { value: 'idle', label: 'Ready to start' },
    { value: 'running', label: 'Checking dates' },
    { value: 'success', label: 'Confirmed success' },
    { value: 'failure:generic', label: 'Generic failure' },
    { value: 'failure:paid-ivr-not-found', label: 'Paid group failure' },
    { value: 'failure:unpaid-ivr-not-found', label: 'Unpaid group failure' },
  ];
  // Engine failure screen for the selected workflow: a persisted worker
  // failure wins; otherwise the local Start-command error applies. Manual
  // handoff and maintenance stay on their running panel and banner.
  const engineFailure: PanelFailureKind | null = engineEnabled && view === 'workflow' && engineData?.status !== 'running' && !engineData?.manualAuthentication
    ? (engineData && engineData.mode === run.mode && engineData.status === 'failure'
      ? (isPanelFailureKind(engineData.failureKind) ? engineData.failureKind : 'generic')
      : (panelFailure && panelFailure.mode === run.mode ? panelFailure.kind : null))
    : null;
  // Only fixed, identifier-free diagnostics may accompany the generic title.
  // Keep command details with their workflow across stale idle refreshes.
  const engineFailureDetail = engineFailure === 'generic'
    ? (engineData?.mode === run.mode && engineData.status === 'failure'
      ? (isPanelCommandErrorMessage(engineData.reviewMessage) ? engineData.reviewMessage : undefined)
      : (panelFailure?.mode === run.mode ? panelFailure.detail : undefined))
    : undefined;
  const activeTab = view === 'workflow' ? run.mode : view === 'config' ? 'settings' : view === 'coffee' ? 'coffee' : null;
  const keepConfigMounted = view === 'config' || view === 'history' || (view === 'terms' && termsOrigin === 'config') || (view === 'coffee' && coffeeFromConfig);
  const previewRows: HistoryRow[] = useMemo(() => previewHistory ? Array.from({ length: 14 }, (_, index) => ({
    id: `synthetic-history-${index}`, checkedAt: new Date(Date.now() - index * 3600_000).toISOString(),
    earliestDate: ['2026-11-19', '2027-01-20', '2026-12-31', '2026-12-30'][index % 4],
    booked: index === 0 ? 'Yes' : index === 2 || index === 3 ? 'Attempted' : 'No',
  })) : [], [previewHistory]);
  // Figma 96:23766: saved Test Mode shows one orange line at the panel bottom
  // on every view except Settings, which keeps Save/Cancel at the bottom.
  const showTestMode = ready && preferences.testMode && view !== 'config';
  return <main className={detached ? styles.detached : embedded ? styles.embedded : styles.preview}>
    {!embedded && !engineEnabled && <aside className={styles.previewControls}>
      <span className={styles.kicker}>Interface milestone · step 3</span><h1>US Visa Scheduler for Canada</h1><p>Figma interface preview with simulated data. No login, notifications, payment, or booking occurs.</p>
      <button className={styles.previewButton} onClick={() => { setPreferences(structuredClone(DEMO_PREFERENCES)); setPendingMode(null); setTermsOrigin(null); setView('home'); setHidden(false); }}>Fill synthetic preferences</button>
      <label>Workflow<select aria-label="Preview workflow" disabled={previewBusy} value={run.mode} onChange={event => void scenario('idle', event.target.value as Mode)}><option value="booking">Book or reschedule</option><option value="alerts">Date alerts</option></select></label>
      <label>Scenario<select aria-label="Preview scenario" disabled={previewBusy} value={scenarioValue} onChange={event => {
        const value = event.target.value;
        if (value.startsWith('failure:')) void scenario('failure', run.mode, value.slice('failure:'.length) as PanelFailureKind);
        else void scenario(value as RunStatus, run.mode);
      }}>{SCENARIO_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <button className={styles.previewButton} onClick={hide}>Hide panel</button>
      <button className={styles.previewButton} onClick={() => { setHidden(false); setPendingMode(pendingMode ?? run.mode); setView('config'); }}>Open configuration</button>
      <button className={styles.previewButton} onClick={() => { setHidden(false); setPendingMode(null); setTermsOrigin('home'); setView('terms'); }}>Review terms</button>
      <label>Logs<select aria-label="Preview date history" value={previewHistory ? 'history' : 'empty'} onChange={event => setPreviewHistory(event.target.value === 'history')}><option value="empty">Empty history</option><option value="history">Synthetic history</option></select></label>
      <p className={styles.previewNote}>Calendar tiles show availability only. Hiding the panel preserves the preview run; Stop ends it.</p>
      {isExtension && import.meta.env.MODE !== 'production' && <a href="probe.html">Open development probe</a>}
    </aside>}
    {hidden ? <button className={styles.reopen} onClick={() => setHidden(false)}>Show scheduler · {run.status}</button> : <div className={styles.panelWrap}>
      <section className={`${styles.panel}${showTestMode ? ` ${styles.testModeOn}` : ''}`} aria-label="US Visa Scheduler for Canada">
        {view !== 'home' && (view === 'terms' || view === 'history' ? <nav className={`${styles.toolbar} ${styles.toolbarTerms}${toolbarScrolled ? ` ${styles.toolbarScrolled}` : ''}`} aria-label="Scheduler navigation">
          <button aria-label="Back" className={styles.tab} onClick={view === 'history' ? () => setView('config') : backFromTerms}><ChevronLeft size={20} /></button>
          <img className={styles.separator} src="assets/toolbar-line.svg" alt="" />
        </nav> : <nav className={`${styles.toolbar}${toolbarScrolled ? ` ${styles.toolbarScrolled}` : ''}`} aria-label="Scheduler navigation">
          <button aria-label="Booking" aria-current={activeTab === 'booking' ? 'page' : undefined} className={`${styles.tab}${activeTab === 'booking' ? ` ${styles.tabActive}` : ''}`} onClick={() => void selectWorkflow('booking')}><img src="assets/toolbar-booking.svg" width={23} height={23} alt="" />{activeTab === 'booking' && <span aria-hidden className={styles.tabUnderline} />}</button>
          <button aria-label="Alerts" aria-current={activeTab === 'alerts' ? 'page' : undefined} className={`${styles.tab}${activeTab === 'alerts' ? ` ${styles.tabActive}` : ''}`} onClick={() => void selectWorkflow('alerts')}><img src="assets/toolbar-alerts.svg" width={23} height={23} alt="" />{activeTab === 'alerts' && <span aria-hidden className={styles.tabUnderline} />}</button>
          <button aria-label="Settings" aria-current={activeTab === 'settings' ? 'page' : undefined} className={`${styles.tab}${activeTab === 'settings' ? ` ${styles.tabActive}` : ''}`} onClick={() => { setPendingMode(pendingMode ?? run.mode); setView('config'); }}><img src="assets/toolbar-settings.svg" width={23} height={23} alt="" />{activeTab === 'settings' && <span aria-hidden className={styles.tabUnderline} />}</button>
          <button aria-label="Coffee" title="Buy me a coffee" aria-current={activeTab === 'coffee' ? 'page' : undefined} className={`${styles.tab}${activeTab === 'coffee' ? ` ${styles.tabActive}` : ''}`} onClick={() => { if (view !== 'coffee') openCoffee(); }}><img src="assets/toolbar-coffee.svg" width={23} height={23} alt="" />{activeTab === 'coffee' && <span aria-hidden className={styles.tabUnderline} />}</button>
          <button aria-label="Show Visa tab" title="Show working Visa tab" disabled={!engineEnabled || focusingTab} onClick={async () => {
            setFocusingTab(true);
            try { await focusVisaTab(); } catch (failure) { setError((failure as Error).message); }
            finally { setFocusingTab(false); }
          }}><img src="assets/toolbar-window.svg" width={23} height={23} alt="" /></button>
          <img className={styles.separator} src="assets/toolbar-line.svg" alt="" />
        </nav>)}
        {error && !isDuplicateFailureBanner(error, engineEnabled ? engineFailure : (view === 'workflow' && run.status === 'failure' ? previewFailure : null)) && <div className={styles.errorBanner} role="alert">{error}</div>}
        {!ready ? <p className={styles.loading}>{error ? 'Preferences unavailable' : 'Loading preferences…'}</p> : view === 'home' ? <HomeScreen choose={(mode: Mode) => void choose(mode)} openTerms={openTermsFromHome} testMode={showTestMode} />
        : <>
          {keepConfigMounted && <div style={view === 'config' ? { display: 'contents' } : { display: 'none' }}>
            <Configuration preferences={preferences} active={settingsLocked} trackScroll={trackScroll} openTerms={openTermsFromConfig} openHistory={() => setView('history')} cancel={() => setView(preferencesError(preferences) ? 'home' : 'workflow')} save={async value => {
              cancelRestartCommand();
              await savePreferences(value); setPreferences(value);
              const mode = pendingMode ?? run.mode;
              await persistRun({ mode, status: 'idle', lastChecked: null });
              try { await saveLastMode(mode); } catch { setError('Unable to save workflow selection. Please try again.'); return; }
              setPendingMode(mode);
              if (engineEnabled) {
                setPanelFailure(null);
                setEngineData(current => current?.status === 'failure' && current.mode === mode &&
                  (!current.reviewMessage || isPanelCommandErrorMessage(current.reviewMessage)) ? null : current);
              }
              setError(engineData?.reviewRequired && engineData.reviewMessage && !isPanelCommandErrorMessage(engineData.reviewMessage) ? engineData.reviewMessage : '');
              setView('workflow');
            }} />
          </div>}
          {view === 'history' ? <History live={engineEnabled} previewRows={previewRows} trackScroll={trackScroll} /> : view === 'coffee' ? <Coffee trackScroll={trackScroll} onError={setError} /> : view === 'terms' ? <Terms trackScroll={trackScroll} testMode={showTestMode} /> : view === 'workflow' ? <Workflow key={run.mode} preferences={preferences} run={run} trackScroll={trackScroll} openCoffee={openCoffee} data={engineEnabled ? (engineData && engineData.mode === run.mode ? engineData : null) : undefined} failureKind={engineEnabled ? engineFailure : (run.status === 'failure' ? previewFailure : null)} failureDetail={engineFailureDetail} configure={() => { setPendingMode(pendingMode ?? run.mode); setView('config'); }} change={async status => {
            if (engineEnabled && status === 'idle') { cancelRestartCommand(); try { applySnapshot(await panelCommand('STOP')); setPanelFailure(null); setError(''); } catch (failure) { setError((failure as Error).message); } return; }
            if (preferencesError(preferences)) { setPendingMode(run.mode); setView('config'); return; }
            if (engineEnabled) {
              if (status === 'running' && (run.status === 'success' || engineData?.restartFailed || failedRestartMode.current === run.mode)) {
                cancelRestartCommand();
                const epoch = restartCommandEpoch.current;
                restartTransportPending.current = true;
                setPanelFailure(null); setError('');
                setRun(current => ({ ...current, status: 'running' }));
                try {
                  const snapshot = await retryRestartCommand(run.mode, preferences.interval, {
                    cancelled: () => epoch !== restartCommandEpoch.current,
                    wait: milliseconds => new Promise<void>(resolve => {
                      const timer = setTimeout(() => { cancelRestartWait.current = null; resolve(); }, milliseconds);
                      cancelRestartWait.current = () => { clearTimeout(timer); resolve(); };
                    }),
                  });
                  if (snapshot && epoch === restartCommandEpoch.current) {
                    restartTransportPending.current = false;
                    applySnapshot(snapshot);
                  }
                } catch {
                  if (epoch === restartCommandEpoch.current) {
                    restartTransportPending.current = false; failedRestartMode.current = run.mode;
                    setRun(current => ({ ...current, status: 'failure' }));
                    setPanelFailure({ kind: 'generic', mode: run.mode });
                  }
                }
                return;
              }
              try {
                const busy = engineData && engineData.mode !== run.mode &&
                  (engineData.status !== 'idle' || engineData.reviewRequired || engineData.checkedAt != null);
                if (status === 'running' && busy) {
                  // Pending verification or manual sign-in cannot be discarded.
                  // Return to the old mode so it is verified first.
                  if (engineData.reviewRequired && engineData.reviewMessage && engineData.status !== 'failure') {
                    const back = engineData.mode;
                    setPendingMode(back); pendingRef.current = back;
                    try { await saveLastMode(back); } catch { /* Keep UI return even if the mode save fails. */ }
                    try { applySnapshot(await panelCommand('STATE')); } catch { applySnapshot(engineData); }
                    setError(engineData.reviewMessage);
                    setView('workflow');
                    return;
                  }
                  try { applySnapshot(await panelCommand('STOP')); } catch { /* START below re-enforces any remaining block. */ }
                }
                applySnapshot(await panelCommand('START', run.mode));
              } catch (failure) {
                // A Start-command failure renders the matching error screen,
                // not just a banner. Unknown responses and connection errors
                // use the catch-all; maintenance keeps its recovery guidance.
                if (!(failure instanceof Error && failure.message === MAINTENANCE_MESSAGE)) {
                  setPanelFailure({ kind: failure instanceof PanelCommandError ? failure.failureKind : 'generic', mode: run.mode,
                    ...(failure instanceof Error && isPanelCommandErrorMessage(failure.message) ? { detail: failure.message } : {}) });
                  setError('');
                } else setError((failure as Error).message);
              }
              return;
            }
            await persistRun({ ...run, status, lastChecked: status === 'running' ? '23:51:04' : run.lastChecked });
          }} /> : null}
        </>}
        {showTestMode && <p className={styles.testMode} role="note">Test Mode will not book appointment</p>}
      </section>
    </div>}
  </main>;
}
