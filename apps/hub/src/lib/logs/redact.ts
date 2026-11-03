/**
 * Strip Heimdall secrets from log lines before they are evaluated, stored or
 * sent in an alert. Install commands like `sudo TOKEN=hdt_… bash` put the
 * token in sudo's journal entry (_CMDLINE), which the log pipeline would
 * otherwise keep in plain text.
 *
 * Prefixes (see lib/ids.ts): hdt agent enrollment, hda agent secret,
 * hdb bootstrap, hdo OTLP ingest, hdu UniFi webhook, hdr runtime webhook.
 * The prefix is kept so the line still shows which kind of secret it was.
 */
const HEIMDALL_SECRET = /\b(hd[tabour])_[A-Za-z0-9_-]{16,}/g;

export const REDACTED = "[REDACTED]";

export function redactSecrets(line: string): string {
  return line.replace(HEIMDALL_SECRET, `$1_${REDACTED}`);
}
