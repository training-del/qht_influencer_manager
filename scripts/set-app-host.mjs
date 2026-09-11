/**
 * Points the Android app at this machine's server.
 *
 * The Capacitor app loads the live app from the Express server rather than
 * bundling a static copy, so the phone needs a reachable address. Laptop IPs
 * move between networks — run this whenever the app can no longer connect.
 *
 *   npm run app:ip                  -> pick the LAN IP automatically
 *   npm run app:ip -- 192.168.1.5   -> use a specific host
 *   npm run app:ip -- https://qht.example.com
 */
import { networkInterfaces } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';

const CONFIG = 'capacitor.config.json';
const arg = process.argv[2];

/** Private LAN addresses a phone on the same Wi-Fi can actually reach. */
function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      // skip virtual switches and link-local, which a phone cannot reach
      if (/vEthernet|Loopback|Tailscale/i.test(name)) continue;
      if (net.address.startsWith('169.254.')) continue;
      found.push({ name, address: net.address });
    }
  }
  return found;
}

let url;
if (arg) {
  url = /^https?:\/\//.test(arg) ? arg.replace(/\/$/, '') : `http://${arg}:4000`;
} else {
  const nets = lanAddresses();
  if (!nets.length) {
    console.error('No LAN address found. Pass one explicitly:  npm run app:ip -- 192.168.1.5');
    process.exit(1);
  }
  // prefer Wi-Fi: the phone is almost certainly on it
  const pick = nets.find(n => /wi-?fi|wlan/i.test(n.name)) ?? nets[0];
  url = `http://${pick.address}:4000`;
  if (nets.length > 1) {
    console.log('Interfaces found:');
    nets.forEach(n => console.log(`   ${n.name.padEnd(22)} ${n.address}${n === pick ? '   <- using this' : ''}`));
  }
}

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
const before = cfg.server?.url;
const secure = url.startsWith('https://');

cfg.server = {
  ...cfg.server,
  url,
  cleartext: !secure,
  androidScheme: secure ? 'https' : 'http'
};
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');

console.log(`\n${CONFIG} updated`);
console.log(`   was: ${before}`);
console.log(`   now: ${url}`);
console.log('\nNext:  npm run app:sync   (then rebuild the app)');
if (!secure) {
  console.log('\nNote: the camera only opens on https:// or localhost. Over plain http on a');
  console.log('phone the "Choose a file" option still works, but the live camera will not.');
}
