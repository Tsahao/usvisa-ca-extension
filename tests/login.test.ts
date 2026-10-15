// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goToLoginFromLanding, performLoginAction, probeLoginStatus, retryAuthenticationPage, type LoginRequest } from '../src/adapter/login';
import { readSiteMaintenance } from '../src/adapter/reads';

const request: LoginRequest = { action: 'prepare', email: 'fixture@example.invalid', password: 'synthetic-password' };
const isolated = (args: LoginRequest) => new Function(`return (${performLoginAction.toString()})`)()(args);
let submitted = vi.fn<() => void>();
function notice() {
  document.body.insertAdjacentHTML('beforeend', '<div class="ui-widget-overlay"></div><div class="ui-dialog infoPopUp" role="dialog" aria-describedby="flash_messages"><div class="ui-dialog-titlebar"><button type="button" class="ui-dialog-titlebar-close">Close</button></div><div id="flash_messages" class="infoPopUp ui-dialog-content"><div class="alert">You need to sign in or sign up before continuing.</div></div><div class="ui-dialog-buttonpane"><div class="ui-dialog-buttonset"><button type="button" class="ui-button">OK</button></div></div></div>');
  const dialog = document.querySelector<HTMLElement>('.ui-dialog')!;
  const button = dialog.querySelector<HTMLButtonElement>('.ui-dialog-buttonpane button')!;
  const dismissed = vi.fn();
  button.onclick = () => { dismissed(); dialog.style.display = 'none'; document.querySelector('.ui-widget-overlay')!.remove(); };
  return { dialog, button, dismissed };
}
function bareNotice() {
  document.body.insertAdjacentHTML('beforeend', '<div class="ui-widget-overlay"></div><div class="notice-modal" role="dialog"><div id="flash_messages"><div class="flash notice">\n  You need to sign in\n  or sign up before continuing.\n</div></div><div><div><button type="button">OK</button></div></div></div>');
  const dialog = document.querySelector<HTMLElement>('.notice-modal')!;
  const button = dialog.querySelector<HTMLButtonElement>('button')!;
  const dismissed = vi.fn();
  button.onclick = () => { dismissed(); dialog.style.display = 'none'; document.querySelector('.ui-widget-overlay')!.remove(); };
  return { dialog, button, dismissed };
}
function stubReadyState(state: string) {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => state });
}
const EXPIRED_NOTICE = 'Your session has expired. Please log back in to continue.';
function expiredNotice() {
  document.body.insertAdjacentHTML('beforeend', `<div class="ui-widget-overlay"></div><div class="ui-dialog infoPopUp" role="dialog" aria-describedby="flash_messages"><div class="ui-dialog-titlebar"><button type="button" class="ui-dialog-titlebar-close">×</button></div><div id="flash_messages" class="infoPopUp ui-dialog-content"><div class="alert">${EXPIRED_NOTICE}</div></div><div class="ui-dialog-buttonpane"><div class="ui-dialog-buttonset"><button type="button" class="ui-button">OK</button></div></div></div>`);
  const dialog = document.querySelector<HTMLElement>('.ui-dialog')!;
  const button = dialog.querySelector<HTMLButtonElement>('.ui-dialog-buttonpane button')!;
  const dismissed = vi.fn();
  button.onclick = () => { dismissed(); dialog.style.display = 'none'; document.querySelector('.ui-widget-overlay')!.remove(); };
  return { dialog, button, dismissed };
}
function restoreReadyState() {
  Reflect.deleteProperty(document, 'readyState');
}
beforeEach(() => {
  vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in' });
  document.body.innerHTML = '<form id="sign_in_form" method="post" action="https://ais.usvisa-info.com/en-ca/niv/users/sign_in"><input id="user_email" type="email"><input id="user_password" type="password"><input id="policy_confirmed" type="checkbox"><input type="submit" name="commit" value="Sign In"></form>';
  submitted = vi.fn();
  document.querySelector('form')!.onsubmit = event => { event.preventDefault(); submitted(); };
});
afterEach(() => vi.unstubAllGlobals());
describe('serialized trusted login adapter', () => {
  it('recognizes an outage document without treating an announcement on the login form as an outage', () => {
    const read = new Function(`return (${readSiteMaintenance.toString()})`)();
    document.body.insertAdjacentHTML('beforeend', '<p>Our website is down for planned maintenance on Sunday.</p>');
    expect(read(true)).toEqual({ maintenance: false });
    document.body.innerHTML = '<div class="construction-background"><h1>Doing Maintenance</h1><h2>No need to worry.</h2></div>';
    expect(read(true)).toEqual({ maintenance: true });
    document.body.innerHTML = '<p>The nonimmigrant visa section is currently under maintenance.</p>';
    expect(read(true)).toEqual({ maintenance: true });
    document.body.innerHTML = '<p>Scheduled maintenance is planned for Sunday.</p>';
    expect(read(true)).toEqual({ maintenance: false });
  });
  it.each(['/en-ca/niv/', '/en-ca/niv/users/sign_in', '/en-ca/niv/groups/55555555', '/en-ca/niv/account', '/en-ca/niv/account/'])('retries %s with a fresh same-URL GET', path => {
    const replace = vi.fn();
    const href = `https://ais.usvisa-info.com${path}`;
    vi.stubGlobal('location', { href, replace });
    expect(new Function(`return (${retryAuthenticationPage.toString()})`)()()).toEqual({ ok: true });
    expect(replace).toHaveBeenCalledExactlyOnceWith(href);
    expect(submitted).not.toHaveBeenCalled();
  });
  it.each(['http://ais.usvisa-info.com/en-ca/niv/users/sign_in', 'https://example.invalid/en-ca/niv/users/sign_in',
    'https://ais.usvisa-info.com/en-ca/niv/users/sign_in?next=other', 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in#other',
    'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment'])('refuses retry outside exact authentication routes (%s)', href => {
    const replace = vi.fn(); vi.stubGlobal('location', { href, replace });
    expect(new Function(`return (${retryAuthenticationPage.toString()})`)()()).toEqual({ ok: false });
    expect(replace).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
  });
  it('dismisses only the sign-in notice, then rechecks before preparing credentials', () => {
    const { dismissed } = notice();
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#policy_confirmed')!.checked).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
    expect(isolated(request)).toEqual({ ok: true });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: true });
    expect(submitted).toHaveBeenCalledOnce();
  });
  it('dismisses a notice arriving after preparation without submitting until the next check', () => {
    expect(isolated(request)).toEqual({ ok: true });
    const { dismissed } = notice();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce(); expect(submitted).not.toHaveBeenCalled();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: true });
    expect(submitted).toHaveBeenCalledOnce();
  });
  it('dismisses the session-expired notice at prepare, then prepares and submits once', () => {
    const { dismissed } = expiredNotice();
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#policy_confirmed')!.checked).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
    expect(isolated(request)).toEqual({ ok: true });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: true });
    expect(submitted).toHaveBeenCalledOnce();
  });
  it('dismisses a session-expired notice arriving after preparation without submitting until the next check', () => {
    expect(isolated(request)).toEqual({ ok: true });
    const { dismissed } = expiredNotice();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce(); expect(submitted).not.toHaveBeenCalled();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: true });
    expect(submitted).toHaveBeenCalledOnce();
  });
  it('dismisses the session-expired notice without decorative classes, binding, or exact whitespace', () => {
    document.body.insertAdjacentHTML('beforeend', `<div class="ui-widget-overlay"></div><div class="notice-modal" role="dialog"><div id="flash_messages"><div class="flash notice">\n  Your session has expired.\n  Please log back in to continue.\n</div></div><div><div><button type="button">OK</button></div></div></div>`);
    const dialog = document.querySelector<HTMLElement>('.notice-modal')!;
    const button = dialog.querySelector<HTMLButtonElement>('button')!;
    const dismissed = vi.fn();
    button.onclick = () => { dismissed(); dialog.style.display = 'none'; document.querySelector('.ui-widget-overlay')!.remove(); };
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#policy_confirmed')!.checked).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
    expect(isolated(request)).toEqual({ ok: true });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: true });
    expect(submitted).toHaveBeenCalledOnce();
  });
  it('dismisses the session-expired notice before a challenge handoff without filling', () => {
    const { dismissed } = expiredNotice();
    document.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha"></div>');
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(isolated(request)).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(dismissed).toHaveBeenCalledOnce(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
  });
  it('dismisses the session-expired notice before classifying a credential flash', () => {
    const { dismissed } = expiredNotice();
    document.body.insertAdjacentHTML('beforeend', '<div class="alert alert-danger">Invalid Email or password.</div>');
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce(); expect(submitted).not.toHaveBeenCalled();
    expect(isolated(request)).toEqual({ ok: false, reason: 'credential-rejected' });
    expect(submitted).not.toHaveBeenCalled();
  });
  it.each(['extra-wording', 'duplicate-dialog', 'navigating-button', 'flash-button-path', 'linked-button', 'button-onclick'])('leaves an unsafe or ambiguous session-expired dialog untouched (%s)', issue => {
    const { dialog, button, dismissed } = expiredNotice();
    if (issue === 'extra-wording') document.querySelector('#flash_messages')!.textContent = `${EXPIRED_NOTICE} Synthetic suffix.`;
    if (issue === 'duplicate-dialog') document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Synthetic second dialog</div>');
    if (issue === 'navigating-button') button.setAttribute('data-url', '/en-ca/niv/groups');
    if (issue === 'flash-button-path') document.querySelector('#flash_messages')!.setAttribute('button-path', '/en-ca/niv/groups');
    if (issue === 'linked-button') button.outerHTML = '<a href="https://ais.usvisa-info.com/en-ca/niv">OK</a>';
    if (issue === 'button-onclick') button.setAttribute('onclick', 'void 0');
    expect(isolated(request)).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(dismissed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(dialog.isConnected).toBe(true);
  });
  it('dismisses the notice without decorative classes, binding, or exact whitespace', () => {
    const { dismissed } = bareNotice();
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#policy_confirmed')!.checked).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
    expect(isolated(request)).toEqual({ ok: true });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: true });
    expect(submitted).toHaveBeenCalledOnce();
  });
  it('dismisses the recognized notice before a challenge handoff without filling', () => {
    const { dismissed } = notice();
    document.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha"></div>');
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(isolated(request)).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(dismissed).toHaveBeenCalledOnce(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
  });
  it.each(['challenge', 'otp'])('dismisses the notice first, then hands a present %s to manual authentication', issue => {
    const { dismissed } = notice();
    document.body.insertAdjacentHTML('beforeend', issue === 'otp' ? '<input autocomplete="one-time-code">' : '<div class="g-recaptcha"></div>');
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce(); expect(submitted).not.toHaveBeenCalled();
    expect(isolated(request)).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(submitted).not.toHaveBeenCalled();
  });
  it('dismisses the recognized notice before classifying a credential flash', () => {
    const { dismissed } = notice();
    document.body.insertAdjacentHTML('beforeend', '<div class="alert alert-danger">Invalid Email or password.</div>');
    expect(isolated(request)).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    expect(dismissed).toHaveBeenCalledOnce(); expect(submitted).not.toHaveBeenCalled();
    expect(isolated(request)).toEqual({ ok: false, reason: 'credential-rejected' });
    expect(submitted).not.toHaveBeenCalled();
  });
  it('reports an explicit credential rejection as a stop', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="alert alert-danger">Invalid Email or password.</div>');
    expect(isolated(request)).toEqual({ ok: false, reason: 'credential-rejected' });
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(submitted).not.toHaveBeenCalled();
  });
  it('treats controls missing during load as retryable without masking unsafe structure', () => {
    document.querySelector('#user_password')!.remove();
    try {
      stubReadyState('loading');
      expect(isolated(request)).toEqual({ ok: false, reason: 'retryable' });
      expect(submitted).not.toHaveBeenCalled();
    } finally { restoreReadyState(); }
    expect(isolated(request)).toEqual({ ok: false });
    expect(submitted).not.toHaveBeenCalled();
  });
  it('never treats duplicated controls as transient, even while loading', () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="user_email">');
    try {
      stubReadyState('loading');
      expect(isolated(request)).toEqual({ ok: false });
      expect(submitted).not.toHaveBeenCalled();
    } finally { restoreReadyState(); }
  });
  it.each(['message', 'duplicate-dialog', 'duplicate-message', 'extra-button', 'disabled', 'hidden-button', 'submit-button', 'form-button', 'wrong-binding', 'interactive-content', 'navigating-button', 'linked-button'])('leaves an unrecognized or ambiguous popup untouched (%s)', issue => {
    const { dialog, button, dismissed } = notice();
    if (issue === 'message') document.querySelector('#flash_messages')!.textContent = 'Synthetic account warning';
    if (issue === 'duplicate-dialog') document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Synthetic second dialog</div>');
    if (issue === 'duplicate-message') document.body.insertAdjacentHTML('beforeend', '<div id="flash_messages"></div>');
    if (issue === 'extra-button') button.insertAdjacentHTML('afterend', '<button type="button">Cancel</button>');
    if (issue === 'disabled') button.disabled = true;
    if (issue === 'hidden-button') button.hidden = true;
    if (issue === 'submit-button') button.type = 'submit';
    if (issue === 'form-button') button.setAttribute('form', 'sign_in_form');
    if (issue === 'wrong-binding') dialog.setAttribute('aria-describedby', 'other');
    if (issue === 'interactive-content') document.querySelector('#flash_messages')!.insertAdjacentHTML('beforeend', '<input>');
    if (issue === 'navigating-button') button.setAttribute('data-url', '/en-ca/niv/groups');
    if (issue === 'linked-button') button.outerHTML = '<a href="https://ais.usvisa-info.com/en-ca/niv">OK</a>';
    expect(isolated(request)).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(dismissed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
  });
  it.each(['button-path', 'alt_button-path', 'alt_button-text', 'no_close', 'data-url', 'onclick'])('leaves a flash message bearing %s untouched without filling', attribute => {
    const { button, dismissed } = notice();
    document.querySelector('#flash_messages')!.setAttribute(attribute, attribute.startsWith('alt_button-text') ? 'Synthetic' : '/en-ca/niv/groups');
    expect(isolated(request)).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(dismissed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#policy_confirmed')!.checked).toBe(false);
    expect(button.isConnected).toBe(true);
  });
  it.each(['anchor-ok', 'button-onclick', 'ancestor-onclick', 'dialog-onclick', 'aria-disabled-empty'])('leaves a dialog with an unsafe OK control or handler untouched (%s)', issue => {
    const { dialog, button, dismissed } = notice();
    if (issue === 'anchor-ok') button.outerHTML = '<a>OK</a>';
    if (issue === 'button-onclick') button.setAttribute('onclick', 'void 0');
    if (issue === 'ancestor-onclick') dialog.querySelector('.ui-dialog-buttonset')!.setAttribute('onclick', 'void 0');
    if (issue === 'dialog-onclick') dialog.setAttribute('onclick', 'void 0');
    if (issue === 'aria-disabled-empty') button.setAttribute('aria-disabled', '');
    expect(isolated(request)).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(dismissed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
  });
  it.each(['offsite', 'wrong-route', 'wrong-form'])('does not dismiss the notice when the sign-in context is unsafe (%s)', issue => {
    const { dismissed } = notice();
    if (issue === 'offsite') vi.stubGlobal('location', { href: 'https://example.invalid/en-ca/niv/users/sign_in' });
    if (issue === 'wrong-route') vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    if (issue === 'wrong-form') document.querySelector('form')!.action = 'https://example.invalid';
    expect(isolated(request).ok).toBe(false);
    expect(dismissed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
  });
  it('ignores hidden dialog templates but refuses a blocking overlay without a dialog', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="reveal-overlay" style="display:none"><div role="dialog" data-reveal>Template</div></div><div role="dialog" aria-hidden="true">Second-factor template</div>');
    expect(isolated(request)).toEqual({ ok: true });
    document.body.insertAdjacentHTML('beforeend', '<div class="ui-widget-overlay"></div>');
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(submitted).not.toHaveBeenCalled();
  });
  it('rechecks the context after dismissal rather than submitting into a newly added challenge', () => {
    expect(isolated(request)).toEqual({ ok: true });
    notice();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: false, reason: 'sign-in-notice-dismissed' });
    document.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha"></div>');
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(submitted).not.toHaveBeenCalled();
  });
  it('prepares synthetic credentials and acknowledges the policy once, then submits separately', () => {
    const policy = document.querySelector<HTMLInputElement>('#policy_confirmed')!;
    const clicked = vi.fn(); policy.onclick = clicked;
    expect(isolated(request)).toEqual({ ok: true });
    expect(isolated(request)).toEqual({ ok: true });
    expect(clicked).toHaveBeenCalledOnce(); expect(submitted).not.toHaveBeenCalled();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: true });
    expect(submitted).toHaveBeenCalledOnce();
  });
  it.each(['offsite', 'wrong-route', 'wrong-target', 'captcha', 'otp', 'duplicate', 'disabled', 'override', 'rejected'])('refuses credential mutation and submission on %s', issue => {
    if (issue === 'offsite') vi.stubGlobal('location', { href: 'https://example.invalid/en-ca/niv/users/sign_in' });
    if (issue === 'wrong-route') vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    if (issue === 'wrong-target') document.querySelector('form')!.action = 'https://example.invalid';
    if (issue === 'captcha') document.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha"></div>');
    if (issue === 'otp') document.body.insertAdjacentHTML('beforeend', '<input autocomplete="one-time-code">');
    if (issue === 'duplicate') document.body.insertAdjacentHTML('beforeend', '<input id="user_email">');
    if (issue === 'disabled') document.querySelector<HTMLInputElement>('#user_password')!.disabled = true;
    if (issue === 'override') document.querySelector('input[type="submit"]')!.setAttribute('formaction', 'https://example.invalid');
    if (issue === 'rejected') document.body.insertAdjacentHTML('beforeend', '<div class="flash error">Synthetic rejection</div>');
    expect(isolated(request)).toEqual(issue === 'captcha' || issue === 'otp' ? { ok: false, reason: 'manual-authentication' } : { ok: false });
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(submitted).not.toHaveBeenCalled();
  });
  it('allows the observed image-only CAPTCHA branding without changing it', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="captcha_container"><img alt="Captcha logo"></div>');
    const branding = document.querySelector('.captcha_container')!.outerHTML;
    expect(isolated(request)).toEqual({ ok: true });
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe(request.email);
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe(request.password);
    expect(submitted).not.toHaveBeenCalled();
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: true });
    expect(submitted).toHaveBeenCalledOnce();
    expect(document.querySelector('.captcha_container')!.outerHTML).toBe(branding);
  });
  it.each([
    '<div class="captcha_container"><img><input name="captcha_answer"></div>',
    '<div class="captcha_container"><img><iframe src="/captcha"></iframe></div>',
    '<div class="captcha_container"><button>Verify</button></div>',
    '<div class="captcha_container">Verify you are human<img></div>',
    '<div class="captcha_container" data-sitekey="synthetic"><img></div>',
    '<div class="captcha_container" onclick="void 0"><img></div>',
    '<div class="captcha_container"><img role="button"></div>',
    '<div class="captcha_container g-recaptcha"><img></div>',
    '<div class="captcha_container"><div><img></div></div>',
    '<iframe src="/challenge"></iframe>',
    '<div class="cf-turnstile"></div>',
  ])('retains manual handoff for challenge markup: %s', markup => {
    document.body.insertAdjacentHTML('beforeend', markup);
    expect(isolated(request)).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(submitted).not.toHaveBeenCalled();
  });
  it('checks for a challenge again immediately before submission', () => {
    expect(isolated(request)).toEqual({ ok: true });
    document.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha"></div>');
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(submitted).not.toHaveBeenCalled();
  });
  it('never submits incomplete or changed credentials', () => {
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: false });
    expect(isolated(request)).toEqual({ ok: true });
    document.querySelector<HTMLInputElement>('#user_password')!.value = 'changed-synthetic-value';
    expect(isolated({ ...request, action: 'submit' })).toEqual({ ok: false });
    expect(submitted).not.toHaveBeenCalled();
  });
  it.each(['https://ais.usvisa-info.com/en-ca/niv', 'https://ais.usvisa-info.com/en-ca/niv/'])('leaves the landing page for sign-in in the same tab (%s)', href => {
    vi.stubGlobal('location', { href } as unknown as Location);
    const isolatedLanding = new Function(`return (${goToLoginFromLanding.toString()})`)() as () => { ok: boolean };
    expect(isolatedLanding()).toEqual({ ok: true });
  });
  it.each(['https://example.invalid/en-ca/niv/', 'https://ais.usvisa-info.com/en-ca/niv/groups', 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in'])('refuses landing login navigation off the landing page (%s)', href => {
    vi.stubGlobal('location', { href } as unknown as Location);
    const isolatedLanding = new Function(`return (${goToLoginFromLanding.toString()})`)() as () => { ok: boolean };
    expect(isolatedLanding()).toEqual({ ok: false });
  });
});
describe('read-only post-submit login probe', () => {
  const probed = () => new Function(`return (${probeLoginStatus.toString()})`)()();
  it('reports a clean signed-out form without filling or submitting', () => {
    expect(probed()).toEqual({ ok: true });
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#policy_confirmed')!.checked).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
  });
  it('reports an explicit credential rejection without filling', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="alert alert-danger">Invalid Email or password.</div>');
    expect(probed()).toEqual({ ok: false, reason: 'credential-rejected' });
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(submitted).not.toHaveBeenCalled();
  });
  it('hands a fresh challenge to manual authentication without filling', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="g-recaptcha"></div>');
    expect(probed()).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(submitted).not.toHaveBeenCalled();
  });
  it('treats the recognized notice as transient without clicking it', () => {
    const { dismissed } = notice();
    expect(probed()).toEqual({ ok: false, reason: 'retryable' });
    expect(dismissed).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(submitted).not.toHaveBeenCalled();
  });
  it('treats the session-expired notice as retryable without clicking, filling, or submitting', () => {
    const { dismissed } = expiredNotice();
    expect(probed()).toEqual({ ok: false, reason: 'retryable' });
    expect(dismissed).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_email')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
    expect(document.querySelector<HTMLInputElement>('#policy_confirmed')!.checked).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
  });
  it('hands an unsafe session-expired dialog to manual authentication untouched', () => {
    const { dismissed } = expiredNotice();
    document.querySelector('#flash_messages')!.textContent = `${EXPIRED_NOTICE} Synthetic suffix.`;
    expect(probed()).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(dismissed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
  });
  it('hands an unrecognized dialog to manual authentication untouched', () => {
    const { dismissed } = notice();
    document.querySelector('#flash_messages')!.textContent = 'Synthetic account warning';
    expect(probed()).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(dismissed).not.toHaveBeenCalled(); expect(submitted).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>('#user_password')!.value).toBe('');
  });
  it('treats controls missing during load as retryable without masking unsafe structure', () => {
    document.querySelector('#user_password')!.remove();
    try {
      stubReadyState('loading');
      expect(probed()).toEqual({ ok: false, reason: 'retryable' });
    } finally { restoreReadyState(); }
    expect(probed()).toEqual({ ok: false });
    expect(submitted).not.toHaveBeenCalled();
  });
  it('allows the observed image-only CAPTCHA branding', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="captcha_container"><img alt="Captcha logo"></div>');
    expect(probed()).toEqual({ ok: true });
    expect(submitted).not.toHaveBeenCalled();
  });
  it('leaves a blocking overlay without a dialog for manual authentication', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="ui-widget-overlay"></div>');
    expect(probed()).toEqual({ ok: false, reason: 'manual-authentication' });
    expect(submitted).not.toHaveBeenCalled();
  });
  it.each(['https://example.invalid/en-ca/niv/users/sign_in', 'https://ais.usvisa-info.com/en-ca/niv/groups',
    'https://ais.usvisa-info.com/en-ca/niv/users/sign_in?next=other'])('refuses probe outside the exact sign-in route (%s)', href => {
    vi.stubGlobal('location', { href });
    expect(probed().ok).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
  });
});
