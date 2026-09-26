import { buildMeta } from './src/index.js';
const fails = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };

let m = buildMeta({ owner: { display_name: 'Pyper', handle: 'pyper' },
  list: { category: 'Board, Card, & Dice Games',
          items: ['Toy Battle', 'Monopoly Deal', 'Cover your assets', '10s'] } });
ok(m.title === 'Pyper’s Top 10 Board, Card, & Dice Games', `title (${m.title})`);
ok(/^Toy Battle, Monopoly Deal, Cover your assets, and more/.test(m.description),
  `description leads with the picks (${m.description})`);

m = buildMeta({ owner: { display_name: 'Chris Davies' }, list: { category: 'Movies', items: ['Dune'] } });
ok(m.title === 'Chris Davies’ Top 10 Movies', `name ending in s (${m.title})`);
ok(!/and more/.test(m.description), `no "and more" for a short list (${m.description})`);

m = buildMeta({ owner: { handle: 'someone' }, list: { category: 'Books', items: [] } });
ok(m.title === '@someone’s Top 10 Books', `falls back to the handle (${m.title})`);
ok(/shared a Top 10/.test(m.description), `empty list still gets a sentence (${m.description})`);

m = buildMeta({ owner: {}, list: {} });
ok(m.title === 'Someone’s Top 10 Top 10', `nothing at all still produces a title (${m.title})`);

m = buildMeta(null);
ok(typeof m.title === 'string' && m.title.length > 0, `null input does not throw (${m.title})`);

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed');
process.exit(fails.length ? 1 : 0);
