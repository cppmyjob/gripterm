import { hostUserData } from './host-user-data.mjs';

/*
 * Prepares the F5 window, and is a `preLaunchTask` for exactly one reason: since
 * the store refusal, a development host with no `gripterm.storage.path` fails to
 * activate. The alternative -- telling the person to put the setting into their
 * own `settings.json` -- would point their EVERYDAY editor at a test store,
 * which is the same accident in the other direction.
 */
console.log(`dev host user data: ${hostUserData('dev')}`);
