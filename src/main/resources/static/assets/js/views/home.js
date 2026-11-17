// Home answers one question at a glance: am I OK right now? One number, what's free to spend
// after bills and saving, with one line of status under it. Everything else is a tap away:
// whether this month's saving has moved, the emergency fund, and only the problems.

import { get, post } from '../api.js';
import { h, toast, busy, icon } from '../ui.js';
import { money, pct, shortDate, parseDay, privacy, depositLine, filedLine } from '../fmt.js';

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
  const m = model(d, f, claude);
  return h('div', { class: 'home' }, setup, hero(m), links(m));
}

// --- What Home reads ------------------------------------------------------------------

const VERDICT = {
  ok: ['good', 'On track'], tight: ['warn', 'A little tight'], under: ['warn', 'Saving less this month'],
  short: ['bad', 'Short this month'], unknown: ['', 'Pay not known yet'],
};

const BANK = {
  NEEDS_REAUTH: () => 'needs you to sign in again',
  ERROR: () => 'sync failed',
  WARNING: () => 'needs attention',
  BEHIND: (p) => `nothing new since ${shortDate(p.since)}`,
};

function model(d, f, claude) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = (iso) => Math.round((parseDay(iso) - today) / 86400000);

  const s = d.saving;
  const target = s.targetCents ?? f.savingsTargetCents ?? 0;
  const saving = { moved: s.movedCents, target, next: s.next, done: target > 0 && s.movedCents >= target };

  const goal = d.targets.goals.find((g) => g.type === 'BALANCE' && /emergency/i.test(g.name))
    || d.targets.goals.find((g) => g.type === 'BALANCE');

  // Problems only, worst first: a bank that stopped, targets over, card bills this week, then
  // targets close to their limit and charges Claude flagged.
  const problems = [];
  for (const p of d.problems) {
    problems.push({ tone: 'bad', text: `${p.name} ${(BANK[p.status] || BANK.ERROR)(p)}`, href: '#/accounts' });
  }
  const spending = [...d.targets.spending].sort((a, b) => b.fraction - a.fraction);
  const inCategory = (t) => `#/activity?category=${t.categoryId}&month=${d.month}&from=targets`;
  for (const t of spending.filter((x) => x.status === 'over')) {
    problems.push({ tone: 'bad', text: `${t.name}: ${money(t.spentCents - t.limitCents)} over`, href: inCategory(t) });
  }
  for (const c of d.cards) {
    const owed = c.statementBalanceCents ?? -c.balanceCents;
    if (!c.dueDate || owed <= 0) continue;
    const n = days(c.dueDate);
    if (n < 0 || n > 7) continue;
    const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : shortDate(c.dueDate);
    // The statement's amount due is a bill; without one, it's the card's balance, which stays hidden.
    problems.push({ tone: 'warn', text: `${c.name} due ${when}`, amount: money(owed, { secret: c.statementBalanceCents == null }), href: '#/accounts' });
  }
  for (const t of spending.filter((x) => x.status === 'watch')) {
    problems.push({ tone: 'warn', text: `${t.name}: ${money(t.limitCents - t.spentCents)} left`, href: inCategory(t) });
  }
  for (const i of (claude?.items || []).filter((x) => x.kind === 'CHARGE')) {
    problems.push({ tone: 'warn', text: `${i.description}: ${i.reason}`, href: '#/insights' });
  }

  return {
    free: { cents: f.freeCents, perDay: f.perDayCents, daysLeft: f.daysLeft, status: f.status,
      verdict: VERDICT[f.status] || VERDICT.unknown },
    saving, goal, problems,
  };
}

// --- The number -------------------------------------------------------------------------

function hero(m) {
  // The month's verdict and the daily pace; problems are counted on their own row below.
  const days = m.free.daysLeft;
  const status = m.free.status === 'unknown' || days <= 0 ? m.free.verdict[1]
    : `${m.free.verdict[1]} · about ${money(m.free.perDay)} a day for ${days} day${days === 1 ? '' : 's'}`;
  return h('a', { class: 'home-hero', href: '#/month', 'aria-label': 'Free to spend, open This month' },
    h('div', { class: 'home-num' }, money(m.free.cents)),
    h('div', { class: 'home-label' }, 'free to spend this month'),
    h('div', { class: 'home-status ' + m.free.verdict[0] }, status));
}

// --- One tap away -----------------------------------------------------------------------

function links(m) {
  const s = m.saving;
  const savingMeta = s.done ? 'Done for this month'
    : s.next ? `Next ${money(s.next.cents)} on ${shortDate(s.next.day)}` : null;
  const card = h('section', { class: 'card flush home-links' },
    h('a', { class: 'home-row', href: '#/targets' },
      h('span', { class: 'home-name' }, 'Saving', savingMeta ? h('span', { class: 'home-meta' }, savingMeta) : null),
      h('span', { class: 'home-val' + (s.done ? ' good' : '') }, s.target ? `${money(s.moved)} of ${money(s.target)}` : money(s.moved)),
      icon('chevron', 16)));
  const g = m.goal;
  if (g) {
    // A balance goal's progress is an account balance: only how far along, while balances are hidden.
    const value = g.status === 'done' ? 'Done' : privacy.on ? pct(Math.min(g.fraction, 1)) : `${money(g.currentCents)} of ${money(g.targetCents)}`;
    card.append(h('a', { class: 'home-row', href: '#/goals' },
      h('span', { class: 'home-name' }, g.name, g.status === 'behind' ? h('span', { class: 'home-meta warn' }, 'Behind') : null),
      h('span', { class: 'home-val' }, value), icon('chevron', 16)));
  } else {
    card.append(h('a', { class: 'home-row', href: '#/goals' }, h('span', { class: 'home-name' }, 'Set an emergency fund goal'), icon('chevron', 16)));
  }
  if (m.problems.length) {
    // The problems open in place, so the one number stays the only thing on screen until asked.
    card.append(h('details', { class: 'home-more' },
      h('summary', { class: 'home-row' }, h('span', { class: 'home-name' }, 'Needs a look'),
        h('span', { class: 'home-count ' + m.problems[0].tone }, String(m.problems.length)), icon('chevron', 16)),
      m.problems.map((p) => h('a', { class: 'home-row problem', href: p.href },
        h('span', { class: 'home-dot ' + p.tone }),
        h('span', { class: 'home-name' }, p.text),
        p.amount ? h('span', { class: 'home-val' }, p.amount) : null,
        icon('chevron', 16)))));
  }
  return card;
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
