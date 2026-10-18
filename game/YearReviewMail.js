// game/YearReviewMail.js
// The December review as a mail: only for verified accounts that opted in,
// once per account and year, with a one-click unsubscribe link in every mail.
// compose* is pure; the sender takes the stores and the mailer as arguments.
const crypto = require('crypto');
const { gameDay, gameHour } = require('./GameDay');
const { isReviewSeason } = require('./YearReview');

const SEND_DAY = 27; // 27.12., after Christmas and before New Year's Eve
const SEND_HOUR = 10; // German time
const MAX_ATTEMPTS = 3; // per account and process: a broken relay must not loop
// Stored with every opt-in: the consent text's date + the first 8 hex of the SHA-256
// of its German wording (#accountMailPrefs) - new wording, new version (contract test).
const REVIEW_MAIL_CONSENT_VERSION = '2026-10-18.2fdbb3a5';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const LEVEL_NAMES = {
  de: { easy: 'Leicht', medium: 'Mittel', hard: 'Schwer', zen: 'Zen' },
  en: { easy: 'Easy', medium: 'Medium', hard: 'Hard', zen: 'Zen' },
};

function formatDay(date, lang) {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** The lines of the mail, one fact each; facts without data are left out. */
function reviewLines(review, lang) {
  const en = lang === 'en';
  const t = review.totals;
  const pct = t.games ? Math.round((t.wins / t.games) * 100) : 0;
  const lines = [];
  // The cat's verdict follows the win rate - praise at 5 % would read as mockery.
  const verdict = pct >= 50
    ? (en ? 'The cat nods approvingly.' : 'Die Katze nickt anerkennend.')
    : pct >= 25
      ? (en ? 'Solid. The cat purrs.' : 'Solide. Die Katze schnurrt.')
      : (en ? 'Taking part is what counts – says the cat, at least.' : 'Dabei sein ist alles – sagt jedenfalls die Katze.');
  lines.push(en
    ? `${t.games} ${t.games === 1 ? 'game' : 'games'} of Pik Dame, ${t.wins} of them won (${pct} %). ${verdict}`
    : `${t.games} ${t.games === 1 ? 'Partie' : 'Partien'} Pik Dame, ${t.wins} davon gewonnen (${pct} %). ${verdict}`);
  if (t.queensLaid || t.queensCaught) {
    lines.push(en
      ? `You rescued the queen of spades ${t.queensLaid} ${t.queensLaid === 1 ? 'time' : 'times'}${t.queensCaught ? ` – and took her home ${t.queensCaught} ${t.queensCaught === 1 ? 'time' : 'times'}. Happens to the best of us` : ''}.`
      : `Die Pik Dame hast du ${t.queensLaid}-mal gerettet${t.queensCaught ? ` – und ${t.queensCaught}-mal mit nach Hause genommen. Passiert den Besten` : ''}.`);
  }
  if (t.bestRound > 0) {
    lines.push(en
      ? `Your best round: +${t.bestRound} points. Even the cat stopped grooming for a second.`
      : `Deine beste Runde: +${t.bestRound} Punkte. Da hat sogar die Katze kurz aufgehört, sich zu putzen.`);
  }
  if (review.favorite) {
    const f = review.favorite;
    lines.push(en
      ? `You shared the table with ${f.name} most often: ${f.games} ${f.games === 1 ? 'game' : 'games'}, ${f.wins} of them went to you.`
      : `Am häufigsten saßt du mit ${f.name} am Tisch: ${f.games} ${f.games === 1 ? 'Partie' : 'Partien'}, ${f.wins} davon gingen an dich.`);
  }
  const strongest = (review.bots || []).slice(-1)[0];
  if (strongest) {
    const lvl = LEVEL_NAMES[en ? 'en' : 'de'][strongest.level] || strongest.level;
    lines.push(en
      ? `Against the ${lvl} bots: ${strongest.wins} ${strongest.wins === 1 ? 'win' : 'wins'} in ${strongest.games} ${strongest.games === 1 ? 'game' : 'games'}.`
      : `Gegen die ${lvl}-Bots: ${strongest.wins} ${strongest.wins === 1 ? 'Sieg' : 'Siege'} in ${strongest.games} ${strongest.games === 1 ? 'Partie' : 'Partien'}.`);
  }
  if (t.bestStreak > 1) {
    lines.push(en ? `Your longest streak: ${t.bestStreak} days in a row.` : `Deine längste Serie: ${t.bestStreak} Tage am Stück.`);
  }
  if (review.table) {
    const s = review.table;
    lines.push(en
      ? `At the regulars' table “${s.name}” the cards were dealt ${s.games} ${s.games === 1 ? 'time' : 'times'} – ${s.wins} ${s.wins === 1 ? 'time' : 'times'} you had the last word.`
      : `Am Stammtisch „${s.name}“ wurde ${s.games}-mal gemischt – ${s.wins}-mal hattest du das letzte Wort.`);
  }
  return lines;
}

/**
 * @param {{review:object, name:string, lang?:string, appUrl:string, unsubscribeUrl:string}} input
 * @returns {{subject:string, text:string, html:string}}
 */
function composeReviewMail({ review, name, lang = 'de', appUrl, unsubscribeUrl }) {
  const en = lang === 'en';
  const year = review.year;
  const since = review.totalsSince ? formatDay(review.totalsSince, lang) : null;
  const subject = en ? `Your Pik Dame year ${year}` : `Dein Pik-Dame-Jahr ${year}`;
  const hello = en ? `Hi ${name},` : `Hallo ${name},`;
  const intro = en ? 'the cat has done the counting. 🐈' : 'die Katze hat nachgezählt. 🐈';
  const sinceNote = since ? (en ? `(Counted since ${since}.)` : `(Gezählt seit dem ${since}.)`) : '';
  const lines = reviewLines(review, lang);
  const cta = en ? 'The whole review with every card is in the game until 31 December:' : 'Den ganzen Rückblick mit allen Karten gibt’s bis Silvester im Spiel:';
  const bye = en ? `A good hand for ${Number(year) + 1}!\nYour Pik Dame cat` : `Gut Blatt für ${Number(year) + 1}!\nDeine Pik-Dame-Katze`;
  const footer = en
    ? 'You get this mail once a year because you switched on the year review in your account. You can unsubscribe any time:'
    : 'Du bekommst diese Mail einmal im Jahr, weil du den Jahresrückblick in deinem Konto eingeschaltet hast. Abbestellen kannst du jederzeit:';

  const text = [
    hello, '', intro, sinceNote, '',
    ...lines.flatMap((l) => [l, '']),
    cta, appUrl, '',
    bye, '', '--', footer, unsubscribeUrl, '',
  ].filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');

  const p = (inner, style = '') => `<p style="margin:0 0 14px;line-height:1.5;${style}">${inner}</p>`;
  const html = `<!DOCTYPE html><html lang="${en ? 'en' : 'de'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#10342a;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2420">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#10342a"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fffaf2;border-radius:16px">
<tr><td style="padding:28px 28px 8px;text-align:center">
<div style="font-size:44px;line-height:1">🐈</div>
<h1 style="margin:10px 0 4px;font-size:24px;color:#10342a">${escapeHtml(subject)}</h1>
${since ? `<div style="font-size:13px;color:#6b726e">${escapeHtml(sinceNote)}</div>` : ''}
</td></tr>
<tr><td style="padding:16px 28px 4px;font-size:16px">
${p(escapeHtml(hello))}
${p(escapeHtml(intro))}
${lines.map((l) => p(escapeHtml(l), 'padding:10px 14px;background:#f1ebe0;border-radius:10px')).join('\n')}
</td></tr>
<tr><td style="padding:8px 28px 24px;text-align:center">
${p(escapeHtml(cta), 'font-size:15px')}
<a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#c8323c;color:#ffffff;text-decoration:none;font-weight:700">${en ? 'Open my year' : 'Mein Jahr ansehen'}</a>
${p(escapeHtml(bye).replace('\n', '<br>'), 'margin-top:22px')}
</td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#c9d6cf;text-align:center">${escapeHtml(footer)}<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#ffffff">${en ? 'Unsubscribe' : 'Abbestellen'}</a></p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

/** Example numbers for the admin preview and the screenshots, never a real player's. */
function sampleReview(year) {
  return {
    year: String(year),
    name: null,
    totals: { games: 87, wins: 34, queensLaid: 21, queensCaught: 6, bestRound: 285, bestGame: 1385, handAus: 2, jokers: 64, bestStreak: 11 },
    totalsSince: null,
    breakdownSince: null,
    activeDays: 41,
    favorite: { name: 'Oma Gerda', games: 37, wins: 15 },
    bots: [{ level: 'easy', games: 9, wins: 7 }, { level: 'medium', games: 24, wins: 11 }, { level: 'zen', games: 12, wins: 3 }],
    table: { name: 'Donnerstagsrunde', games: 23, wins: 9 },
  };
}

/** Year whose mail is due at `now` (27.12. from 10:00 to 31.12., German time), else null. */
function dueYear(now, { day = SEND_DAY, hour = SEND_HOUR } = {}) {
  const date = gameDay(now);
  if (!isReviewSeason(date)) return null;
  const d = Number(date.slice(8, 10));
  if (d < day || (d === day && gameHour(now) < hour)) return null;
  return date.slice(0, 4);
}

/**
 * The sender. Idempotent per account and year through the account store
 * (survives restarts); call tick() from a timer.
 * @param {{accountStore:object, reviewFor:(username:string, year:string)=>Promise<object|null>|object|null,
 *   mailer:object, baseUrl:string, log?:Function}} deps
 */
function createYearReviewMailer({ accountStore, reviewFor, mailer, baseUrl, log = console.log, day = SEND_DAY, hour = SEND_HOUR }) {
  const attempts = new Map(); // `${id}:${year}` -> failed sends in this process
  let running = false;

  async function tick(now = Date.now()) {
    const year = dueYear(now, { day, hour });
    if (!year || running || !accountStore || typeof accountStore.reviewMailRecipients !== 'function') {
      return { year, sent: 0, skipped: 0, failed: 0 };
    }
    running = true;
    const result = { year, sent: 0, skipped: 0, failed: 0 };
    try {
      const recipients = await accountStore.reviewMailRecipients(year);
      for (const r of recipients) {
        const key = `${r.id}:${year}`;
        if ((attempts.get(key) || 0) >= MAX_ATTEMPTS) continue;
        const review = await reviewFor(r.username, year);
        if (!review) {
          // Nothing played this year: no mail, and no second look this year.
          await accountStore.markReviewMailSent(r.id, year);
          result.skipped += 1;
          continue;
        }
        const token = crypto.randomBytes(32).toString('hex');
        await accountStore.setReviewUnsubHash(r.id, crypto.createHash('sha256').update(token).digest('hex'));
        const unsubscribeUrl = `${baseUrl}/unsubscribe?t=${token}`;
        const mail = composeReviewMail({ review, name: r.username, lang: r.lang, appUrl: `${baseUrl}/?jahr=${year}`, unsubscribeUrl });
        const sent = await mailer.send({
          to: r.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        });
        // Without a relay the mail went to the log (by design) - that counts as done.
        if (sent.delivered || sent.reason === 'smtp_not_configured') {
          await accountStore.markReviewMailSent(r.id, year);
          result.sent += 1;
        } else {
          attempts.set(key, (attempts.get(key) || 0) + 1);
          result.failed += 1;
        }
      }
    } catch (err) {
      log(`[year-review] Versand abgebrochen: ${err.message}`);
    } finally {
      running = false;
    }
    if (result.sent || result.failed) log(`[year-review] ${year}: ${result.sent} gesendet, ${result.failed} fehlgeschlagen, ${result.skipped} ohne Partie`);
    return result;
  }

  return { tick };
}

module.exports = {
  composeReviewMail, reviewLines, sampleReview, dueYear, createYearReviewMailer, SEND_DAY, SEND_HOUR, REVIEW_MAIL_CONSENT_VERSION,
};
