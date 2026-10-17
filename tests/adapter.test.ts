// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAppointmentForm, readCurrentAppointment, readDashboardGroups, readSiteMaintenance, readSummaryRaw } from '../src/adapter/reads';
import { resolveGroup, validateDashboardSnapshot } from '../src/domain/groups';

describe('website adapter readers', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('collects dashboard groups with IVRs and ignores other links', () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <section><div class="row"><div class="medium-12 columns text-right"><strong>22222222</strong></div>
      <p class="consular-appt"><a href="/en-ca/niv/schedule/11111111/appointment">Reschedule</a></p>
      <p class="consular-appt"><a href="/en-ca/niv/schedule/11111111/appointment">Reschedule again</a></p></div></section>
      <section><div class="row"><div class="medium-12 columns text-right"><strong>Notes</strong><strong>44444444</strong></div>
      <ul class="dropdown menu align-right actions"><li><a class="button primary small" href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></section>
      <p class="delivery"><a href="/other">Elsewhere</a></p>
      <a href="/en-ca/niv/schedule/22222222/appointment">Outside the scoped selectors</a>`;
    // Legacy markup without an outer application card keeps bounded identity
    // discovery, but payment evidence stays unknown: only positive outer-card
    // markers authorize unpaid.
    expect(readDashboardGroups()).toEqual({
      groups: [
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'unknown' },
        { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unknown' },
      ],
    });
  });

  it('detects a positively unpaid outer card from needs_payment plus Pay Visa Fee', () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="dropdown menu align-right actions">
          <li><a class="button primary small" href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li>
        </ul></div></div>
        <div class="card"><p class="delivery"><strong>Document Delivery Location:</strong>synthetic address
          <a href="/en-ca/niv/schedule/33333333/addresses/delivery">view map</a></p></div>
        <table><tbody><tr><td>Synthetic applicant</td></tr></tbody></table>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div>
      </div>`;
    expect(readDashboardGroups()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    });
  });

  it('classifies paid outer cards from ready_to_schedule or booked markup, never from links alone', () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card ready_to_schedule"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Schedule Appointment<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>22222222</strong></div></div></div>
      <div class="application appointment card secondary"><strong>44444444</strong>
        <ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul>
        <p class="consular-appt">September 22, 2025</p></div>`;
    expect(readDashboardGroups()).toEqual({
      groups: [
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
        { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'paid' },
      ],
    });
  });

  it.each(['needs-without-status', 'status-without-marker', 'contradictory', 'malformed-status'])(
    'marks %s outer cards unknown instead of guessing', scenario => {
      vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
      const status = scenario === 'status-without-marker' || scenario === 'malformed-status'
        ? '<h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4>'
        : scenario === 'contradictory'
          ? '<h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4>'
          : '';
      const malformed = scenario === 'malformed-status'
        ? '<h4 class="status"><small>Current Status</small><br>Pay Visa Fee Now<br></h4>'
        : status;
      const classes = scenario === 'status-without-marker' || scenario === 'malformed-status'
        ? 'alert application card'
        : scenario === 'contradictory'
          ? 'alert application card needs_payment ready_to_schedule'
          : 'alert application card needs_payment';
      document.body.innerHTML = `<div class="${classes}"><div class="row"><div class="medium-6 columns">${malformed}</div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
      expect(readDashboardGroups()).toEqual({
        groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unknown' }],
      });
    });

  it('does not borrow sibling payment markers or inner delivery-card text', () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>
      <div class="alert application card"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Schedule Appointment<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul></div></div>
        <div class="card"><p class="delivery"><strong>Pay Visa Fee</strong></p></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>22222222</strong></div></div></div>`;
    // The second card's inner delivery bold text must not confer unpaid status.
    expect(readDashboardGroups()).toEqual({
      groups: [
        { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' },
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'unknown' },
      ],
    });
  });

  it('rejects conflicting identities across outer cards', () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong><strong>55555555</strong></div></div></div>`;
    expect(() => readDashboardGroups()).toThrow('Ambiguous dashboard group.');
  });

  it('serializes dependency-free for page injection', () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    expect(serialized()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    });
  });

  it('keeps a deeply nested unpaid card as the boundary without borrowing siblings', () => {    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    const nested = (html: string) => '<div>'.repeat(6) + html + '</div>'.repeat(6);
    document.body.innerHTML = nested(`
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns">${nested('<h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4>')}</div>
        <div class="medium-6 columns text-right">${nested('<ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul>')}</div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`) +
      `<div class="alert application card ready_to_schedule"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Schedule Appointment<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>22222222</strong></div></div></div>`;
    expect(readDashboardGroups()).toEqual({
      groups: [
        { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' },
        { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
      ],
    });
  });

  it('rejects dashboard query and fragment before reading, via the serialized reader', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    for (const href of [
      'https://ais.usvisa-info.com/en-ca/niv/groups?account=1',
      'https://ais.usvisa-info.com/en-ca/niv/groups#summary',
      'https://ais.usvisa-info.com/en-ca/niv/groups/55555555?account=1',
      'https://ais.usvisa-info.com/en-ca/niv/groups/55555555#summary',
    ]) {
      vi.stubGlobal('location', { href });
      expect(() => serialized()).toThrow('Dashboard context changed.');
    }
  });

  it('refuses query/fragment-bearing candidate targets instead of authorizing unpaid', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    for (const href of [
      '/en-ca/niv/schedule/33333333/continue_actions?account=1',
      '/en-ca/niv/schedule/33333333/continue_actions#summary',
    ]) {
      document.body.innerHTML = `
        <div class="alert application card needs_payment"><div class="row">
          <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
          <div class="medium-6 columns text-right"><ul class="actions"><li><a href="${href}">Continue</a></li></ul></div></div>
          <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
      // The tainted link authorizes nothing; the uncovered card fails closed
      // as an incomplete group rather than implying absence.
      const reading = serialized();
      expect(reading).toEqual({ groups: [{ scheduleId: '', ivr: null, paymentStatus: 'unknown' }] });
      expect(() => validateDashboardSnapshot(reading)).toThrow('Invalid dashboard group.');
    }
  });

  it('ignores query-bearing inner links in outer identity scanning', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="card"><p class="delivery"><a href="/en-ca/niv/schedule/99999999/addresses/delivery?account=1">view map</a></p></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    expect(serialized()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    });
  });

  it('deduplicates repeated links inside one outer card', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions">
          <li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li>
          <li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue again</a></li>
        </ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    expect(serialized()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    });
  });

  it.each(['identical', 'differing'])('rejects duplicated outer cards with %s status', variant => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    const second = variant === 'identical'
      ? '<div class="alert application card needs_payment"><div class="row"><div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div><div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div><div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>'
      : '<div class="alert application card ready_to_schedule"><div class="row"><div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Schedule Appointment<br></h4></div><div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div><div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>';
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>
      ${second}`;
    // The same schedule on two distinct cards rejects even with identical
    // IVR/status instead of silently merging into a valid unpaid group.
    expect(() => serialized()).toThrow('Ambiguous dashboard group.');
  });

  it('does not authorize unpaid from an inner delivery-card status', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="card"><h4 class="status">Pay Visa Fee</h4></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    expect(serialized()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unknown' }],
    });
  });

  it('does not confer paid from inner delivery-card or applicant-table markers', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card"><div class="row">
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="card"><div class="ready_to_schedule">Schedule Appointment</div></div>
        <table><tbody><tr><td><p class="consular-appt">January 1, 2027</p></td></tr></tbody></table>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    expect(serialized()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unknown' }],
    });
  });

  it('does not lend evidence across nested application cards', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="application card"><h4 class="status">Pay Visa Fee</h4></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    // The nested card's status cannot authorize the outer card, and the
    // link-less nested card fails closed as an incomplete group.
    const reading = serialized();
    expect(reading).toEqual({ groups: [
      { scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unknown' },
      { scheduleId: '', ivr: null, paymentStatus: 'unknown' },
    ] });
    expect(() => validateDashboardSnapshot(reading)).toThrow('Invalid dashboard group.');
  });

  it('keeps the genuine IVR when inner-card and table decoys are numeric', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="card"><p class="delivery"><strong>99999999</strong></p></div>
        <table><tbody><tr><td>Synthetic applicant <strong>88888888</strong></td></tr></tbody></table>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    expect(serialized()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unpaid' }],
    });
  });

  it('returns a null IVR when only decoys exist, failing worker validation', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="card"><p class="delivery"><strong>99999999</strong></p></div>
        <table><tbody><tr><td>Synthetic applicant <strong>88888888</strong></td></tr></tbody></table></div>`;
    const reading = serialized();
    expect(reading).toEqual({
      groups: [{ scheduleId: '33333333', ivr: null, paymentStatus: 'unpaid' }],
    });
    expect(() => validateDashboardSnapshot(reading)).toThrow('Invalid dashboard group.');
  });

  it.each([
    ['missing status', ''],
    ['wrong status', '<h4 class="status"><small>Current Status</small><br>Schedule Appointment<br></h4>'],
    ['malformed status', '<h4 class="status"><small>Current Status</small><br>Pay Visa Fee Now<br></h4>'],
  ])('treats contradictory markers as unknown even with %s', (_label, status) => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card needs_payment ready_to_schedule"><div class="row">
        <div class="medium-6 columns">${status}</div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    expect(serialized()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unknown' }],
    });
  });

  it.each([
    ['outer marker', '<div class="alert application card ready_to_schedule">', ''],
    ['descendant marker', '<div class="alert application card">', '<div><div class="ready_to_schedule">Schedule Appointment</div></div>'],
  ])('treats bare Pay Visa Fee with paid markers as unknown (%s)', (_label, opening, marker) => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      ${opening}<div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Pay Visa Fee<br></h4>${marker}</div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/33333333/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>44444444</strong></div></div></div>`;
    expect(serialized()).toEqual({
      groups: [{ scheduleId: '33333333', ivr: '44444444', paymentStatus: 'unknown' }],
    });
  });

  it('fails closed when an incomplete outer card sits beside a valid paid group', () => {
    const serialized: typeof readDashboardGroups = new Function(`return (${readDashboardGroups.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `
      <div class="alert application card ready_to_schedule"><div class="row">
        <div class="medium-6 columns"><h4 class="status"><small>Current Status</small><br>Schedule Appointment<br></h4></div>
        <div class="medium-6 columns text-right"><ul class="actions"><li><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></li></ul></div></div>
        <div class="row"><div class="medium-12 columns text-right">IVR Account Number:<strong>22222222</strong></div></div></div>
      <div class="alert application card"><div class="row"><div class="medium-6 columns"><h4 class="status">Unreadable</h4></div></div></div>`;
    // Strict whole-dashboard validation still cannot claim all groups were
    // read, but optional-IVR selection may use the valid first booking card.
    const reading = serialized();
    expect(reading).toEqual({ groups: [
      { scheduleId: '11111111', ivr: '22222222', paymentStatus: 'paid' },
      { scheduleId: '', ivr: null, paymentStatus: 'unknown' },
    ] });
    expect(() => validateDashboardSnapshot(reading)).toThrow('Invalid dashboard group.');
    expect(resolveGroup(reading, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toEqual({ scheduleId: '11111111', ivr: '22222222' });
    const first = document.querySelector('.application.card')!;
    first.before(first.nextElementSibling!);
    const reordered = serialized();
    expect(reordered.groups[0]).toEqual({ scheduleId: '', ivr: null, paymentStatus: 'unknown' });
    expect(() => resolveGroup(reordered, { mode: 'booking', paidIvr: '', unpaidIvr: '' }))
      .toThrow('Selected dashboard group is incomplete.');
  });

  it('reads the heading-scoped summary rows as raw text', () => {
    document.body.innerHTML = `
      <section><h2>MRV Fee Details</h2><table><tr><td>Fee</td><td>Paid</td></tr></table></section>
      <section><h2>First Available Appointments</h2><table>
        <tr><td>Vancouver</td><td>November 19, 2026</td></tr>
        <tr><td>Toronto</td><td>No Appointments Available</td></tr>
      </table></section>`;
    expect(readSummaryRaw()).toEqual({
      headingFound: true,
      rows: [
        { city: 'Vancouver', text: 'November 19, 2026' },
        { city: 'Toronto', text: 'No Appointments Available' },
      ],
    });
  });

  it('reports a missing summary heading instead of guessing', () => {
    document.body.innerHTML = '<h2>Something Else</h2>';
    expect(readSummaryRaw()).toEqual({ headingFound: false, rows: [] });
  });

  it('flags a site maintenance page without mistaking other pages for it', () => {
    document.body.innerHTML = '<h2>Something Else</h2><p>The nonimmigrant visa section is currently under maintenance. We appreciate your patience.</p>';
    expect(readSummaryRaw()).toEqual({ headingFound: false, rows: [], maintenance: true });
    document.body.innerHTML = '<h2>Something Else</h2><p>Please try again later.</p>';
    expect(readSummaryRaw()).toEqual({ headingFound: false, rows: [] });
  });

  it('flags the structural maintenance document from its heading and container', () => {
    document.body.innerHTML = `<div class="grid-y grid-frame construction-background"><div class="cell large-4 medium-5"><div class="grid-container">
      <div class="cell medium-7 text-center medium-text-left"><h1>Doing Maintenance</h1><h2>No need to worry.</h2>
      <h3 class="h5">Our website is down for planned maintenance. We should be back up momentarily. Check back soon.</h3></div></div></div></div>`;
    expect(readSummaryRaw()).toEqual({ headingFound: false, rows: [], maintenance: true });
    expect(readSiteMaintenance()).toEqual({ maintenance: true });
  });

  it('detects maintenance on any page but ignores ordinary mentions', () => {
    document.body.innerHTML = '<h1>Doing Maintenance</h1>';
    expect(readSiteMaintenance()).toEqual({ maintenance: true });
    document.body.innerHTML = '<div class="construction-background"></div>';
    expect(readSiteMaintenance()).toEqual({ maintenance: true });
    document.body.innerHTML = '<p>Scheduled maintenance is planned for Sunday.</p>';
    expect(readSiteMaintenance()).toEqual({ maintenance: true });
    document.body.innerHTML = '<h1>Dashboard</h1><p>All systems normal.</p>';
    expect(readSiteMaintenance()).toEqual({ maintenance: false });
  });

  it('reads the appointment form state without acting on it', () => {
    document.body.innerHTML = `
      <select id="appointments_consulate_appointment_facility_id"><option value="95">Vancouver</option></select>
      <input id="appointments_consulate_appointment_date" value="2026-11-19">
      <select id="appointments_consulate_appointment_time"><option value="09:15">9:15 AM</option></select>`;
    const form = readAppointmentForm();
    expect(form.facilityId).toBe(95);
    expect(form.date).toBe('2026-11-19');
    expect(form.time).toBe('09:15');
  });

  it('reads only the selected schedule and IVR instead of the first appointment', async () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = `<section><strong>44444444</strong><p class="consular-appt">November 1, 2026 <a href="/en-ca/niv/schedule/33333333/appointment">Reschedule</a></p></section>
      <section><strong>22222222</strong><p class="consular-appt">October 13, 2026 <a href="/en-ca/niv/schedule/11111111/appointment">Reschedule</a></p></section>`;
    const serialized = new Function(`return (${readCurrentAppointment.toString()})`)();
    expect(await serialized('11111111', '22222222')).toMatchObject({ kind: 'booked', text: 'October 13, 2026 Reschedule' });
    await expect(readCurrentAppointment('11111111', '44444444')).rejects.toThrow();
  });

  it('requires an explicit ready-to-schedule marker for an unbooked baseline', async () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    document.body.innerHTML = '<section><strong>22222222</strong><div class="ready_to_schedule"><a href="/en-ca/niv/schedule/11111111/continue_actions">Continue</a></div></section>';
    expect(await readCurrentAppointment('11111111', '22222222')).toMatchObject({ kind: 'unbooked', text: null });
    document.querySelector('div')!.className = '';
    await expect(readCurrentAppointment('11111111', '22222222')).rejects.toThrow();
  });

  it.each(['duplicate', 'shared', 'offsite', 'wrong-route'])('refuses ambiguous or untrusted appointment reads (%s)', async scenario => {
    vi.stubGlobal('location', { href: scenario === 'wrong-route' ? 'https://example.invalid/en-ca/niv/groups' : 'https://ais.usvisa-info.com/en-ca/niv/groups' });
    const entry = `<section><strong>22222222</strong><p class="consular-appt">October 13, 2026 <a href="${scenario === 'offsite' ? 'https://example.invalid' : ''}/en-ca/niv/schedule/11111111/appointment">Reschedule</a></p></section>`;
    document.body.innerHTML = scenario === 'duplicate' ? entry + entry : scenario === 'shared' ? `<section><strong>22222222</strong><strong>44444444</strong>${entry.replace(/<\/?section>/g, '')}</section>` : entry;
    await expect(readCurrentAppointment('11111111', '22222222')).rejects.toThrow();
  });

  it.each([0, 401, 403, 503])('returns an explicit opt-in polling transport failure for status %s after serialization', async status => {
    const serialized: typeof readCurrentAppointment = new Function(`return (${readCurrentAppointment.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' });
    vi.stubGlobal('fetch', status === 0 ? vi.fn().mockRejectedValue(new Error('synthetic network failure'))
      : vi.fn().mockResolvedValue({ status }));
    await expect(serialized('11111111', '22222222', true, true, '/en-ca/niv/groups/99999999', true))
      .resolves.toEqual({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status });
    // Existing non-polling callers still refuse rather than interpreting a
    // transport failure as a baseline, roster, or verification outcome.
    await expect(serialized('11111111', '22222222', true, true, '/en-ca/niv/groups/99999999')).rejects.toThrow();
  });

  it('types an expired-session redirect as a denied flag without following it', async () => {
    const serialized: typeof readCurrentAppointment = new Function(`return (${readCurrentAppointment.toString()})`)();
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    const fetchMock = vi.fn(async () => ({ status: 0, type: 'opaqueredirect', text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(serialized('11111111', '22222222', true, true, '/en-ca/niv/groups/55555555', true))
      .resolves.toEqual({ scheduleId: '11111111', ivr: '22222222', kind: 'read-failure', text: null, status: 0, redirected: true });
    expect(fetchMock).toHaveBeenCalledWith('https://ais.usvisa-info.com/en-ca/niv/groups/55555555',
      expect.objectContaining({ redirect: 'manual', credentials: 'same-origin', cache: 'no-store' }));
    // Without the opt-in flag the redirect still refuses rather than binding.
    await expect(serialized('11111111', '22222222', true, true, '/en-ca/niv/groups/55555555')).rejects.toThrow('Dashboard read failed.');
  });

  it('never converts changed context or malformed successful dashboard markup into transport permission', async () => {
    const serialized: typeof readCurrentAppointment = new Function(`return (${readCurrentAppointment.toString()})`)();
    const location = { href: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' };
    vi.stubGlobal('location', location);
    vi.stubGlobal('fetch', vi.fn(async () => {
      location.href = 'https://ais.usvisa-info.com/en-ca/niv/schedule/33333333/appointment';
      throw new Error('synthetic network failure');
    }));
    await expect(serialized('11111111', '22222222', true, true, '/en-ca/niv/groups/99999999', true)).rejects.toThrow('Appointment context changed.');
    location.href = 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, text: async () => '<p>Unknown dashboard</p>' }));
    await expect(serialized('11111111', '22222222', true, true, '/en-ca/niv/groups/99999999', true)).rejects.toThrow('Ambiguous appointment group.');
  });

  it('fetches a fresh bounded dashboard document without navigating the booking tab', async () => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' });
    const fetchMock = vi.fn(async () => ({ status: 200, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555',
      text: async () => '<section><strong>22222222</strong><p class="consular-appt">October 13, 2026 <a href="/en-ca/niv/schedule/11111111/appointment">Reschedule</a></p></section>' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await readCurrentAppointment('11111111', '22222222', true)).toMatchObject({ kind: 'booked' });
    expect(fetchMock).toHaveBeenCalledWith('https://ais.usvisa-info.com/en-ca/niv/', expect.objectContaining({ credentials: 'same-origin', redirect: 'follow', cache: 'no-store', signal: expect.any(AbortSignal) }));
    fetchMock.mockResolvedValue({ status: 200, url: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555', text: async () => '<form>Login required</form>' });
    await expect(readCurrentAppointment('11111111', '22222222', true)).rejects.toThrow();
  });
  it.each(['https://example.invalid/en-ca/niv/groups', 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in', 'https://ais.usvisa-info.com/en-ca/niv/'])('rejects a non-dashboard landing after the entry redirect (%s)', async finalUrl => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/schedule/11111111/appointment' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, url: finalUrl,
      text: async () => '<section><strong>22222222</strong><p class="consular-appt">October 13, 2026 <a href="/en-ca/niv/schedule/11111111/appointment">Reschedule</a></p></section>' })));
    await expect(readCurrentAppointment('11111111', '22222222', true)).rejects.toThrow('Dashboard read failed.');
  });
  it.each(['dashboard', 'appointment'])('fetches the validated account dashboard directly without following redirects (%s)', async route => {
    const dashboardPath = '/en-ca/niv/groups/55555555';
    vi.stubGlobal('location', { href: `https://ais.usvisa-info.com${route === 'dashboard' ? dashboardPath : '/en-ca/niv/schedule/11111111/appointment'}` });
    const fetchMock = vi.fn(async (url: string) => {
      if (url !== `https://ais.usvisa-info.com${dashboardPath}`) throw new Error('Synthetic generic dashboard redirects');
      return { status: 200, text: async () => '<section><strong>22222222</strong><p class="consular-appt">6 November, 2026 <a href="/en-ca/niv/schedule/11111111/appointment">Reschedule</a></p></section>' };
    });
    vi.stubGlobal('fetch', fetchMock);
    const serialized: typeof readCurrentAppointment = new Function(`return (${readCurrentAppointment.toString()})`)();
    const reading = await serialized('11111111', '22222222', true, false, route === 'appointment' ? dashboardPath : undefined);
    expect(reading).toMatchObject({ kind: 'booked', text: '6 November, 2026 Reschedule' });
    expect(fetchMock).toHaveBeenCalledWith(`https://ais.usvisa-info.com${dashboardPath}`, expect.objectContaining({ redirect: 'manual', credentials: 'same-origin', cache: 'no-store' }));
  });
  it.each(['https://example.invalid/en-ca/niv/groups', '//example.invalid/en-ca/niv/groups', '/en-ca/niv/groups/55555555?account=other', '/en-ca/niv/groups/55555555#other', '/en-ca/niv/groups/../users/sign_in', '/en-ca/niv/groups/66666666'])('rejects arbitrary or changed dashboard targets before fetching (%s)', async dashboardPath => {
    vi.stubGlobal('location', { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(readCurrentAppointment('11111111', '22222222', true, false, dashboardPath)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects a dashboard account change while the fresh read is in flight', async () => {
    const liveLocation = { href: 'https://ais.usvisa-info.com/en-ca/niv/groups/55555555' };
    vi.stubGlobal('location', liveLocation);
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, text: async () => {
      liveLocation.href = 'https://ais.usvisa-info.com/en-ca/niv/groups/66666666';
      return '<section><strong>22222222</strong><p class="consular-appt">6 November, 2026 <a href="/en-ca/niv/schedule/11111111/appointment">Reschedule</a></p></section>';
    } })));
    await expect(readCurrentAppointment('11111111', '22222222', true)).rejects.toThrow('Appointment context changed.');
  });
});
