// ESM bootstrap for clippyjs. Loads the agent and hands it to the shell, which
// manages everything else. Kept tiny so a load failure doesn't take the rest of
// the desktop with it.
//
// Self-hosted from /static/vendor/clippyjs (clippyjs@0.1.0). The agent's sprite
// sheet and sounds are inlined as data-URI modules, so the only thing the
// browser fetches is these .mjs files — no external CDN. The Go static handler
// must serve .mjs as application/javascript or the browser won't run them.
import { initAgent } from '/static/vendor/clippyjs/dist/index.mjs';
import Clippy from '/static/vendor/clippyjs/dist/agents/clippy/index.mjs';

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
