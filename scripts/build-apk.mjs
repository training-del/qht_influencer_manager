/**
 * Builds the Android app and publishes it for download.
 *
 *   node scripts/build-apk.mjs           release build, signed with the QHT key
 *   node scripts/build-apk.mjs --debug   debug build (for testing on a cable only)
 *
 * The APK lands in dist/ and in public/downloads/, next to an apk.json the
 * login page reads to show the version and size. `npm run deploy` then puts
 * it on the site.
 *
 * Release, not debug, for anything handed out: a debug build is debuggable,
 * so anyone with a USB cable can read the app's storage — the signed-in token
 * included. The signing key is android/qht-release.jks with its passwords in
 * android/keystore.properties; both stay out of git and must be backed up.
 * Every future update has to be signed with the same key, or phones will
 * refuse to install it over the old one.
 *
 * The toolchain lives under C:/Android rather than being installed system-wide,
 * so JAVA_HOME and ANDROID_HOME are set here.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const JAVA_HOME = process.env.JAVA_HOME || 'C:/Android/jdk';
const ANDROID_HOME = process.env.ANDROID_HOME || 'C:/Android/sdk';
const debug = process.argv.includes('--debug');

for (const [name, path] of [['JDK', JAVA_HOME], ['Android SDK', ANDROID_HOME]]) {
  if (!existsSync(path)) {
    console.error(`${name} not found at ${path}`);
    process.exit(1);
  }
}
if (!debug && !existsSync('android/keystore.properties')) {
  console.error('No release key (android/keystore.properties). Restore it from your backup —');
  console.error('a new key means phones cannot update over the installed app.');
  process.exit(1);
}

const env = {
  ...process.env,
  JAVA_HOME,
  ANDROID_HOME,
  Path: `${JAVA_HOME}/bin;${process.env.Path ?? ''}`
};

console.log('Syncing web assets and config into the Android project…');
execFileSync('npx', ['cap', 'sync', 'android'], { stdio: 'inherit', shell: true });

/* public/ is the app's web root, and public/downloads holds the last APK.
   Left in, every build would carry the previous one inside it. */
rmSync(join('android', 'app', 'src', 'main', 'assets', 'public', 'downloads'), { recursive: true, force: true });

/* Push notifications need Firebase inside the app. Only when this build has it
   is the web code told it may register — without it, asking the native plugin
   crashes the app on start. The website's own copy always says false. */
const firebase = existsSync(join('android', 'app', 'google-services.json'));
writeFileSync(join('android', 'app', 'src', 'main', 'assets', 'public', 'js', 'push-flag.js'),
  `/* written by scripts/build-apk.mjs */\nexport const PUSH_READY = ${firebase};\n`);
console.log(firebase
  ? 'Firebase config found: notifications are on in this build.'
  : 'No android/app/google-services.json: notifications are OFF in this build.');

console.log(`Building (${debug ? 'debug' : 'release'})…`);
execFileSync('cmd', ['/c', '.\\gradlew.bat', debug ? 'assembleDebug' : 'assembleRelease', '--no-daemon'],
  { cwd: 'android', stdio: 'inherit', env });

const kind = debug ? 'debug' : 'release';
const built = join('android', 'app', 'build', 'outputs', 'apk', kind, `app-${kind}.apk`);
if (!existsSync(built)) {
  console.error('Build reported success but no APK was produced at ' + built);
  process.exit(1);
}

const gradle = readFileSync(join('android', 'app', 'build.gradle'), 'utf8');
const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1];

const bytes = readFileSync(built);
const info = {
  versionName, versionCode, build: kind, push: firebase,
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  builtAt: new Date().toISOString()
};

mkdirSync('dist', { recursive: true });
copyFileSync(built, join('dist', 'qht-influencer.apk'));

if (!debug) {
  mkdirSync(join('public', 'downloads'), { recursive: true });
  copyFileSync(built, join('public', 'downloads', 'qht-influencer.apk'));
  writeFileSync(join('public', 'downloads', 'apk.json'), JSON.stringify(info, null, 2) + '\n');
}

console.log(`\nQHT Influencer ${versionName} (${versionCode}), ${kind}`);
console.log(`  ${(info.size / 1024 / 1024).toFixed(2)} MB  sha256 ${info.sha256}`);
console.log(debug
  ? '  dist/qht-influencer.apk — debug, not published'
  : '  dist/ and public/downloads/ — run `npm run deploy` to publish it');
