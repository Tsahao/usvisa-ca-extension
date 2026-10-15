import './probe.css';
import type { ProbeState } from './background';

const status = document.querySelector<HTMLDListElement>('#status')!;
async function render(): Promise<void> {
  const saved = await chrome.storage.local.get(['developmentProbe', 'developmentProbeWakeAt']);
  const probe = saved.developmentProbe as ProbeState | undefined;
  const rows: [string, string][] = [
    ['Last check', probe?.checkedAt ?? 'Not checked'],
    ['Route category', probe?.route ?? 'Not checked'],
    ['Document reachable', probe?.documentReachable ? 'Yes' : 'No'],
    ['Recorded worker starts', String(probe?.workerStarts ?? 0)],
    ['Last alarm wake-up', typeof saved.developmentProbeWakeAt === 'string' ? saved.developmentProbeWakeAt : 'Not tested'],
  ];
  status.replaceChildren(...rows.flatMap(([label, value]) => {
    const term = document.createElement('dt'); term.textContent = label;
    const description = document.createElement('dd'); description.textContent = value;
    return [term, description];
  }));
}
document.querySelector('#wake')!.addEventListener('click', async () => {
  const result = document.querySelector('#result')!;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PROBE_WAKE' });
    result.textContent = response?.ok ? 'Wake-up scheduled. Close the service-worker inspector to allow normal suspension.' : 'Could not schedule the test.';
  } catch { result.textContent = 'Could not contact the background worker.'; }
});
chrome.storage.onChanged.addListener(() => { void render(); });
void render();

for (const [id, kind] of [['read-dashboard', 'dashboard'], ['read-summary', 'summary'], ['read-form', 'form']] as const) {
  document.querySelector(`#${id}`)!.addEventListener('click', async () => {
    const result = document.querySelector('#read-result')!;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PROBE_READ', kind });
      result.textContent = response?.ok
        ? `Read ok: route ${response.route}, items ${response.count}${response.identified !== undefined ? `, identified ${response.identified}` : ''}.`
        : 'Read refused: click the toolbar icon on the matching official page first, then run the read here.';
    } catch { result.textContent = 'Could not contact the background worker.'; }
  });
}

for (const [id, mode] of [['resolve-paid', 'booking'], ['resolve-unpaid', 'alerts']] as const) {
  document.querySelector(`#${id}`)!.addEventListener('click', async () => {
    const result = document.querySelector('#bind-result')!;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PROBE_RESOLVE', mode });
      result.textContent = response?.ok
        ? response.bound
          ? `Bound ${response.groupKind} run: status ${response.status}.`
          : `No new binding (run ${response.status}, group ${response.groupKind ?? 'unbound'}). Stop first, then resolve.`
        : 'Resolve refused: save IVRs in configuration, click the toolbar icon on the dashboard, then retry.';
    } catch { result.textContent = 'Could not contact the background worker.'; }
  });
}

document.querySelector('#stop-run')!.addEventListener('click', async () => {
  const result = document.querySelector('#bind-result')!;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PROBE_STOP' });
    result.textContent = response?.ok ? `Run status: ${response.status}.` : 'Could not stop the run.';
  } catch { result.textContent = 'Could not contact the background worker.'; }
});

document.querySelector('#poll-now')!.addEventListener('click', async () => {
  const result = document.querySelector('#bind-result')!;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PROBE_POLL' });
    result.textContent = response?.ok ? `Poll kicked: ${response.status}.` : 'Poll refused: bind a running run first.';
  } catch { result.textContent = 'Could not contact the background worker.'; }
});

document.querySelector('#reset-baseline')!.addEventListener('click', async () => {
  const result = document.querySelector('#bind-result')!;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PROBE_RESET' });
    result.textContent = response?.ok ? 'Baseline reset. Next healthy read re-alerts.' : 'Reset refused: no monitor baseline stored.';
  } catch { result.textContent = 'Could not contact the background worker.'; }
});

document.querySelector('#engine-status')!.addEventListener('click', async () => {  const result = document.querySelector('#bind-result')!;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PROBE_STATUS' });
    result.textContent = response?.ok ? `Engine: ${JSON.stringify(response)}` : 'Could not read engine status.';
  } catch { result.textContent = 'Could not contact the background worker.'; }
});
