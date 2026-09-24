import qrcode from 'qrcode-generator';

/**
 * Renders `text` as a QR code a human can scan straight off the terminal, two
 * module rows per text line (upper half block / lower half block / full block),
 * with a two-module quiet zone. No dependency beyond the encoder: the caller
 * prints the returned lines.
 */
export function qrLines(text: string): string[] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2;
  const size = count + quiet * 2;
  const dark = (row: number, col: number): boolean =>
    row >= quiet &&
    col >= quiet &&
    row < quiet + count &&
    col < quiet + count &&
    qr.isDark(row - quiet, col - quiet);
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = '';
    for (let col = 0; col < size; col += 1) {
      const top = dark(row, col);
      const bottom = row + 1 < size ? dark(row + 1, col) : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Which URL the startup banner should turn into a QR code, if any.
 *
 * `CEZ_PUBLIC_URL` wins when set (the operator knows the address the phone
 * should use — a tailnet name, a proxy URL); otherwise a non-loopback
 * `--bind-host` is addressable on its own. A loopback cockpit gets no QR: the
 * local browser is already one click away.
 */
export function qrTargetUrl(opts: {
  publicUrl?: string | undefined;
  bindHost?: string | undefined;
  port: number;
}): string | null {
  const publicUrl = opts.publicUrl?.trim();
  if (publicUrl) return publicUrl;
  const bind = opts.bindHost?.trim();
  if (!bind) return null;
  if (bind === 'localhost' || bind === '::1' || bind === '[::1]' || /^127\./.test(bind)) return null;
  return `http://${bind}:${opts.port}`;
}

/**
 * Prints the QR (and its URL) when a target exists and the operator has not
 * silenced it (`CEZ_NO_QR=1`, or any CI). A TTY is required only when the
 * target was inferred from `--bind-host`: an explicitly set `CEZ_PUBLIC_URL`
 * is an instruction to show it, so the QR also lands in a captured log or a
 * `--no-open` run. Returns the target it printed, or `null`.
 */
export function printCockpitQr(opts: {
  publicUrl?: string | undefined;
  bindHost?: string | undefined;
  port: number;
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  log?: (line: string) => void;
}): string | null {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const target = qrTargetUrl(opts);
  if (!target) return null;
  const explicit = Boolean(opts.publicUrl?.trim());
  if (!explicit && !opts.tty) return null;
  if (env.CEZ_NO_QR === '1' || env.CI) return null;
  log('');
  log(`  phone → ${target}`);
  for (const line of qrLines(target)) log(`  ${line}`);
  log('');
  return target;
}
