'use strict';
// OS-assigned free port so concurrent `npm test` runs never collide on fixed ports.
const net = require('net');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
