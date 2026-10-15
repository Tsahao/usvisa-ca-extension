export type LoginRequest = { action: 'prepare' | 'submit'; email: string; password: string };
export type LoginResult = { ok: boolean; reason?: 'manual-authentication' | 'sign-in-notice-dismissed' | 'retryable' | 'credential-rejected' };
export type LoginProbeResult = { ok: boolean; reason?: 'manual-authentication' | 'retryable' | 'credential-rejected' };

// Strictly read-only post-submit probe for the worker `wait` phase. Mirrors
// the trusted route/form/challenge/flash checks of performLoginAction without
// filling, clicking, or submitting, and without credentials: a clean
// signed-out form reports ok:true, an explicit rejection or a fresh
// challenge resolves immediately, and anything unrecognized stays unsafe.
// Self-contained for page injection; never transmits credentials.

// Retry only an owned authentication document with a fresh GET. A reload
// after sign-in could replay its POST; replace avoids resubmitting it.
export function retryAuthenticationPage(): { ok: boolean } {
  const current = new URL(location.href);
  if (current.origin !== 'https://ais.usvisa-info.com' || current.username || current.password || current.port || current.hash || current.search ||
      !/^\/en-ca\/niv(?:\/?|\/users\/sign_in|\/groups(?:\/[0-9]+)?|\/account\/?)$/.test(current.pathname)) return { ok: false };
  location.replace(current.href);
  return { ok: true };
}

// Leaves the site-root landing page for sign-in in the same tab. The landing
// page auto-redirects to the dashboard when signed in and otherwise offers
// Continue to sign-in; going to the fixed login URL directly covers the latter
// without opening a new tab. Self-contained for page injection.
export function goToLoginFromLanding(): { ok: boolean } {
  const current = new URL(location.href);
  if (current.origin !== 'https://ais.usvisa-info.com' || current.username || current.password || current.port || current.hash ||
      (current.pathname !== '/en-ca/niv' && current.pathname !== '/en-ca/niv/')) return { ok: false };
  location.href = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
  return { ok: true };
}

export function performLoginAction(request: LoginRequest): LoginResult {
  const current = new URL(location.href);
  if (current.origin !== 'https://ais.usvisa-info.com' || current.username || current.password || current.port || current.hash ||
      current.pathname !== '/en-ca/niv/users/sign_in' || current.search) return { ok: false };
  const visible = (element: Element) => {
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.hasAttribute('hidden') || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  // The trusted sign-in form is validated before any harmless dismissal. A
  // missing control while the document is still loading is transient; any
  // other structural mismatch stays an unsafe stop, never a retry.
  const forms = document.querySelectorAll<HTMLFormElement>('#sign_in_form');
  const emails = document.querySelectorAll<HTMLInputElement>('#user_email');
  const passwords = document.querySelectorAll<HTMLInputElement>('#user_password');
  const policies = document.querySelectorAll<HTMLInputElement>('#policy_confirmed');
  if (forms.length !== 1 || emails.length !== 1 || passwords.length !== 1 || policies.length !== 1) {
    const missing = forms.length === 0 || emails.length === 0 || passwords.length === 0 || policies.length === 0;
    const duplicated = forms.length > 1 || emails.length > 1 || passwords.length > 1 || policies.length > 1;
    let loading = false;
    try { loading = document.readyState !== 'complete'; } catch { loading = false; }
    if (missing && !duplicated && loading) return { ok: false, reason: 'retryable' };
    return { ok: false };
  }
  const form = forms[0];
  const target = new URL(form.getAttribute('action') ?? '', current.href);
  const submits = form.querySelectorAll<HTMLInputElement>('input[type="submit"]');
  if (form.method.toLowerCase() !== 'post' || target.origin !== current.origin || target.username || target.password || target.port || target.hash || target.search ||
      target.pathname !== '/en-ca/niv/users/sign_in' || submits.length !== 1 || submits[0].disabled || submits[0].hasAttribute('formaction') || submits[0].hasAttribute('formmethod') ||
      [emails[0], passwords[0], policies[0]].some(control => control.form !== form || control.disabled) || policies[0].type !== 'checkbox' ||
      passwords[0].type !== 'password' || !['text', 'email'].includes(emails[0].type)) return { ok: false };
  if (typeof request.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email) ||
      typeof request.password !== 'string' || request.password.length === 0) return { ok: false };
  if (request.action !== 'prepare' && (request.action !== 'submit' || emails[0].value !== request.email ||
      passwords[0].value !== request.password || !policies[0].checked)) return { ok: false };
  // The intermittent sign-in notice is recognized semantically so decorative
  // jQuery classes cannot block dismissal: one visible dialog containing the
  // unique flash message with the exact notice text and a single safe OK
  // control. Anything else stays untouched for manual handling. This runs
  // before CAPTCHA and flash-error checks so the notice's own styling is
  // never mistaken for a credential or challenge failure; the next injection
  // rechecks every safety condition before any credential handling.
  const dialogs = Array.from(document.querySelectorAll('.ui-dialog, [role="dialog"], [role="alertdialog"], [data-reveal]')).filter(visible);
  if (dialogs.length) {
    const dialog = dialogs[0];
    const found = document.querySelectorAll('#flash_messages');
    const message = found.length === 1 ? found[0] : null;
    const describedBy = dialog.getAttribute('aria-describedby');
    const controls = Array.from(dialog.querySelectorAll('button, input[type="button"], input[type="submit"], a')).filter(visible);
    // Alternate OK elements stay scoped to the evidenced need: only a
    // non-submit enabled button. Href-less anchors are never dismissal
    // controls, but anchors stay in the control set so any competing link
    // keeps the dialog unrecognized instead of being ignored.
    const isDismissalControl = (control: Element): boolean => {
      const label = (control.tagName === 'INPUT' ? (control as HTMLInputElement).value : control.textContent)?.replace(/\s+/g, ' ').trim();
      if (label !== 'OK') return false;
      if (control.tagName === 'BUTTON' || control.tagName === 'INPUT') {
        const pressable = control as HTMLButtonElement | HTMLInputElement;
        const ariaDisabled = pressable.getAttribute('aria-disabled');
        if (pressable.type !== 'button' || pressable.disabled || pressable.form || pressable.hasAttribute('form') ||
            pressable.hasAttribute('formaction') || pressable.hasAttribute('formmethod') ||
            (ariaDisabled !== null && ariaDisabled.toLowerCase() !== 'false') || pressable.closest('form') || pressable.closest('a')) return false;
        // An inline handler on the control would run on click alongside (or
        // instead of) a close, so only a handler-free control is safe.
        if (Array.from(control.attributes).some(attribute => /^on/i.test(attribute.name))) return false;
        // The click bubbles through the control's ancestors up to the dialog:
        // any inline handler there would also run, so it must be handler-free.
        for (let ancestor: Element | null = control.parentElement; ancestor && ancestor !== dialog; ancestor = ancestor.parentElement) {
          if (Array.from(ancestor.attributes).some(attribute => /^on/i.test(attribute.name))) return false;
        }
      } else return false;
      return !control.hasAttribute('data-url') && !control.hasAttribute('data-href') && !control.hasAttribute('data-path') &&
        !control.hasAttribute('data-redirect') && !control.hasAttribute('data-location');
    };
    const isCloseControl = (control: Element): boolean => {
      if (control.tagName !== 'BUTTON') return false;
      const label = control.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return (control as HTMLButtonElement).type === 'button' &&
        (label === '' || /^(x|×|✕|✖)$/iu.test(label) || /^close$/i.test(label));
    };
    // The site's flash renderer reads navigation attributes off #flash_messages
    // itself ('button-path' makes OK navigate instead of close;
    // 'alt_button-path', 'alt_button-text' and 'no_close' select alternate
    // behavior), so any of those — or any other navigation/handler bearing
    // attribute on the message — keeps the dialog unrecognized. The message
    // element itself must also be non-interactive: only its exact text is read.
    // Two known notices share this dismissal: the intermittent sign-in notice
    // and the long-timeout session-expired notice from the user screenshot.
    // Any other OK-dialog text stays untouched for manual handling.
    const noticeText = message?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const knownNotice = noticeText === 'You need to sign in or sign up before continuing.' ||
      noticeText === 'Your session has expired. Please log back in to continue.';
    const messageNavigates = message !== null && (
      message.hasAttribute('button-path') || message.hasAttribute('alt_button-path') ||
      message.hasAttribute('alt_button-text') || message.hasAttribute('no_close') ||
      message.hasAttribute('data-url') || message.hasAttribute('data-href') || message.hasAttribute('data-path') ||
      message.hasAttribute('data-redirect') || message.hasAttribute('data-location') ||
      message.hasAttribute('href') || message.hasAttribute('src') || message.hasAttribute('action') ||
      ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME'].includes(message.tagName) ||
      message.hasAttribute('contenteditable') ||
      Array.from(message.attributes).some(attribute => /^on/i.test(attribute.name)));
    const dialogHandlesClick = Array.from(dialog.attributes).some(attribute => /^on/i.test(attribute.name));
    const recognized = dialogs.length === 1 && message !== null && dialog.contains(message) && visible(message) &&
      !messageNavigates && !dialogHandlesClick && knownNotice &&
      !message.querySelector('a, button, input, select, textarea, iframe, [contenteditable]') &&
      (describedBy === null || describedBy.trim() === '' || describedBy.trim() === 'flash_messages') &&
      controls.filter(isDismissalControl).length === 1 && controls.every(control => isDismissalControl(control) || isCloseControl(control));
    if (!recognized) return { ok: false, reason: 'manual-authentication' };
    (controls.filter(isDismissalControl)[0] as HTMLElement).click();
    // Let the site's close handler finish. The worker keeps this phase and
    // validates the whole page again before filling or submitting anything.
    return { ok: false, reason: 'sign-in-notice-dismissed' };
  }
  if (document.querySelector('iframe[src*="captcha" i], iframe[src*="challenge" i], [data-sitekey], .cf-turnstile, #challenge-running, #cf-challenge-running, input[autocomplete="one-time-code"], input[name*="otp" i]')) return { ok: false, reason: 'manual-authentication' };
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[class*="captcha" i]'))) {
    const captchaClasses = Array.from(element.classList).filter(name => name.toLowerCase().includes('captcha'));
    const image = element.firstElementChild;
    const passiveLogo = captchaClasses.length === 1 && captchaClasses[0] === 'captcha_container' &&
      element.childElementCount === 1 && image?.tagName === 'IMG' && image.childElementCount === 0 && !element.textContent?.trim() &&
      !element.matches('[onclick], [tabindex], [role="button"], [contenteditable]') &&
      !image.matches('[onclick], [tabindex], [role="button"], [contenteditable]');
    if (!passiveLogo) return { ok: false, reason: 'manual-authentication' };
  }
  // An explicit credential rejection stops instead of retrying; any other
  // flash styling stays an unrecognized stop without a reason.
  const failures = Array.from(document.querySelectorAll('.alert.alert-danger, .flash.error'));
  if (failures.length) {
    const text = failures.map(element => element.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (['invalid', 'incorrect', 'wrong'].some(word => text.includes(word)) &&
        ['email', 'password', 'login', 'credential'].some(word => text.includes(word))) {
      return { ok: false, reason: 'credential-rejected' };
    }
    return { ok: false };
  }
  if (Array.from(document.querySelectorAll('.ui-widget-overlay, .reveal-overlay')).some(visible)) return { ok: false, reason: 'manual-authentication' };
  if (request.action === 'prepare') {
    emails[0].value = request.email;
    passwords[0].value = request.password;
    emails[0].dispatchEvent(new Event('input', { bubbles: true }));
    passwords[0].dispatchEvent(new Event('input', { bubbles: true }));
    if (!policies[0].checked) policies[0].click();
    return { ok: policies[0].checked && emails[0].value === request.email && passwords[0].value === request.password };
  }
  submits[0].click();
  return { ok: true };
}

export function probeLoginStatus(): LoginProbeResult {
  const current = new URL(location.href);
  if (current.origin !== 'https://ais.usvisa-info.com' || current.username || current.password || current.port || current.hash ||
      current.pathname !== '/en-ca/niv/users/sign_in' || current.search) return { ok: false };
  const visible = (element: Element) => {
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.hasAttribute('hidden') || ancestor.hasAttribute('inert') || ancestor.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    return true;
  };
  const forms = document.querySelectorAll<HTMLFormElement>('#sign_in_form');
  const emails = document.querySelectorAll<HTMLInputElement>('#user_email');
  const passwords = document.querySelectorAll<HTMLInputElement>('#user_password');
  const policies = document.querySelectorAll<HTMLInputElement>('#policy_confirmed');
  if (forms.length !== 1 || emails.length !== 1 || passwords.length !== 1 || policies.length !== 1) {
    const missing = forms.length === 0 || emails.length === 0 || passwords.length === 0 || policies.length === 0;
    const duplicated = forms.length > 1 || emails.length > 1 || passwords.length > 1 || policies.length > 1;
    let loading = false;
    try { loading = document.readyState !== 'complete'; } catch { loading = false; }
    if (missing && !duplicated && loading) return { ok: false, reason: 'retryable' };
    return { ok: false };
  }
  const form = forms[0];
  const target = new URL(form.getAttribute('action') ?? '', current.href);
  const submits = form.querySelectorAll<HTMLInputElement>('input[type="submit"]');
  if (form.method.toLowerCase() !== 'post' || target.origin !== current.origin || target.username || target.password || target.port || target.hash || target.search ||
      target.pathname !== '/en-ca/niv/users/sign_in' || submits.length !== 1 || submits[0].disabled || submits[0].hasAttribute('formaction') || submits[0].hasAttribute('formmethod') ||
      [emails[0], passwords[0], policies[0]].some(control => control.form !== form || control.disabled) || policies[0].type !== 'checkbox' ||
      passwords[0].type !== 'password' || !['text', 'email'].includes(emails[0].type)) return { ok: false };
  // Same two known notices as performLoginAction, but strictly read-only: a
  // present notice is transient (the next fresh cycle dismisses it before any
  // credential handling) and is never clicked here.
  const dialogs = Array.from(document.querySelectorAll('.ui-dialog, [role="dialog"], [role="alertdialog"], [data-reveal]')).filter(visible);
  if (dialogs.length) {
    const dialog = dialogs[0];
    const found = document.querySelectorAll('#flash_messages');
    const message = found.length === 1 ? found[0] : null;
    const describedBy = dialog.getAttribute('aria-describedby');
    const controls = Array.from(dialog.querySelectorAll('button, input[type="button"], input[type="submit"], a')).filter(visible);
    const isDismissalControl = (control: Element): boolean => {
      const label = (control.tagName === 'INPUT' ? (control as HTMLInputElement).value : control.textContent)?.replace(/\s+/g, ' ').trim();
      if (label !== 'OK') return false;
      if (control.tagName === 'BUTTON' || control.tagName === 'INPUT') {
        const pressable = control as HTMLButtonElement | HTMLInputElement;
        const ariaDisabled = pressable.getAttribute('aria-disabled');
        if (pressable.type !== 'button' || pressable.disabled || pressable.form || pressable.hasAttribute('form') ||
            pressable.hasAttribute('formaction') || pressable.hasAttribute('formmethod') ||
            (ariaDisabled !== null && ariaDisabled.toLowerCase() !== 'false') || pressable.closest('form') || pressable.closest('a')) return false;
        if (Array.from(control.attributes).some(attribute => /^on/i.test(attribute.name))) return false;
        for (let ancestor: Element | null = control.parentElement; ancestor && ancestor !== dialog; ancestor = ancestor.parentElement) {
          if (Array.from(ancestor.attributes).some(attribute => /^on/i.test(attribute.name))) return false;
        }
      } else return false;
      return !control.hasAttribute('data-url') && !control.hasAttribute('data-href') && !control.hasAttribute('data-path') &&
        !control.hasAttribute('data-redirect') && !control.hasAttribute('data-location');
    };
    const isCloseControl = (control: Element): boolean => {
      if (control.tagName !== 'BUTTON') return false;
      const label = control.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return (control as HTMLButtonElement).type === 'button' &&
        (label === '' || /^(x|×|✕|✖)$/iu.test(label) || /^close$/i.test(label));
    };
    const messageNavigates = message !== null && (
      message.hasAttribute('button-path') || message.hasAttribute('alt_button-path') ||
      message.hasAttribute('alt_button-text') || message.hasAttribute('no_close') ||
      message.hasAttribute('data-url') || message.hasAttribute('data-href') || message.hasAttribute('data-path') ||
      message.hasAttribute('data-redirect') || message.hasAttribute('data-location') ||
      message.hasAttribute('href') || message.hasAttribute('src') || message.hasAttribute('action') ||
      ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'IFRAME'].includes(message.tagName) ||
      message.hasAttribute('contenteditable') ||
      Array.from(message.attributes).some(attribute => /^on/i.test(attribute.name)));
    const dialogHandlesClick = Array.from(dialog.attributes).some(attribute => /^on/i.test(attribute.name));
    const noticeText = message?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const knownNotice = noticeText === 'You need to sign in or sign up before continuing.' ||
      noticeText === 'Your session has expired. Please log back in to continue.';
    const recognized = dialogs.length === 1 && message !== null && dialog.contains(message) && visible(message) &&
      !messageNavigates && !dialogHandlesClick && knownNotice &&
      !message.querySelector('a, button, input, select, textarea, iframe, [contenteditable]') &&
      (describedBy === null || describedBy.trim() === '' || describedBy.trim() === 'flash_messages') &&
      controls.filter(isDismissalControl).length === 1 && controls.every(control => isDismissalControl(control) || isCloseControl(control));
    if (!recognized) return { ok: false, reason: 'manual-authentication' };
    return { ok: false, reason: 'retryable' };
  }
  if (document.querySelector('iframe[src*="captcha" i], iframe[src*="challenge" i], [data-sitekey], .cf-turnstile, #challenge-running, #cf-challenge-running, input[autocomplete="one-time-code"], input[name*="otp" i]')) return { ok: false, reason: 'manual-authentication' };
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[class*="captcha" i]'))) {
    const captchaClasses = Array.from(element.classList).filter(name => name.toLowerCase().includes('captcha'));
    const image = element.firstElementChild;
    const passiveLogo = captchaClasses.length === 1 && captchaClasses[0] === 'captcha_container' &&
      element.childElementCount === 1 && image?.tagName === 'IMG' && image.childElementCount === 0 && !element.textContent?.trim() &&
      !element.matches('[onclick], [tabindex], [role="button"], [contenteditable]') &&
      !image.matches('[onclick], [tabindex], [role="button"], [contenteditable]');
    if (!passiveLogo) return { ok: false, reason: 'manual-authentication' };
  }
  const failures = Array.from(document.querySelectorAll('.alert.alert-danger, .flash.error'));
  if (failures.length) {
    const text = failures.map(element => element.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (['invalid', 'incorrect', 'wrong'].some(word => text.includes(word)) &&
        ['email', 'password', 'login', 'credential'].some(word => text.includes(word))) {
      return { ok: false, reason: 'credential-rejected' };
    }
    return { ok: false };
  }
  if (Array.from(document.querySelectorAll('.ui-widget-overlay, .reveal-overlay')).some(visible)) return { ok: false, reason: 'manual-authentication' };
  return { ok: true };
}
