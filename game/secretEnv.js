// game/secretEnv.js
// Docker/Compose secrets support: for any configuration value NAME, a
// sibling NAME_FILE pointing at a file (e.g. /run/secrets/db_password)
// takes effect when NAME itself is unset. Keeps real secrets out of the
// container environment (they never show up in `docker inspect`).
const fs = require('fs');

function readSecret(env, name) {
  if (env[name]) return env[name];
  const file = env[`${name}_FILE`];
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    console.error(`Could not read secret file for ${name} (${file}): ${e.message}`);
    return undefined;
  }
}

module.exports = { readSecret };
