#!/usr/bin/env node
// Generates a CSV for pretix's built-in order importer
// (control panel: event -> Orders -> Import orders) to load-test the instance.
//
//   node scripts/pretix-api/gen-import-csv.mjs [--rows 30000] [--max-per-order 4] \
//        [--items 1,2] [--out scripts/pretix-api/import-30000.csv]
//
// --rows           total tickets (CSV lines). Default 30000.
// --max-per-order  each order gets 1..N consecutive lines sharing a `grouping`
//                  value. 1 = one ticket per order. Default 4.
// --prefix        ticket-code prefix; use a new one per import since codes must be unique. Default STRESS.
// --items          product ids to pick from at random (ids from the event's
//                  product list). Must be products that need no seat and have
//                  no variations, with enough quota for all rows.
//
// Upload it in the importer with: Import mode = "Group multiple lines together
// into one order" (or "Create one order per line" if --max-per-order 1), and
// map the columns by name. Columns:
//   grouping, email, item, price, attendee_name (-> Attendee name: Full name),
//   attendee_email, secret (-> Ticket code), comment.
// The generated data is clearly fake (@example.test) and ticket codes are
// unique (prefix STRESS-), so the file can be imported only once per event.

import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);

const rows = Number(args.rows ?? 30000);
const maxPerOrder = Number(args['max-per-order'] ?? 4);
const items = String(args.items ?? '1').split(',').map((s) => s.trim());
const prefix = args.prefix ?? 'STRESS';
const out = args.out ?? `scripts/pretix-api/import-${rows}.csv`;

const first = ['Anna', 'Pau', 'Marta', 'Jordi', 'Laia', 'Marc', 'Núria', 'Oriol', 'Carla', 'Arnau', 'Julia', 'Iker', 'Aina', 'Bruno'];
const last = ['Garcia', 'Martí', 'Soler', 'Ferrer', 'Roca', 'Puig', 'Vidal', 'Roig', 'Mas', 'Prat', 'Cortés', 'Solà'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const esc = (v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

const lines = ['grouping,email,item,price,attendee_name,attendee_email,secret,comment'];
let order = 0;
let n = 0;
while (n < rows) {
  order++;
  const size = Math.min(1 + Math.floor(Math.random() * maxPerOrder), rows - n);
  const buyer = `stress.buyer${order}@example.test`;
  for (let i = 0; i < size; i++) {
    n++;
    const name = `${pick(first)} ${pick(last)}`;
    lines.push([
      `G${order}`,
      buyer,
      pick(items),
      '', // blank = calculate from product
      name,
      `stress.attendee${n}@example.test`,
      `${prefix}-${String(n).padStart(7, '0')}`,
      'stress test',
    ].map(esc).join(','));
  }
}

writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${rows} tickets in ${order} orders to ${out}`);
