// ESM bootstrap for clippyjs. Loads the agent from CDN and hands it to the
// shell, which manages everything else. Kept tiny so a CDN miss doesn't take
// the rest of the desktop with it.
//
// Uses esm.sh because the clippyjs package ships an `exports` map and jsdelivr
// now rejects raw `/dist/*.mjs` paths (HTTP 400, served as text/plain), which
// the browser refuses to execute as a module.
import { initAgent } from 'https://esm.sh/clippyjs';
import { Clippy } from 'https://esm.sh/clippyjs/agents';

(async () => {
    // The shell (app.js) loads as a normal script and synchronously sets
    // window.BabelcomClippy.attach. Module scripts are deferred, so by the
    // time we run, app.js has executed — but in case ordering ever changes,
    // poll briefly.
    for (let i = 0; i < 50 && !window.BabelcomClippy?.attach; i++) {
        await new Promise((r) => setTimeout(r, 50));
    }
    if (!window.BabelcomClippy?.attach) {
        console.warn('Clippy: shell not ready, giving up');
        return;
    }
    try {
        const agent = await initAgent(Clippy);
        window.BabelcomClippy.attach(agent);
    } catch (e) {
        console.warn('Clippy: failed to load', e);
    }
})();
