// Home answers three things about this month: how much is left to spend, where the pay went,
// and why it's gone. Then what's left in each spending target, and the emergency fund.
// Every row opens what's behind it.

import { get, post } from '../api.js';
import { h, toast, busy, icon } from '../ui.js';
import { money, pct, shortDate, parseDay, privacy, depositLine, filedLine } from '../fmt.js';
import { meter } from '../charts.js';

export async function render(params, app) {
  const [d, f, claude] = await Promise.all([get('/api/summary'), get('/api/forecast'),
    get('/api/insights').catch(() => null)]);

  if (!d.hasAccounts) {
    return h('div', { class: 'card empty' },
      h('p', null, 'Nothing here yet. Connect a bank, add an account by hand, or import a statement.'),
      h('a', { class: 'btn primary', href: '#/accounts' }, 'Add accounts'));
  }

  // With no income on record the number can't say much, so help find the paycheck first.
  const setup = d.plan.incomeCents === 0 ? await incomeSetup(app) : null;
  return h('div', { class: 'home' }, setup, hero(d, f), headsUp(d), where(d, f), why(d, f, claude), left(d), fund(d));
}

const VERDICT = {
  ok: ['good', 'On track'], tight: ['warn', 'A little tight'], under: ['warn', 'Saving less this month'],
  short: ['bad', 'Short this month'], unknown: ['', 'Pay not known yet'],
};

const monthName = (ym) => new Date(ym + '-01T00:00').toLocaleDateString('en-US', { month: 'long' });
const inCategory = (d, id) => `#/activity?category=${id}&month=${d.month}&from=home`;

// --- How much is left ----------------------------------------------------------------

function hero(d, f) {
  const [tone, verdict] = VERDICT[f.status] || VERDICT.unknown;
  const leftCents = f.roomCents - f.savingsTargetCents;
  const days = f.daysLeft;
  let sub;
  if (f.status === 'unknown') sub = 'Waiting for this month\'s pay';
  else if (leftCents <= 0) sub = 'Nothing left after bills and saving';
  else sub = days > 0 ? `About ${money(f.perDayCents)} a day for ${days} day${days === 1 ? '' : 's'}` : 'Last day of the month';
  return h('a', { class: 'home-hero', href: '#/month', 'aria-label': 'Left to spend, open This month' },
    h('div', { class: 'home-label' }, `Left to spend in ${monthName(d.month)}`),
    h('div', { class: 'home-num' + (leftCents < 0 ? ' short' : '') }, money(Math.max(0, f.freeCents))),
    h('div', { class: 'home-sub' }, sub),
    h('span', { class: 'pill ' + tone }, verdict));
}

const BANK = {
  NEEDS_REAUTH: () => 'needs you to sign in again',
  ERROR: () => 'isn\'t syncing',
  WARNING: () => 'needs attention',
  BEHIND: (p) => `has nothing new since ${shortDate(p.since)}`,
};

/** Only when something outside the month's numbers needs you: a bank that stopped, a card bill this week. */
function headsUp(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = d.problems.map((p) => row('#/accounts', 'bad', `${p.name} ${(BANK[p.status] || BANK.ERROR)(p)}`,
    p.status === 'BEHIND' ? 'Recent spending may be missing' : null));
  for (const c of d.cards) {
    const owed = c.statementBalanceCents ?? -c.balanceCents;
    if (!c.dueDate || owed <= 0) continue;
    const n = Math.round((parseDay(c.dueDate) - today) / 86400000);
    if (n < 0 || n > 7) continue;
    const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : shortDate(c.dueDate);
    // The statement's amount is a bill; without one, it's the card's balance, which stays hidden.
    rows.push(row('#/accounts', 'warn', `${c.name} due ${when}`, null, money(owed, { secret: c.statementBalanceCents == null })));
  }
  return rows.length ? h('section', { class: 'card flush home-card' }, rows) : null;
}

function row(href, tone, text, meta, amount) {
  return h('a', { class: 'home-row', href },
    tone ? h('span', { class: 'home-dot ' + tone }) : null,
    h('span', { class: 'home-name' }, text, meta ? h('span', { class: 'home-meta' }, meta) : null),
    amount ? h('span', { class: 'home-amt' }, amount) : null,
    icon('chevron', 16));
}

// --- Where the pay goes ---------------------------------------------------------------

function where(d, f) {
  if (f.status === 'unknown') return null;
  const s = d.spending;
  const fixedCents = s.fixed.reduce((a, l) => a + l.cents, 0);
  const everydayCents = s.everyday.reduce((a, l) => a + l.cents, 0);
  const leftCents = f.roomCents - f.savingsTargetCents;

  const segments = [
    ['fixed', fixedCents], ['due', f.billsComingCents], ['saving', f.savingsTargetCents],
    ['spent', everydayCents], ['left', Math.max(0, leftCents)],
  ].filter(([, c]) => c > 0);
  const bar = h('div', { class: 'home-bar', role: 'img', 'aria-label': 'How this month\'s pay is split' },
    segments.map(([k, c]) => h('span', { class: 'k-' + k, style: { flexGrow: c } })));

  const lines = [];
  for (const l of s.fixed) {
    lines.push(line('fixed', l.name, l.lastDay ? `Paid ${shortDate(l.lastDay)}` : null, l.cents, inCategory(d, l.categoryId)));
  }
  // One or two bills each get a line; more fold into one, listed under it like the spending.
  if (f.billsComing.length <= 2) {
    for (const b of f.billsComing) {
      lines.push(line('due', b.name, b.day ? `Due ${shortDate(b.day)}` : 'Still due', b.cents, '#/month'));
    }
  } else {
    lines.push(line('due', 'Bills still due', `${f.billsComing.length} bills, the next ${shortDate(f.billsComing[0].day)}`,
      f.billsComingCents, '#/month'));
    lines.push(h('div', { class: 'home-split' }, f.billsComing.map((b) =>
      h('a', { href: '#/month' }, h('span', null, `${b.name} · ${shortDate(b.day)}`), h('span', null, money(b.cents))))));
  }
  if (f.savingsTargetCents > 0) lines.push(line('saving', 'Saving', savingMeta(d.saving), f.savingsTargetCents, '#/targets'));

  const spent = line('spent', 'Spent so far', s.oneOffCents > 0 ? `Not counting ${money(s.oneOffCents)} of one-offs` : null,
    everydayCents, '#/month');
  const top = s.everyday.slice(0, 5);
  const rest = s.everyday.slice(5);
  const breakdown = everydayCents > 0 ? h('div', { class: 'home-split' },
    top.map((l) => h('a', { href: inCategory(d, l.categoryId) }, h('span', null, l.name), h('span', null, money(l.cents)))),
    rest.length ? h('a', { class: 'muted', href: '#/month' },
      h('span', null, `${rest.length} more`), h('span', null, money(rest.reduce((a, l) => a + l.cents, 0)))) : null) : null;

  const leftLine = h('a', { class: 'home-line total' + (leftCents < 0 ? ' short' : ''), href: '#/month' },
    h('span', { class: 'home-key k-left' }),
    h('span', { class: 'home-name' }, leftCents < 0 ? 'Short' : 'Left'),
    h('span', { class: 'home-amt' }, money(Math.abs(leftCents))));

  return h('section', { class: 'card flush home-card' },
    h('div', { class: 'home-head' }, h('h2', null, `Where your ${money(f.incomeCents)} goes`)),
    bar, lines, spent, breakdown, leftLine);
}

function line(kind, name, meta, cents, href) {
  return h('a', { class: 'home-line', href },
    h('span', { class: 'home-key k-' + kind }),
    h('span', { class: 'home-name' }, name, meta ? h('span', { class: 'home-meta' }, meta) : null),
    h('span', { class: 'home-amt' }, money(cents)));
}

function savingMeta(s) {
  if (s.targetCents && s.movedCents >= s.targetCents) return 'Moved';
  const next = s.next ? `next ${money(s.next.cents)} on ${shortDate(s.next.day)}` : null;
  if (s.movedCents > 0) return [`${money(s.movedCents)} moved`, next].filter(Boolean).join(', ');
  return next ? `Set aside, ${next}` : 'Set aside, not moved yet';
}

// --- Why it's gone ----------------------------------------------------------------------

const WHY_TITLE = { tight: 'Why it\'s tight', short: 'Why you\'re short', under: 'Why saving won\'t fit all of it' };

function why(d, f, claude) {
  const items = d.spending.why.map((w) => {
    const over = w.limitCents != null ? w.spentCents - w.limitCents : null;
    const first = over != null ? `, ${money(over)} over your ${money(w.limitCents)} target.` : '.';
    let driver = '';
    if (w.driver === 'one') {
      driver = w.driverCents >= w.spentCents ? ` All of it ${w.label} on ${shortDate(w.day)}.`
        : ` ${money(w.driverCents)} of it was ${w.label} on ${shortDate(w.day)}.`;
    } else if (w.driver === 'place') {
      driver = ` ${w.count} charges; the most at ${w.label}, ${money(w.driverCents)} over ${w.visits} visits.`;
    } else if (w.count > 1) {
      driver = ` ${w.count} charges.`;
    }
    return h('a', { class: 'home-why', href: inCategory(d, w.categoryId) },
      h('span', { class: 'home-dot ' + (over != null ? 'bad' : '') }),
      h('span', null, h('b', null, `${w.name}: ${money(w.spentCents)}`), first + driver));
  });
  // Charges Claude flagged this morning: a double charge, a price that went up.
  for (const i of (claude?.items || []).filter((x) => x.kind === 'CHARGE')) {
    items.push(h('a', { class: 'home-why', href: '#/insights' }, h('span', { class: 'home-dot warn' }),
      h('span', null, h('b', null, `Check ${i.description}: ${money(Math.abs(i.amountCents))}`), `. ${i.reason}`)));
  }
  if (!items.length) return null;
  const title = WHY_TITLE[f.status] || 'What stands out';
  return h('section', { class: 'card flush home-card' }, h('div', { class: 'home-head' }, h('h2', null, title)), items);
}

// --- What's left in each target ---------------------------------------------------------

function left(d) {
  const list = [...d.targets.spending].sort((a, b) => (b.limitCents - b.spentCents) - (a.limitCents - a.spentCents));
  if (!list.length) return h('a', { class: 'card tcard-empty', href: '#/targets' }, 'Set spending targets');
  return h('section', { class: 'card flush home-card' },
    h('a', { class: 'home-head', href: '#/targets' }, h('h2', null, 'Left by category'), h('span', { class: 'home-col' }, 'Left')),
    list.map((t) => {
      const leftCents = t.limitCents - t.spentCents;
      return h('a', { class: 'home-cat', href: inCategory(d, t.categoryId) },
        h('span', { class: 'home-name' }, t.name),
        meter(t.fraction, t.status, t.expectedFraction, 'sm'),
        h('span', { class: 'home-amt' + (leftCents < 0 ? ' down' : '') }, money(leftCents)));
    }));
}

// --- The emergency fund -----------------------------------------------------------------

function fund(d) {
  const g = d.targets.goals.find((x) => x.type === 'BALANCE' && /emergency/i.test(x.name))
    || d.targets.goals.find((x) => x.type === 'BALANCE');
  if (!g) return h('a', { class: 'card tcard-empty', href: '#/goals' }, 'Set an emergency fund goal');
  const by = g.targetDate ? 'by ' + new Date(g.targetDate + 'T00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null;
  // A balance goal's progress is an account balance: only how far along, while balances are hidden.
  const meta = privacy.on ? by : [`${money(g.currentCents)} of ${money(g.targetCents)}`, by].filter(Boolean).join(' · ');
  return h('section', { class: 'card flush home-card' },
    h('a', { class: 'home-row', href: '#/goals' },
      h('span', { class: 'home-name' }, g.name, meta ? h('span', { class: 'home-meta' }, meta) : null),
      h('span', { class: 'home-amt' + (g.status === 'behind' ? ' warn' : '') }, g.status === 'done' ? 'Done' : pct(Math.min(g.fraction, 1))),
      icon('chevron', 16)));
}

// --- Income setup (only while income is $0) ---------------------------------------

/**
 * Income counts deposits filed as Paycheck or Side Income. A paycheck whose
 * description no built-in rule recognises lands in Other Income and doesn't
 * count, so offer the regular deposits the app has spotted, one tap each.
 */
async function incomeSetup(app) {
  const { detected } = (await get('/api/paychecks')).overview;
  // Pay already recognised: income is just waiting for this month's payday.
  if (detected.some((p) => p.tracked && !p.accountHidden)) return null;
  const card = h('section', { class: 'card flush setup' },
    h('div', { class: 'tcard-head' }, h('h2', null, 'Set up your income')));
  // Recognised, but it lands in an account you hid, and hidden accounts count nowhere.
  const hiddenPay = detected.find((p) => p.tracked && p.accountHidden);
  if (hiddenPay) {
    card.append(h('div', { class: 'row' },
      h('div', { class: 'main' }, h('div', { class: 'title' }, `Pay from ${hiddenPay.pattern} lands in ${hiddenPay.accountName}`),
        h('div', { class: 'meta wrap' }, 'That account is hidden, so it doesn\'t count. Show it again from Hidden at the bottom of Accounts.')),
      h('a', { class: 'btn small', href: '#/accounts' }, 'Accounts')));
  }
  const candidates = detected.filter((p) => !p.tracked).slice(0, 3);
  if (!candidates.length && hiddenPay) return card;
  if (!candidates.length) {
    card.append(h('div', { class: 'row' }, h('div', { class: 'main' },
      h('div', { class: 'meta wrap' }, 'No regular deposits spotted yet. Open a paycheck in Activity, file it as Paycheck and tick "always file like this".')),
    h('a', { class: 'btn small', href: '#/activity' }, 'Activity')));
    card.append(paystubLink());
    return card;
  }
  for (const p of candidates) {
    const yes = h('button', { class: 'btn small primary' }, 'This is my pay');
    yes.addEventListener('click', busy(yes, async () => {
      const r = await post('/api/paychecks/track', { pattern: p.pattern });
      toast(filedLine(r.filed));
      app.rerender();
    }));
    card.append(h('div', { class: 'row' },
      h('div', { class: 'main' },
        h('div', { class: 'title' }, p.pattern),
        h('div', { class: 'meta' }, depositLine(p))),
      yes));
  }
  card.append(paystubLink());
  return card;
}

// Taxes and 401(k) come out before pay lands; a paystub puts them in the cash flow.
function paystubLink() {
  return h('a', { class: 'row tap', href: '#/paychecks' },
    h('div', { class: 'main' }, h('div', { class: 'title' }, 'Paystub'),
      h('div', { class: 'meta' }, 'Taxes and 401(k) taken out before payday')),
    icon('chevron', 18));
}
