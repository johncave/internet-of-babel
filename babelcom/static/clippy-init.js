// ESM bootstrap for clippyjs. Loads the agent from CDN and hands it to the
// shell, which manages everything else. Kept tiny so a CDN miss doesn't take
// the rest of the desktop with it.
import { initAgent } from 'https://cdn.jsdelivr.net/npm/clippyjs/dist/index.mjs';
import { Clippy } from 'https://cdn.jsdelivr.net/npm/clippyjs/dist/agents/index.mjs';

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
