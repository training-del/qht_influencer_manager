/**
 * Builds the debug APK and drops it in dist/.
 *
 * The toolchain lives under C:/Android rather than being installed system-wide —
 * nothing was added to the machine's PATH — so JAVA_HOME and ANDROID_HOME are
 * set here. Forward slashes throughout: Windows accepts them and they survive
 * every layer of shell quoting.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Android/jdk';
const ANDROID_HOME = process.env.ANDROID_HOME || 'C:/Android/sdk';

for (const [name, path] of [['JDK', JAVA_HOME], ['Android SDK', ANDROID_HOME]]) {
  if (!existsSync(path)) {
    console.error(`${name} not found at ${path}`);
    console.error('See the "Android APK" section of the README for how to install it.');
    process.exit(1);
  }
}

const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME,
  Path: `${JAVA_HOME}/bin;${process.env.Path ?? ''}`
};

console.log('Syncing web assets and config into the Android project…');
execFileSync('npx', ['cap', 'sync', 'android'], { stdio: 'inherit', shell: true });

console.log('Building…');
execFileSync('cmd', ['/c', '.\\gradlew.bat', 'assembleDebug', '--no-daemon'],
  { cwd: 'android', stdio: 'inherit', env });

const built = join('android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!existsSync(built)) {
  console.error('Build reported success but no APK was produced at ' + built);
  process.exit(1);
}

mkdirSync('dist', { recursive: true });
const out = join('dist', 'qht-influencer.apk');
copyFileSync(built, out);

console.log(`\n${out}  (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB)`);
console.log('Send it to a phone and open it to install.');
