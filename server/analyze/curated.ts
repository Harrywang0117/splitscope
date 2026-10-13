import fs from 'node:fs';
import path from 'node:path';
import type { ProbeTarget } from '../../shared/types.ts';
import { config } from '../config.ts';

/**
 * Hand-assembled lists (data/curated/*.json) for services whose public rule sets are incomplete —
 * e.g. 支付宝: rule-set domains + hostnames seen on this network + gateway IPs to model HTTPDNS.
 */

export interface CuratedEntry {
  type: 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD' | 'IP' | 'IP-CIDR';
  value: string;
  from?: string[];
  note?: string;
}

export interface CuratedList {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  updated: string;
  sources: string[];
  entries: CuratedEntry[];
}

let lists: CuratedList[] | null = null;

export function curatedLists(): CuratedList[] {
  if (lists) return lists;
  const dir = path.join(config.staticDataDir, 'curated');
  lists = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CuratedList)
    : [];
  return lists;
}

export function curatedTargets(id: string, cidrSample: (c: string) => string): ProbeTarget[] {
  const list = curatedLists().find((l) => l.id === id);
  if (!list) return [];
  return list.entries.map((e): ProbeTarget => {
    const from = [`curated:${id}`, ...(e.from ?? [])];
    switch (e.type) {
      case 'DOMAIN':
        return { value: e.value, kind: 'domain', test: e.value, from, note: e.note };
      case 'DOMAIN-SUFFIX':
        return { value: e.value, kind: 'suffix', test: e.value, from, note: e.note };
      case 'DOMAIN-KEYWORD':
        return { value: e.value, kind: 'keyword', test: `${e.value}.com`, from, note: e.note };
      case 'IP':
        return { value: e.value, kind: 'ip', test: e.value, from, note: e.note };
      case 'IP-CIDR':
        return { value: e.value, kind: 'cidr', test: cidrSample(e.value), from, note: e.note };
    }
  });
}
