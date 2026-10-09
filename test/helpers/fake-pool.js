// Stand-in for a pg Pool: records every query; failNext(err) makes the next
// data statement (INSERT/UPDATE/DELETE) throw that error.
const DATA = /^\s*(INSERT|UPDATE|DELETE)/i;

function createFakePool() {
  const log = [];
  const failures = [];
  const client = {
    async query(text, values) {
      log.push({ text, values });
      if (DATA.test(text) && failures.length) throw failures.shift();
      return { rows: [] };
    },
    release() {},
  };
  return {
    log,
    failNext(err) { failures.push(err); },
    async connect() { return client; },
    async query(text, values) { return client.query(text, values); },
    dataStatements() { return log.filter((q) => DATA.test(q.text)); },
  };
}

module.exports = { createFakePool };
