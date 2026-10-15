import { describe, expect, it } from 'vitest';
import { isSameGroupUrl, parseTrustedUrl } from '../src/domain/trust';

describe('same-group URL trust', () => {
  it('parses trusted group-bound pages with query strings preserved', () => {
    const parsed = parseTrustedUrl('https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment?confirmed_limit_message=1&commit=Continue');
    expect(parsed.route).toBe('appointment');
    expect(parsed.scheduleId).toBe('12345');
    expect(parsed.href).toContain('confirmed_limit_message=1');
    expect(parseTrustedUrl('https://ais.usvisa-info.com/en-ca/niv/groups/12345')).toMatchObject({
      route: 'dashboard',
      scheduleId: '12345',
    });
    expect(parseTrustedUrl('https://ais.usvisa-info.com/en-ca/niv/schedule/12345/continue_actions')).toMatchObject({
      route: 'actions',
      scheduleId: '12345',
    });
    expect(parseTrustedUrl('https://ais.usvisa-info.com/en-ca/niv/groups')).toMatchObject({
      route: 'dashboard',
      scheduleId: null,
    });
    expect(parseTrustedUrl('https://ais.usvisa-info.com/en-ca/niv/')).toMatchObject({
      route: 'landing',
      scheduleId: null,
    });
  });

  it('rejects off-origin, credentialed, and unknown routes', () => {
    for (const bad of [
      'https://ais.usvisa-info.com.evil.invalid/en-ca/niv/groups',
      'http://ais.usvisa-info.com/en-ca/niv/groups',
      'https://user:secret@ais.usvisa-info.com/en-ca/niv/groups',
      'https://ais.usvisa-info.com:8443/en-ca/niv/groups',
      'https://ais.usvisa-info.com/en-ca/niv/schedule/12345/unknown',
      'not a url',
    ])
      expect(() => parseTrustedUrl(bad)).toThrow('Untrusted URL.');
  });

  it('restores only saved same-group URLs and never throws on doubt', () => {
    expect(isSameGroupUrl('https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment', '12345')).toBe(true);
    expect(isSameGroupUrl('https://ais.usvisa-info.com/en-ca/niv/schedule/99999/appointment', '12345')).toBe(false);
    expect(isSameGroupUrl('https://ais.usvisa-info.com/en-ca/niv/groups', '12345')).toBe(true);
    expect(isSameGroupUrl('https://ais.usvisa-info.com/en-ca/niv/', '12345')).toBe(true);
    expect(isSameGroupUrl('https://ais.usvisa-info.com/en-ca/niv/users/sign_in', '12345')).toBe(true);
    expect(isSameGroupUrl('https://evil.invalid/', '12345')).toBe(false);
    expect(isSameGroupUrl('https://ais.usvisa-info.com/en-ca/niv/schedule/12345/appointment', '')).toBe(false);
  });
});
