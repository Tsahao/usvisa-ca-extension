import { useState } from 'react';
import { platform } from '../platform';
import { buildProblemEmail } from '../domain/problem-report';
import type { Mode } from './model';
import type { PanelFailureKind } from '../engine/panel-errors';
import styles from './Panel.module.css';

export function ReportProblem({ live, mode, status, testMode, failureKind }: {
  live: boolean; mode: Mode; status: string; testMode: boolean; failureKind: PanelFailureKind;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const report = async () => {
    if (opening) return;
    setOpening(true); setError('');
    let timer: number | undefined;
    try {
      let response;
      if (live) {
        try {
          response = await Promise.race([
            platform.runtime.sendMessage({ type: 'ENGINE_PROBLEM_REPORT' }),
            new Promise<undefined>(resolve => { timer = window.setTimeout(resolve, 2500); }),
          ]);
        } catch { /* Still open a useful draft when the worker is unavailable. */ }
        finally { clearTimeout(timer); }
      }
      let version: unknown;
      try { if (live) version = platform.runtime.getManifest().version; } catch { /* Unknown version. */ }
      const url = buildProblemEmail({ now: new Date().toISOString(), version, userAgent: navigator.userAgent,
        mode, status, testMode, failureKind, diagnostics: response?.ok ? response.diagnostics : undefined,
        context: response?.ok ? response.context : undefined });
      if (live) await platform.tabs.create({ url });
      else window.location.assign(url);
    } catch { setError('Unable to open your email app. Please try again.'); }
    finally { setOpening(false); }
  };
  return <>
    <button className={styles.secondary} disabled={opening} onClick={() => void report()}>Report a problem</button>
    {error && <p role="alert">{error}</p>}
  </>;
}
