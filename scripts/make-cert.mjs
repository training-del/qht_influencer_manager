/**
 * Creates a self-signed certificate so the server can speak HTTPS on the LAN.
 *
 * The camera is the reason this exists: browsers only expose getUserMedia on a
 * secure origin, so over plain http:// to a laptop's IP a phone simply has no
 * camera API at all. localhost is exempt, which is why it works on the laptop
 * but not on the phone.
 *
 *   npm run cert            -> cover localhost + every LAN address of this machine
 *   npm run cert -- 1.2.3.4 -> also cover a specific address
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const DIR = 'certs';
mkdirSync(DIR, { recursive: true });

const ips = ['127.0.0.1'];
for (const [name, list] of Object.entries(networkInterfaces())) {
  for (const net of list || []) {
    if (net.family !== 'IPv4' || net.internal) continue;
    if (/vEthernet|Loopback/i.test(name)) continue;
    if (net.address.startsWith('169.254.')) continue;
    ips.push(net.address);
  }
}
for (const extra of process.argv.slice(2)) ips.push(extra);

const unique = [...new Set(ips)];
const san = ['DNS:localhost', ...unique.map(ip => `IP:${ip}`)].join(',');

const conf = `${DIR}/openssl.cnf`;
writeFileSync(conf, `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = QHT Influencer Manager (development)
O = QHT

[v3]
subjectAltName = ${san}
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyCertSign
extendedKeyUsage = serverAuth
`);

try {
  execFileSync('openssl', [
    'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
    '-keyout', `${DIR}/key.pem`, '-out', `${DIR}/cert.pem`,
    '-days', '825', '-config', conf
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (err) {
  console.error('openssl failed:\n' + String(err.stderr || err.message));
  process.exit(1);
}

if (!existsSync(`${DIR}/cert.pem`)) { console.error('certificate was not written'); process.exit(1); }

// the Android app bundles this cert as a trust anchor, so keep the copy in sync
const androidCa = 'android/app/src/main/res/raw/qht_dev_ca.pem';
if (existsSync('android/app/src/main/res/raw')) {
  writeFileSync(androidCa, readFileSync(`${DIR}/cert.pem`));
  console.log('Copied into the Android project: ' + androidCa);
}

console.log('Certificate written to certs/  (valid 825 days)');
console.log('Covers: ' + san.replace(/,/g, ', '));
console.log('\nStart it with:  npm run start:https');
console.log('Then on the phone open  https://<the LAN address>:4443');
console.log('It is self-signed, so the browser warns once — choose Advanced -> Proceed.');
