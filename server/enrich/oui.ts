import fs from 'node:fs';

/** Wireshark "manuf" lookup: MAC prefix (24/28/36 bit) -> vendor. */
export class OuiDb {
  private byPrefix = new Map<string, string>();
  private lengths = new Set<number>();
  size = 0;

  load(file: string): boolean {
    if (!fs.existsSync(file)) return false;
    const next = new Map<string, string>();
    const lengths = new Set<number>();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t').map((c) => c.trim());
      if (cols.length < 2) continue;
      const [prefix, bitsStr] = cols[0].split('/');
      const bits = bitsStr ? Number(bitsStr) : 24;
      const hex = prefix.replace(/[^0-9a-fA-F]/g, '').toLowerCase().slice(0, Math.ceil(bits / 4));
      const vendor = cols[2] || cols[1];
      if (!hex || !vendor) continue;
      next.set(hex, vendor);
      lengths.add(hex.length);
    }
    this.byPrefix = next;
    this.lengths = lengths;
    this.size = next.size;
    return true;
  }

  lookup(mac: string): string {
    const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    for (const len of [...this.lengths].sort((a, b) => b - a)) {
      const v = this.byPrefix.get(hex.slice(0, len));
      if (v) return v;
    }
    return '';
  }
}

/** Locally administered bit set -> randomized / private MAC (iOS, Android, Windows). */
export function isRandomMac(mac: string): boolean {
  const first = parseInt(mac.slice(0, 2), 16);
  return Number.isFinite(first) && (first & 0x02) !== 0;
}
