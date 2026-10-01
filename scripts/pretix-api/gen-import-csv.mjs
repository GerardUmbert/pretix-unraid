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

const first = [
  // Catalan
  'Anna', 'Pau', 'Marta', 'Jordi', 'Laia', 'Marc', 'Núria', 'Oriol', 'Carla', 'Arnau', 'Julia', 'Iker', 'Aina', 'Bruno', 'Pol', 'Aleix', 'Nil', 'Biel', 'Jan', 'Martina', 'Ariadna', 'Berta', 'Clara', 'Emma', 'Joana', 'Ona', 'Cesc', 'Guillem', 'Joan', 'Lluc', 'Pep', 'Quim', 'Roc', 'Blanca', 'Xavier', 'Miquel', 'Sira', 'Neus',
  // English (UK)
  'Arthur', 'George', 'Harry', 'Oscar', 'Archie', 'Jack', 'Amelia', 'Isla', 'Ivy', 'Freya', 'Florence', 'Willow', 'Alfie', 'Charlie', 'Poppy', 'Daisy', 'Ruby', 'Sienna', 'Oliver', 'Leo', 'Mia', 'Lily', 'Evie', 'Rosie', 'Grace', 'Jacob', 'Thomas', 'Max', 'Millie', 'Alice',
  // American (US)
  'Liam', 'Noah', 'Oliver', 'Elijah', 'James', 'William', 'Benjamin', 'Lucas', 'Henry', 'Theodore', 'Emma', 'Olivia', 'Charlotte', 'Ava', 'Sophia', 'Isabella', 'Mia', 'Evelyn', 'Harper', 'Mason', 'Michael', 'Alexander', 'Ethan', 'Daniel', 'Matthew', 'Abigail', 'Emily', 'Elizabeth', 'Avery', 'Sofia',
  // Dutch
  'Sem', 'Milan', 'Daan', 'Jayden', 'Tim', 'Levi', 'Thomas', 'Thijs', 'Jesse', 'Sophie', 'Tess', 'Fenna', 'Mila', 'Sara', 'Lotte', 'Zoë', 'Eva', 'Lieke', 'Maud', 'Roos', 'Luuk', 'Bram', 'Finn', 'Mees', 'Max', 'Julia', 'Anna', 'Isa', 'Noor', 'Saar',
  // French
  'Gabriel', 'Léo', 'Raphaël', 'Maël', 'Louis', 'Arthur', 'Jules', 'Lucas', 'Adam', 'Hugo', 'Jade', 'Louise', 'Ambre', 'Alba', 'Emma', 'Rose', 'Alice', 'Romy', 'Anna', 'Lina',
  // German
  'Maximilian', 'Alexander', 'Paul', 'Leon', 'Elias', 'Ben', 'Noah', 'Jonas', 'Luis', 'Felix', 'Mia', 'Emilia', 'Emma', 'Sofia', 'Hannah', 'Lina', 'Mila', 'Ella', 'Klara', 'Marie',
  // Italian
  'Leonardo', 'Francesco', 'Alessandro', 'Lorenzo', 'Mattia', 'Tommaso', 'Gabriele', 'Andrea', 'Riccardo', 'Edoardo', 'Sofia', 'Aurora', 'Giulia', 'Ginevra', 'Beatrice', 'Alice', 'Vittoria', 'Emma', 'Ludovica', 'Matilde',
  // Spanish
  'Hugo', 'Mateo', 'Martín', 'Lucas', 'Leo', 'Daniel', 'Alejandro', 'Manuel', 'Pablo', 'Álvaro', 'Lucía', 'Martina', 'Sofía', 'María', 'Valeria', 'Julia', 'Paula', 'Emma', 'Daniela', 'Carla',
];

const last = [
  // Catalan
  'Garcia', 'Martí', 'Soler', 'Ferrer', 'Roca', 'Puig', 'Vidal', 'Roig', 'Mas', 'Prat', 'Cortés', 'Solà', 'Vila', 'Serra', 'Camps', 'Costa', 'Font', 'Garriga', 'Pujol', 'Domènech', 'Navarro', 'Piqué', 'Riera', 'Sabater', 'Tarragó', 'Dalmau', 'Fàbregas', 'Casals', 'Miret', 'Oller', 'Ribas', 'Valls', 'Claramunt',
  // English (UK)
  'Jones', 'Taylor', 'Davies', 'Robinson', 'Wright', 'Thompson', 'Evans', 'Walker', 'White', 'Roberts', 'Green', 'Hall', 'Wood', 'Clarke', 'Hughes', 'Edwards', 'Hill', 'Moore', 'Clark', 'Harrison', 'Lewis', 'Ward', 'Baker', 'Allen', 'King', 'Turner', 'Scott', 'Cooper', 'Morris', 'Watson',
  // American (US)
  'Smith', 'Johnson', 'Williams', 'Brown', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Jackson', 'Martin', 'Lee', 'Perez', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright',
  // Dutch
  'de Jong', 'Jansen', 'de Vries', 'van den Berg', 'van Dijk', 'Bakker', 'Janssen', 'Visser', 'Smit', 'Meijer', 'de Boer', 'Mulder', 'de Groot', 'Bos', 'Vos', 'Peters', 'Hendriks', 'van Leeuwen', 'Dekker', 'Brouwer', 'Smits', 'de Wit', 'van Vliet', 'van der Meer', 'Veenstra', 'Hoekstra', 'Maas', 'Ruiter', 'Kramer', 'Scholten',
  // French
  'Martin', 'Bernard', 'Thomas', 'Petit', 'Robert', 'Richard', 'Durand', 'Dubois', 'Moreau', 'Laurent', 'Simon', 'Michel', 'Lefebvre', 'Leroy', 'Roux', 'David', 'Bertrand', 'Morel', 'Fournier', 'Girard',
  // German
  'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Braun', 'Werner',
  // Italian
  'Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'De Luca', 'Mancini', 'Costa', 'Giordano', 'Rizzo', 'Lombardi', 'Moretti',
  // Spanish
  'García', 'González', 'Rodríguez', 'Fernández', 'López', 'Martínez', 'Sánchez', 'Pérez', 'Gómez', 'Martín', 'Jiménez', 'Ruiz', 'Hernández', 'Díaz', 'Moreno', 'Muñoz', 'Álvarez', 'Romero', 'Alonso', 'Gutiérrez',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Every attendee gets a distinct name so "search tickets for this person"
// finds one holder, like real data. The pool is every first x last pair
// (shuffled); only if --rows exceeds it do names repeat, with a number added.
const pool = [...new Set(first)].flatMap((f) => [...new Set(last)].map((l) => `${f} ${l}`));
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const nameFor = (i) => (i < pool.length ? pool[i] : `${pool[i % pool.length]} ${Math.floor(i / pool.length) + 1}`);
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
    const name = nameFor(n - 1);
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
