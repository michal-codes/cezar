import { describe, expect, it } from 'vitest';
import { printCockpitQr, qrLines, qrTargetUrl } from './qr.ts';

describe('terminal QR for the cockpit address', () => {
  it('renders a square block string with a quiet zone', () => {
    const lines = qrLines('http://host.ts.net:8445/');
    expect(lines.length).toBeGreaterThan(8);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines.join('\n')).toMatch(/[█▀▄]/);
  });

  it('prefers CEZ_PUBLIC_URL, then a non-loopback bind, and nothing for loopback', () => {
    expect(
      qrTargetUrl({ publicUrl: 'https://host.ts.net:8445/', bindHost: '127.0.0.1', port: 4321 }),
    ).toBe('https://host.ts.net:8445/');
    expect(qrTargetUrl({ bindHost: '100.95.163.12', port: 4321 })).toBe('http://100.95.163.12:4321');
    expect(qrTargetUrl({ bindHost: '127.0.0.1', port: 4321 })).toBeNull();
    expect(qrTargetUrl({ port: 4321 })).toBeNull();
  });

  it('prints only on a TTY and honours CEZ_NO_QR / CI', () => {
    const lines: string[] = [];
    const base = { publicUrl: 'https://host.ts.net:8445/', port: 4321, log: (line: string) => lines.push(line) };
    expect(printCockpitQr({ ...base, tty: true, env: {} })).toBe('https://host.ts.net:8445/');
    expect(lines.length).toBeGreaterThan(10);
    lines.length = 0;
    expect(printCockpitQr({ ...base, tty: false, env: {} })).toBeNull();
    expect(printCockpitQr({ ...base, tty: true, env: { CEZ_NO_QR: '1' } })).toBeNull();
    expect(printCockpitQr({ ...base, tty: true, env: { CI: 'true' } })).toBeNull();
    expect(lines.length).toBe(0);
  });
});
