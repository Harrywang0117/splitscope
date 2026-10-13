import { useEffect, useState } from 'react';
import type { ProbeTarget } from '../../../shared/types.ts';

/**
 * Test basket: targets collected anywhere in the site (checkup, live rows, history tables) to be
 * probed together in 分流测试. An item may carry the group it is expected to go to, which pre-fills
 * the adjustment plan once the probe results are in. Kept in localStorage (per browser).
 */

export interface BasketItem extends ProbeTarget {
  expect?: string;
}

const KEY = 'splitscope-basket';
const EVT = 'splitscope-basket';

function read(): BasketItem[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as BasketItem[];
  } catch {
    return [];
  }
}

function write(items: BasketItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, 2000)));
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new Event(EVT));
}

export const keyOf = (t: Pick<ProbeTarget, 'kind' | 'value'>) => `${t.kind}|${t.value.toLowerCase()}`;

export const basket = {
  get: read,
  add(items: BasketItem[]) {
    const cur = read();
    const seen = new Map(cur.map((i) => [keyOf(i), i]));
    let added = 0;
    for (const it of items) {
      const k = keyOf(it);
      const prev = seen.get(k);
      if (prev) {
        if (it.expect) prev.expect = it.expect;
      } else {
        seen.set(k, it);
        added++;
      }
    }
    write([...seen.values()]);
    return added;
  },
  remove(k: string) {
    write(read().filter((i) => keyOf(i) !== k));
  },
  clear() {
    write([]);
  },
};

export function useBasket(): BasketItem[] {
  const [items, setItems] = useState(read);
  useEffect(() => {
    const on = () => setItems(read());
    window.addEventListener(EVT, on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener(EVT, on);
      window.removeEventListener('storage', on);
    };
  }, []);
  return items;
}

/** A hostname / IP as a probe target. */
export function targetOf(host: string, from: string, expect?: string, note?: string): BasketItem {
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return { value: host, kind: isIp ? 'ip' : 'domain', test: host, from: [from], expect: expect || undefined, note };
}
