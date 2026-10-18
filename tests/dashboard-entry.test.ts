// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { performDashboardContinue } from '../src/adapter/dashboard-entry';

const act: typeof performDashboardContinue = new Function(`return (${performDashboardContinue.toString()})`)();
const request = { scheduleId: '11111111', ivr: '22222222', dashboardPath: '/en-ca/niv/groups/55555555', applicantIds: ['77777777', '88888888'] };
function fixture() {
  vi.stubGlobal('location', { href: `https://ais.usvisa-info.com${request.dashboardPath}` });
  document.body.innerHTML = '<section><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul><strong>22222222</strong><table><tbody><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/77777777">Details</a></td></tr><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/88888888">Details</a></td></tr></tbody></table></section><section><strong>44444444</strong><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></section>';
  const clicked = vi.fn((event: Event) => event.preventDefault());
  document.querySelector('a')!.addEventListener('click', clicked);
  return clicked;
}
afterEach(() => { document.head.innerHTML = ''; vi.unstubAllGlobals(); });
describe('same-tab paid dashboard entry', () => {
  it('clicks only the selected group Continue with its independent complete roster', () => {
    const clicked = fixture();
    expect(act(request)).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalledOnce();
  });
  // Dashboard entry targets the continue_actions link by exact same-group
  // href plus independent roster custody; unlike the continue_actions
  // gateway and the warning/applicant Continue controls, it never matches
  // on visible copy, so any label still enters.
  it.each(['Continue', 'Schedule Appointment', '  SCHEDULE   Appointment  '])('accepts first-time dashboard copy without checking its label (%s)', label => {
    const clicked = fixture();
    document.querySelector('a')!.textContent = label;
    expect(act(request)).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalledOnce();
  });
  it.each(['wrong-ivr', 'dropped-applicant', 'unchecked-identity', 'wrong-target', 'offsite', 'duplicate-entry', 'hidden', 'wrong-dashboard', 'new-tab', 'download', 'base-target'])('refuses changed or ambiguous dashboard controls (%s)', issue => {
    const clicked = fixture();
    const link = document.querySelector('a')!;
    if (issue === 'wrong-ivr') document.querySelector('strong')!.textContent = '99999999';
    if (issue === 'dropped-applicant') document.querySelector('tbody')!.lastElementChild!.remove();
    if (issue === 'unchecked-identity') document.querySelector('tbody a')!.setAttribute('data-method', 'delete');
    if (issue === 'wrong-target') link.href = '/en-ca/niv/schedule/33333333/continue_actions';
    if (issue === 'offsite') link.href = 'https://example.invalid/en-ca/niv/schedule/11111111/continue_actions';
    if (issue === 'duplicate-entry') link.insertAdjacentElement('afterend', link.cloneNode(true) as Element);
    if (issue === 'hidden') link.hidden = true;
    if (issue === 'new-tab') link.target = '_blank';
    if (issue === 'download') link.setAttribute('download', '');
    if (issue === 'base-target') document.head.innerHTML = '<base target="_blank">';
    if (issue === 'wrong-dashboard') vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/66666666' });
    expect(act(request)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
  });
  it('accepts a null-IVR request by exact schedule scope and clicks only its Continue link', () => {
    const request = { scheduleId: '11111111', ivr: null, dashboardPath: '/en-ca/niv/groups/55555555', applicantIds: ['77777777', '88888888'] };
    vi.stubGlobal('location', { href: `https://ais.usvisa-info.com${request.dashboardPath}` });
    document.body.innerHTML = '<section><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul><strong>99999999</strong><table><tbody><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/77777777">Details</a></td></tr><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/88888888">Details</a></td></tr></tbody></table></section><section><strong>44444444</strong><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></section>';
    const clickedSelected = vi.fn((event: Event) => event.preventDefault());
    const clickedSibling = vi.fn((event: Event) => event.preventDefault());
    const links = document.querySelectorAll('a');
    links[0].addEventListener('click', clickedSelected);
    links[3].addEventListener('click', clickedSibling);
    // A null binding proves the group by the unique schedule scope: the card's
    // own IVR reading is not required (the schedule is primary), and only the
    // exact-schedule Continue link is clicked — never the sibling's.
    expect(act(request)).toEqual({ ok: true });
    expect(clickedSelected).toHaveBeenCalledOnce();
    expect(clickedSibling).not.toHaveBeenCalled();
  });
  it('fails a null-IVR request closed when the schedule scope is ambiguous', () => {
    const request = { scheduleId: '11111111', ivr: null, dashboardPath: '/en-ca/niv/groups/55555555', applicantIds: ['77777777', '88888888'] };
    vi.stubGlobal('location', { href: `https://ais.usvisa-info.com${request.dashboardPath}` });
    document.body.innerHTML = '<section><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul><strong>22222222</strong><strong>99999999</strong><table><tbody><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/77777777">Details</a></td></tr><tr><td><a href="/en-ca/niv/schedule/11111111/applicants/88888888">Details</a></td></tr></tbody></table></section>';
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('a')!.addEventListener('click', clicked);
    expect(act(request)).toEqual({ ok: false });
    expect(clicked).not.toHaveBeenCalled();
  });
});
