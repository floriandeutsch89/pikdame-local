// Stand-in for a pg Pool. Records every query.
//  failNext(err)        throws err for the next data statement (INSERT/UPDATE/DELETE)
//  failWhere(pred, err) throws err for every data statement matching pred
//  holdNext()           stalls the next data statement until the returned release()
//  committed()          data statements of transactions that COMMITted
//  delay(ms)            makes every data statement take ms (a slow or failing server)
const DATA = /^\s*(INSERT|UPDATE|DELETE)/i;

function createFakePool() {
  const log = [];
  const failures = [];
  const rules = [];
  const holds = [];
  const committedRows = [];
  let delayMs = 0;
  let open = null;
  const client = {
    async query(text, values) {
      log.push({ text, values });
      if (/^\s*BEGIN\b/i.test(text)) open = [];
      if (DATA.test(text)) {
        const q = { text, values };
        if (holds.length) await holds.shift();
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const rule = rules.find((r) => r.when(q));
        if (rule) throw rule.err;
        if (failures.length) throw failures.shift();
        if (open) open.push(q);
      }
      if (/^\s*COMMIT\b/i.test(text) && open) { committedRows.push(...open); open = null; }
      if (/^\s*ROLLBACK\b/i.test(text)) open = null;
      return { rows: [] };
    },
    release() {},
  };
  return {
    log,
    failNext(err) { failures.push(err); },
    failWhere(when, err) { rules.push({ when, err }); },
    holdNext() {
      let release;
      holds.push(new Promise((r) => { release = r; }));
      return { release };
    },
    committed: () => committedRows.slice(),
    delay(ms) { delayMs = ms; },
    async connect() { return client; },
    async query(text, values) { return client.query(text, values); },
    dataStatements() { return log.filter((q) => DATA.test(q.text)); },
  };
}

module.exports = { createFakePool };
