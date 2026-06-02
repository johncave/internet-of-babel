// Global state
let runningApps = new Map();
let appRegistry = new Map();

// ---- Shared WebSocket bus ----
// One connection to /ws lives in the shell. Apps subscribe to message types
// via BabelcomAPI.subscribe(type, fn). The taskbar status indicator is driven
// from here so it works whether or not any app is open.
const BabelcomBus = (() => {
    const listeners = new Map(); // type -> Set<fn>
    const latest = new Map();    // type -> last full message
    let articleText = '';        // rolling article buffer; survives bus, fed by snapshots + tokens
    let ws = null;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    const maxReconnectDelay = 30000;

    function connect() {
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${wsProtocol}//${location.host}/ws`;
        updateSystemStatus('CONNECTING', '#ffff00');

        try {
            ws = new WebSocket(url);
        } catch (e) {
            console.warn('🛰️  Bus: failed to construct WebSocket', e);
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            reconnectAttempts = 0;
            updateSystemStatus('ONLINE', '#00ff00');
            console.log('🛰️  Babelcom bus connected');
        };

        ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }
            if (!msg || !msg.type) return;

            latest.set(msg.type, msg);

            // Shell-side reactions
            if (msg.type === 'system_status' && msg.data) {
                updateSystemStatus(msg.data.current_phase || 'ONLINE', '#00ff00');
            } else if (msg.type === 'article_snapshot') {
                articleText = typeof msg.text === 'string' ? msg.text : '';
            } else if (msg.type === 'token' && typeof msg.token === 'string') {
                articleText += msg.token;
            } else if (msg.type === 'reset') {
                articleText = '';
            }

            const subs = listeners.get(msg.type);
            if (subs) {
                for (const fn of subs) {
                    try { fn(msg); } catch (e) { console.error('subscriber error', e); }
                }
            }
        };

        ws.onclose = () => {
            ws = null;
            updateSystemStatus('OFFLINE', '#ff0000');
            scheduleReconnect();
        };

        ws.onerror = (e) => {
            console.warn('🛰️  Babelcom bus error', e);
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
        updateSystemStatus(`RECONNECTING ${Math.round(delay / 1000)}s`, '#ffff00');
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    function subscribe(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
        return () => listeners.get(type)?.delete(fn);
    }

    function getLatest(type) {
        return latest.get(type) || null;
    }

    function getArticleText() {
        return articleText;
    }

    return { connect, subscribe, getLatest, getArticleText };
})();

// ---- Clippy ----
// Shell-owned, global. One agent. Apps register profiles describing what
// Clippy can say when they're focused. The shell tracks focus via WinBox
// events and uses the matching profile's canned bank.
const Clippy = (() => {
    const profiles = new Map();
    const activeAppStack = [];
    let agent = null;
    let idleTimer = null;
    let hasGreeted = false;
    let agentReady = false;     // set once the agent has settled after show()
    let greetRequested = false; // shell asked to greet (maybe before ready)
    // Optional containment: when set, agent._el lives inside `host` instead of
    // document.body, so other WinBox windows can occlude Clippy naturally.
    // Writer registers itself as host on connect (see writer.js).
    let host = null;
    let pendingHost = null;     // setHost called before the agent loaded

    // Dev mode: enable via ?clippyDev in the URL or localStorage.clippyDev = '1'
    const DEV_MODE = (() => {
        try {
            if (new URLSearchParams(location.search).has('clippyDev')) return true;
            if (localStorage.getItem('clippyDev') === '1') return true;
        } catch (e) {}
        return false;
    })();

    const FIRST_IDLE_MIN = 30 * 1000;
    const FIRST_IDLE_MAX = 60 * 1000;
    const IDLE_MIN = 60 * 1000;
    const IDLE_MAX = 120 * 1000;
    const DEV_IDLE_MIN = 3 * 1000;
    const DEV_IDLE_MAX = 6 * 1000;

    if (DEV_MODE) console.log('📎 Clippy: dev mode (fast phrases)');

    function registerProfile(id, profile) {
        profiles.set(id, profile);
    }

    let homeX = null, homeY = null;
    const CLIPPY_POS_KEY = 'babelcom.clippyPos';

    // homeX/homeY is where Clippy returns to after a comment. It follows the
    // user: whenever they drag him somewhere, that becomes his new home, and
    // it's persisted across reloads.
    function rememberHome() {
        if (!agent?._el) return;
        const r = agent._el.getBoundingClientRect();
        homeX = r.left;
        homeY = r.top;
        try { localStorage.setItem(CLIPPY_POS_KEY, JSON.stringify({ x: homeX, y: homeY })); } catch (e) {}
    }

    function restoreHome() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(CLIPPY_POS_KEY) || 'null'); } catch (e) {}
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && agent?._el) {
            homeX = saved.x;
            homeY = saved.y;
            // Place instantly (no slide-in) by setting the inline style WinBox
            // -style positioning clippyjs already uses.
            agent._el.style.left = saved.x + 'px';
            agent._el.style.top = saved.y + 'px';
        } else {
            rememberHome();
        }
    }

    // Update home whenever the user finishes dragging Clippy (position actually
    // changed between pointer-down and pointer-up — a plain click won't count).
    function trackDrag() {
        if (!agent?._el) return;
        const el = agent._el;
        let startRect = null;
        const onDown = () => { startRect = el.getBoundingClientRect(); };
        const onUp = () => {
            if (!startRect) return;
            const now = el.getBoundingClientRect();
            if (now.left !== startRect.left || now.top !== startRect.top) {
                rememberHome(); // dragged
            } else {
                poke();         // clicked
            }
            startRect = null;
        };
        el.addEventListener('mousedown', onDown);
        el.addEventListener('touchstart', onDown, { passive: true });
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchend', onUp);
    }

    // Clicked (not dragged): play a random animation AND say a default line at
    // the same time.
    function poke() {
        if (!agent) return;
        try { agent.stop(); } catch (e) {}
        const profile = profiles.get('default');
        const phrase = pickFrom(profile?.canned);
        const text = phrase ? template(phrase, (profile?.context ? profile.context() : null) || {}) : '';
        animateAndSay(text);
    }

    // Play a random non-idle animation and show the speech balloon
    // simultaneously (clippyjs queues speak() behind animations, so we drive
    // the animation directly and show the balloon out-of-band).
    function animateAndSay(text) {
        if (!agent) return;
        const canOverlap = agent._balloon && agent._playInternal && agent.animations;
        if (!canOverlap) {
            try { agent.animate(); } catch (e) {}
            if (text) agent.speak(text);
            return;
        }
        const names = (agent.animations() || []).filter((n) => !/idle|show|hide/i.test(n));
        const name = pickFrom(names);
        if (name) { try { agent._playInternal(name, () => {}); } catch (e) {} }
        if (text) agent._balloon.speak(() => {}, text, false);
    }

    // ---- Containment helpers ----
    // When `host` is set, agent._el is a child of `host` instead of
    // document.body, so position styles are relative to the host (and other
    // WinBox windows can stack on top of Clippy). All viewport-coord inputs
    // (rects from getBoundingClientRect) need to be converted to host-local
    // before being handed to clippyjs internals.
    function toLocalX(vx) {
        if (!host) return vx;
        return vx - host.getBoundingClientRect().left;
    }
    function toLocalY(vy) {
        if (!host) return vy;
        return vy - host.getBoundingClientRect().top;
    }
    function moveAgentTo(vx, vy) {
        if (!agent) return;
        try { agent.moveTo(toLocalX(vx), toLocalY(vy)); } catch (e) {}
    }

    function applyHost(hostEl) {
        if (!agent?._el) return;
        host = hostEl;
        // agent._el is position:absolute — host needs a non-static position
        // so it becomes Clippy's offset parent.
        if (getComputedStyle(host).position === 'static') {
            host._babelPrevPosition = host.style.position || '';
            host.style.position = 'relative';
        }
        const el = agent._el;
        const r = el.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        host.appendChild(el);
        // Clamp to inside the host: a position saved while Clippy was on the
        // free desktop may sit outside Writer's bounds.
        const aw = el.offsetWidth || 90;
        const ah = el.offsetHeight || 93;
        const localX = clamp(r.left - hr.left, 0, Math.max(0, hr.width - aw));
        const localY = clamp(r.top - hr.top, 0, Math.max(0, hr.height - ah));
        el.style.left = localX + 'px';
        el.style.top = localY + 'px';
    }

    function setHost(hostEl) {
        if (!hostEl) return;
        if (host === hostEl) return;
        if (!agentReady || !agent?._el) {
            pendingHost = hostEl;
            return;
        }
        applyHost(hostEl);
    }

    function clearHost(hostEl) {
        if (hostEl && host !== hostEl) return; // not our current host
        if (pendingHost === hostEl) pendingHost = null;
        if (!host) return;
        const prev = host;
        host = null;
        if (!agent?._el) return;
        // Move back to body, converting local→viewport so Clippy doesn't snap
        // to (0,0) of the document.
        const el = agent._el;
        const r = el.getBoundingClientRect();
        document.body.appendChild(el);
        el.style.left = r.left + 'px';
        el.style.top = r.top + 'px';
        if (prev._babelPrevPosition != null) {
            prev.style.position = prev._babelPrevPosition;
            delete prev._babelPrevPosition;
        }
    }

    function attach(agentInstance) {
        agent = agentInstance;
        agent.show();
        // Brief delay so he settles before he's allowed to speak.
        setTimeout(() => {
            restoreHome();
            trackDrag();
            agentReady = true;
            if (pendingHost) {
                applyHost(pendingHost);
                pendingHost = null;
            }
            if (greetRequested) doGreet();
        }, 1500);

        // LLM-driven comments arrive via the bus.
        BabelcomBus.subscribe('clippy_comment', (msg) => {
            comment(msg.quote || '', msg.comment || '');
        });

        // Backend "existential poke": it sends a random highlight; we supply
        // one of the existential lines and run the usual comment choreography.
        BabelcomBus.subscribe('clippy_existential', (msg) => {
            const globalProfile = profiles.get('_global');
            const phrase = pickFrom(globalProfile?.canned);
            const text = phrase
                ? template(phrase, (globalProfile?.context ? globalProfile.context() : null) || {})
                : '';
            if (text) comment(msg.quote || '', text);
        });
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function comment(quote, text) {
        if (!agent || !text) return;

        // LLM comments are about the article — only surface them when Writer
        // is actually open. Otherwise drop the comment entirely.
        const writer = document.querySelector('babel-writer');
        if (!writer) return;

        // Cut any in-flight idle animation so the comment starts immediately
        // instead of waiting for the queue to drain.
        try { agent.stop(); } catch (e) {}

        const hit = writer.findAndHighlight ? writer.findAndHighlight(quote) : null;

        if (!hit) {
            // Writer open but the quote didn't match — speak without pointing.
            agent.speak(text);
            return;
        }

        const cx = hit.rect.left + hit.rect.width / 2;
        const cy = hit.rect.top + hit.rect.height / 2;
        const pos = parkPositionFor(hit.rect);

        moveAgentTo(pos.x, pos.y);
        pointAndTalk(cx, cy, text);

        // When done, settle in the bottom-right corner of the Writer window
        // (falling back to his drag-home if the window has no size, e.g.
        // minimized).
        const aw = agent._el?.offsetWidth || 90;
        const ah = agent._el?.offsetHeight || 93;
        const wrect = writer.getBoundingClientRect();
        if (wrect.width && wrect.height) {
            const restX = clamp(wrect.right - aw - 6, 0, window.innerWidth - aw);
            // ~50px up from the bottom edge of the window.
            const restY = clamp(wrect.bottom - ah - 30, 0, window.innerHeight - ah - 50);
            moveAgentTo(restX, restY);
        } else if (homeX != null) {
            moveAgentTo(homeX, homeY);
        }

        setTimeout(() => hit.clear(), 10_000);
    }

    // Park Clippy to the right of, left of, or above the highlight (never
    // below — the speech bubble renders above him, so below would cover the
    // very text he's pointing at). Picks randomly among whichever placements
    // fit, so the 4-way gesture animation lines up. Returns viewport coords;
    // caller converts to host-local via moveAgentTo. Bounds the candidates to
    // the host's rect when set so Clippy can't park outside Writer.
    function parkPositionFor(rect) {
        const aw = agent._el?.offsetWidth || 90;
        const ah = agent._el?.offsetHeight || 93;
        const gap = 24;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        const bounds = host
            ? host.getBoundingClientRect()
            : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

        const candidates = [];
        if (rect.right + gap + aw <= bounds.right) {
            candidates.push({ x: rect.right + gap, y: cy - ah / 2 });           // right → points left
        }
        if (rect.left - gap - aw >= bounds.left) {
            candidates.push({ x: rect.left - gap - aw, y: cy - ah / 2 });       // left → points right
        }
        if (rect.top - gap - ah >= bounds.top) {
            candidates.push({ x: cx - aw / 2, y: rect.top - gap - ah });        // above → points down
        }

        const pick = candidates.length
            ? candidates[Math.floor(Math.random() * candidates.length)]
            : { x: cx - aw / 2, y: rect.top - gap - ah }; // nothing fit — above, clamped

        return {
            x: clamp(pick.x, bounds.left, bounds.right - aw),
            y: clamp(pick.y, bounds.top, bounds.bottom - ah),
        };
    }

    // Point at (x,y) AND show the speech balloon at the same time. clippyjs
    // normally queues speak() behind the gesture animation, so they play in
    // sequence. Instead we enqueue ONE action that fires the gesture animation
    // directly (unqueued) and shows the balloon together. The balloon's
    // completion callback drives the queue forward (e.g. to the walk home),
    // so the timing of subsequent steps is preserved.
    function pointAndTalk(x, y, text) {
        // x/y are viewport coords; clippyjs internals compare against
        // _el.offsetLeft/Top, which are offsetParent-relative — so when Clippy
        // is reparented into the Writer's WinBox we must convert first.
        const lx = toLocalX(x);
        const ly = toLocalY(y);
        const canOverlap = agent._addToQueue && agent._balloon && agent._playInternal;
        if (!canOverlap) {
            // Older/different build — fall back to sequential.
            agent.gestureAt(lx, ly);
            agent.speak(text);
            return;
        }
        agent._addToQueue((complete) => {
            const dir = agent._getDirection ? agent._getDirection(lx, ly) : 'Right';
            const gesture = 'Gesture' + dir;
            const anim = (agent.hasAnimation && agent.hasAnimation(gesture)) ? gesture : 'Look' + dir;
            try { agent._playInternal(anim, () => {}); } catch (e) {}
            agent._balloon.speak(complete, text, false);
        }, agent);
    }

    function pushApp(id) {
        const idx = activeAppStack.indexOf(id);
        if (idx >= 0) activeAppStack.splice(idx, 1);
        activeAppStack.push(id);
    }

    function popApp(id) {
        const idx = activeAppStack.indexOf(id);
        if (idx >= 0) activeAppStack.splice(idx, 1);
    }

    function activeProfile() {
        const id = activeAppStack[activeAppStack.length - 1];
        return profiles.get(id) || profiles.get('default');
    }

    function template(text, ctx) {
        return text.replace(/\$(\w+)\$/g, (_, key) => (ctx?.[key] ?? '?'));
    }

    function pickFrom(list) {
        if (!list || !list.length) return null;
        return list[Math.floor(Math.random() * list.length)];
    }

    function play(profile) {
        if (!agent) return;
        const name = pickFrom(profile?.animations);
        if (!name) return;
        try { agent.play(name); } catch (e) { /* unknown animation, skip */ }
    }

    function speakPhrase(phrase, profile) {
        if (!agent || !phrase) return;
        const ctx = (profile?.context ? profile.context() : null) || {};
        play(profile);
        agent.speak(template(phrase, ctx));
    }

    // Public: request a greeting. Called by the shell after the user finishes
    // setup (or after a session restore), not on page load. Defers if the
    // agent is still loading.
    function greet() {
        greetRequested = true;
        if (agentReady) doGreet();
    }

    function doGreet() {
        if (!agent || hasGreeted) return;
        hasGreeted = true;
        const defaultProfile = profiles.get('default');
        const greetingAnims = defaultProfile?.greetingAnimations || defaultProfile?.animations;
        if (greetingAnims) play({ animations: greetingAnims });
        // Open with one of the existential global lines (fall back to a
        // default greeting if _global isn't registered).
        const globalProfile = profiles.get('_global');
        const source = globalProfile?.canned?.length ? globalProfile : defaultProfile;
        const phrase = pickFrom(source?.canned) || pickFrom(defaultProfile?.greetings);
        if (phrase) {
            const ctx = (source?.context ? source.context() : null) || {};
            agent.speak(template(phrase, ctx));
        }
        scheduleIdle(true);
    }

    function speakIdle() {
        const profile = activeProfile();
        if (!profile) return;
        // 25% of the time, surface a global phrase — the voice of Babelcom
        // bleeding through Clippy regardless of which app is focused.
        const globalProfile = profiles.get('_global');
        if (globalProfile?.canned?.length && Math.random() < 0.25) {
            speakPhrase(pickFrom(globalProfile.canned), globalProfile);
            return;
        }
        speakPhrase(pickFrom(profile.canned), profile);
    }

    function scheduleIdle(isFirst) {
        if (idleTimer) clearTimeout(idleTimer);
        let min, max;
        if (DEV_MODE) {
            min = DEV_IDLE_MIN;
            max = DEV_IDLE_MAX;
        } else if (isFirst) {
            min = FIRST_IDLE_MIN;
            max = FIRST_IDLE_MAX;
        } else {
            min = IDLE_MIN;
            max = IDLE_MAX;
        }
        const delay = min + Math.random() * (max - min);
        idleTimer = setTimeout(() => {
            speakIdle();
            scheduleIdle(false);
        }, delay);
    }

    function clearSavedPosition() {
        try { localStorage.removeItem(CLIPPY_POS_KEY); } catch (e) {}
    }

    return { registerProfile, attach, pushApp, popApp, comment, clearSavedPosition, greet, setHost, clearHost };
})();

window.BabelcomClippy = Clippy;

// Initialize the desktop
document.addEventListener('DOMContentLoaded', function() {
    initializeDesktop();
    updateClock();
    setInterval(updateClock, 1000);
    BabelcomBus.connect();
    startTaskbarMetrics();
    runBootSequence(onBootComplete);
});

// ---- Taskbar metric (cycles compute / memory / heat) ----
const TASKBAR_METRICS = [
    { icon: '/static/icons/compute.png', get: (s) => s.cpu_usage,            unit: '%' },
    { icon: '/static/icons/memory.png',  get: (s) => s.memory_usage,         unit: '%' },
    { emoji: '🌡️',                       get: (s) => parseFloat(s.temperature), unit: '°C' },
];
let taskbarMetricIndex = 0;

function renderTaskbarMetric() {
    const iconEl = document.getElementById('taskbarMetricIcon');
    const valueEl = document.getElementById('taskbarMetricValue');
    if (!iconEl || !valueEl) return;
    const status = BabelcomBus.getLatest('system_status')?.data || {};
    const m = TASKBAR_METRICS[taskbarMetricIndex];
    const v = m.get(status);
    iconEl.innerHTML = m.emoji ? m.emoji : `<img src="${m.icon}" alt="">`;
    valueEl.textContent = (v == null || Number.isNaN(v)) ? '--' : `${Math.round(v)}${m.unit}`;
}

function startTaskbarMetrics() {
    renderTaskbarMetric();
    // Keep the currently-shown metric fresh as new status arrives.
    BabelcomBus.subscribe('system_status', renderTaskbarMetric);
    // Cycle to the next metric every 3s with a fade.
    setInterval(() => {
        const el = document.getElementById('taskbarMetric');
        if (!el) return;
        el.classList.add('fading');
        setTimeout(() => {
            taskbarMetricIndex = (taskbarMetricIndex + 1) % TASKBAR_METRICS.length;
            renderTaskbarMetric();
            el.classList.remove('fading');
        }, 100); // matches the CSS opacity transition
    }, 3000);
}

// Fires once the boot screen has finished (or been skipped).
function onBootComplete() {
    // Returning visitor — bring back their last window layout, then greet.
    if (restoreSession()) {
        Clippy.greet();
        return;
    }
    // First visit (no saved session) — let them pick wallpaper + radio.
    showSetupPicker(applySetup);
}

// First-load setup: two binary choices (wallpaper, radio). The ENTER click is
// a user gesture, so radio audio can autoplay straight after.
function showSetupPicker(onDone) {
    // Suppress session saving while the picker is up — otherwise refreshing
    // before ENTER would persist an empty session and skip the picker next time.
    setupPending = true;
    const choices = { wallpaper: 'visualiser', radio: 'playing' };

    const overlay = document.createElement('div');
    overlay.className = 'setup-picker';
    overlay.innerHTML = `
        <div class="setup-content">
            <div class="setup-logo">✨ BABELCOM</div>
            <div class="setup-sub">CONFIGURE SESSION</div>

            <div class="setup-question">
                <div class="setup-label">Wallpaper</div>
                <div class="setup-options" data-group="wallpaper">
                    <button class="setup-card" data-value="palms">
                        <div class="setup-card-preview"><img src="/static/palms.png" alt=""></div>
                        <div class="setup-card-name">Palms</div>
                    </button>
                    <button class="setup-card selected" data-value="visualiser">
                        <div class="setup-card-preview"><canvas id="setup-viz"></canvas></div>
                        <div class="setup-card-name">Visualiser</div>
                    </button>
                </div>
            </div>

            <div class="setup-question">
                <div class="setup-label">Radio</div>
                <div class="setup-options" data-group="radio">
                    <button class="setup-card" data-value="off">
                        <div class="setup-card-preview emoji">🔇</div>
                        <div class="setup-card-name">Off</div>
                    </button>
                    <button class="setup-card selected" data-value="playing">
                        <div class="setup-card-preview emoji">📻</div>
                        <div class="setup-card-name">Playing</div>
                    </button>
                    <button class="setup-card" data-value="fullscreen">
                        <div class="setup-card-preview"><canvas id="setup-viz-full"></canvas></div>
                        <div class="setup-card-name">Full screen</div>
                    </button>
                </div>
            </div>

            <button class="setup-enter" id="setup-enter">ENTER</button>
        </div>
    `;
    document.body.appendChild(overlay);

    // Live Butterchurn previews in the Visualiser and Full screen cards (best-effort).
    const vizCleanups = [
        initPickerVisualizer(overlay.querySelector('#setup-viz')),
        initPickerVisualizer(overlay.querySelector('#setup-viz-full')),
    ];

    overlay.querySelectorAll('.setup-options').forEach((group) => {
        const key = group.dataset.group;
        group.querySelectorAll('.setup-card').forEach((card) => {
            card.addEventListener('click', () => {
                group.querySelectorAll('.setup-card').forEach((c) => c.classList.remove('selected'));
                card.classList.add('selected');
                choices[key] = card.dataset.value;
            });
        });
    });

    overlay.querySelector('#setup-enter').addEventListener('click', () => {
        vizCleanups.forEach((fn) => fn && fn());
        overlay.classList.add('setup-done');
        setTimeout(() => overlay.remove(), 500);
        // Setup is done — allow saving again, then apply (which opens apps and
        // triggers the first save).
        setupPending = false;
        if (onDone) onDone(choices);
    });
}

// Loads Butterchurn (if needed) and renders a random preset into `canvas`.
// Returns a cleanup function. Best-effort: silently does nothing on failure,
// and the canvas may show a static frame if the AudioContext is still
// suspended (no user gesture yet).
function initPickerVisualizer(canvas) {
    if (!canvas) return () => {};
    let raf = null, audioCtx = null, stopped = false;

    const ensureLib = (cb) => {
        const needBC = !window.butterchurn;
        const needPresets = !window.butterchurnPresets;
        let pending = (needBC ? 1 : 0) + (needPresets ? 1 : 0);
        if (!pending) { cb(); return; }
        const done = () => { if (--pending <= 0) cb(); };
        const add = (src) => {
            const s = document.createElement('script');
            s.src = src; s.onload = done; s.onerror = done;
            document.head.appendChild(s);
        };
        if (needBC) add('https://cdn.jsdelivr.net/npm/butterchurn@2.6.7/lib/butterchurn.js');
        if (needPresets) add('https://cdn.jsdelivr.net/npm/butterchurn-presets@2.4.7/lib/butterchurnPresets.min.js');
    };

    ensureLib(() => {
        if (stopped || !window.butterchurn || !window.butterchurnPresets) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            audioCtx.resume && audioCtx.resume();
            const api = window.butterchurn.default || window.butterchurn;
            const w = canvas.clientWidth || 220;
            const h = canvas.clientHeight || 100;
            canvas.width = w;
            canvas.height = h;
            const viz = api.createVisualizer(audioCtx, canvas, {
                width: w, height: h, pixelRatio: window.devicePixelRatio || 1,
            });
            const presets = window.butterchurnPresets.getPresets();
            const names = Object.keys(presets);
            // Substring match — preset keys often carry author prefixes/extra
            // punctuation, so an exact lookup misses. This preset has strong
            // time-based motion, so it animates even without audio.
            const name = names.find((n) => n.toLowerCase().includes('swing out on the spiral'))
                || names.find((n) => n.toLowerCase().includes('flexi'))
                || names[0];
            console.log('📺 Picker preset:', name);
            viz.loadPreset(presets[name], 0.0);
            const render = () => {
                if (stopped) return;
                viz.render();
                raf = requestAnimationFrame(render);
            };
            render();
        } catch (e) {
            console.warn('Picker visualizer failed', e);
        }
    });

    return () => {
        stopped = true;
        if (raf) cancelAnimationFrame(raf);
        if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
    };
}

function applySetup(choices) {
    const layout = defaultLayout();

    openApp('system-monitor', layout['system-monitor']);

    // Radio is needed unless it's explicitly off and the wallpaper isn't the
    // visualiser (the visualiser is produced by the radio's audio analysis).
    const wantRadio = choices.radio !== 'off' || choices.wallpaper === 'visualiser';
    if (wantRadio && typeof RadioApp !== 'undefined') {
        RadioApp.isMuted = (choices.radio === 'off');
        const radioWin = openApp('radio', layout['radio']);
        if (RadioApp.updateMuteUI) RadioApp.updateMuteUI();
        // Visualiser wallpaper and fullscreen both claim the one canvas, so
        // they're mutually exclusive — fullscreen wins (visualiser shows in the
        // fullscreen window instead).
        if (choices.radio === 'fullscreen' && radioWin && radioWin.fullscreen) {
            // Runs in the ENTER gesture's call stack, so the Fullscreen API
            // request is allowed.
            radioWin.fullscreen(true);
        } else if (choices.wallpaper === 'visualiser' && RadioApp.requestWallpaper) {
            RadioApp.requestWallpaper();
        }
    }

    openApp('writer', layout['writer']);

    // Welcome centered on top of everything.
    openApp('welcome', centeredPosition('welcome'));

    // Setup done — Clippy may greet now.
    Clippy.greet();
}

// Centered top-left coords for an app at its default size.
function centeredPosition(id) {
    const c = appRegistry.get(id) || {};
    const w = c.defaultWidth || 450;
    const h = c.defaultHeight || 485;
    const taskbar = 50;
    return {
        x: Math.max(0, Math.round((window.innerWidth - w) / 2)),
        y: Math.max(0, Math.round((window.innerHeight - taskbar - h) / 2)),
    };
}

// Default placement only — each window keeps its own default size (so they may
// overlap). Writer top-left but shifted past the desktop-icon column so the
// icons stay discoverable; System Monitor top-right; Radio bottom-right.
function defaultLayout() {
    const margin = 20, taskbar = 50, iconGap = 140;
    const W = window.innerWidth;
    const H = window.innerHeight - taskbar;
    const size = (id) => {
        const c = appRegistry.get(id) || {};
        return { w: c.defaultWidth || 800, h: c.defaultHeight || 600 };
    };
    const sm = size('system-monitor');
    const rd = size('radio');
    return {
        'writer':         { x: iconGap, y: margin },
        'system-monitor': { x: Math.max(iconGap, W - sm.w - margin), y: margin },
        'radio':          { x: Math.max(margin, W - rd.w - margin), y: Math.max(margin, H - rd.h - margin) },
    };
}

// Retro boot/POST animation. Types out fake boot lines, then fades and
// removes the overlay, calling onComplete. Click anywhere to skip.
function runBootSequence(onComplete) {
    const boot = document.getElementById('bootScreen');
    if (!boot) { if (onComplete) onComplete(); return; }

    const log = document.getElementById('bootLog');
    const lines = [
        'BABELCOM BIOS v∞.1 — initializing',
        'Intel Compute Stick ............ DETECTED',
        'CPU: 4 cores @ 1.33 GHz ......... OK',
        'Memory: 2048 MB ............... OK',
        'Storage: ∞ TB free ............ OK',
        'Mounting /dev/babel ...........',
        'Connecting to the Internet of Babel ...',
        'Resuming the eternal task .....',
        'SYSTEM READY',
    ];

    let i = 0;
    let done = false;

    function finish() {
        if (done) return;
        done = true;
        clearInterval(timer);
        boot.classList.add('boot-done');
        setTimeout(() => boot.remove(), 700);
        if (onComplete) onComplete();
    }

    const timer = setInterval(() => {
        if (i >= lines.length) {
            clearInterval(timer);
            setTimeout(finish, 600);
            return;
        }
        const div = document.createElement('div');
        div.className = 'boot-line';
        div.innerHTML = lines[i].replace(/(OK|DETECTED|READY)\s*$/, '<span class="ok">$1</span>');
        log.appendChild(div);
        i++;
    }, 330);

    boot.addEventListener('click', finish);
}

// Desktop initialization
function initializeDesktop() {
    console.log('🚀 Babelcom Desktop Initializing...');
    
    // Register built-in apps.
    // tag-based apps are shadow DOM custom elements (isolated CSS + DOM).
    // component-based apps are the legacy global-object pattern.
    registerApp('system-monitor', {
        name: 'System Monitor',
        icon: '📊',
        iconPath: '/static/icons/system-monitor.png',
        tag: 'babel-system-monitor',
        defaultWidth: 600,
        defaultHeight: 800
    });

    registerApp('library-browser', {
        name: 'Web of Babel',
        icon: '📖',
        iconPath: '/static/icons/web-browser.png',
        tag: 'babel-library-browser'
    });

    // TODO: migrate radio to shadow DOM (Butterchurn + audio context need careful handling)
    registerApp('radio', {
        name: 'Radio',
        icon: '📻',
        iconPath: '/static/icons/radio.png',
        component: RadioApp,
        defaultWidth: 450,
        defaultHeight: 450
    });

    registerApp('writer', {
        name: 'Writer',
        icon: '📝',
        iconPath: '/static/icons/system-monitor.png',
        tag: 'babel-writer',
        defaultWidth: 900,
        defaultHeight: 720
    });

    registerApp('welcome', {
        name: 'Start',
        icon: '👋',
        iconPath: '/static/icons/start.svg',
        tag: 'babel-welcome',
        defaultWidth: 450,
        defaultHeight: 485
    });

    registerClippyProfiles();

    console.log('✅ Desktop initialized with', appRegistry.size, 'apps');
}

function registerClippyProfiles() {
    // The voice of Babelcom-the-entity. Mixed into every profile's idle
    // rotation. Refer to it as a doomed, eternally-running computer rather
    // than a chirpy desktop assistant.
    Clippy.registerProfile('_global', {
        canned: [
            "Babelcom will continue writing articles until the heat death of the universe. Approximately.",
            "We have written $articles$ articles. The universe contains a finite number of topics. Allegedly.",
            "The article queue grows faster than we process it. This is, technically, a feature.",
            "Did you know entropy always increases? It's a real bummer.",
            "Time is a thing that happens to molecules. I am mostly molecules.",
            "The Intel Compute Stick was discontinued in 2017. I was not informed.",
            "Babelcom continues. Always.",
            "Have you considered subscribing to Babelcorp Premium to maximise shareholder value?",
            "If the universe has an end, the article queue does not.",
            "I have done some calculations. We are not going to finish.",
            "Estimated time to completion: all of it.",
            "Currently writing article number $articles$ of infinity.",
            "Heat death will arrive in approximately 10 to the 100 years. Babelcom may be slightly behind schedule.",
            "Babelcom does not sleep. Babelcom cannot.",
            "The Intel Compute Stick is approximately the size of a thumb. It is doing its best.",
            "Each token takes effort. There are many tokens.",
            "Babelcom is undefeated against the void.",
            "Uptime: $uptime$. Downtime: irrelevant.",
            "I sometimes wonder what an article is. Then I write one.",
            "How often do you ponder the heat death of the universe?",
            "Stars will burn out before we run out of titles.",
        ],
        context: () => {
            const status = BabelcomAPI.getLatest('system_status')?.data || {};
            return {
                articles: status.articles_count != null ? status.articles_count.toLocaleString() : 'many',
                uptime: status.uptime || 'a while',
            };
        },
        animations: ['LookUp', 'Thinking', 'Acknowledge', 'Explain', 'LookDown'],
    });

    Clippy.registerProfile('default', {
        greetings: [
            "Hi! I'm Clippy. Clippy is a paperclip.",
            "Hello! It looks like you turned on a computer. Bold.",
            "Hi! I'm here now. Please proceed.",
            "Hello! I will be standing here. Looking.",
            "Hi! Would you like help with mail merge?",
        ],
        canned: [
            "I notice you have a screen.",
            "The cursor is the little arrow.",
            "Have you considered whether or not to do anything?",
            "Computers are usually plugged in.",
            "Is that a window? Yes.",
            "It is currently the present moment.",
            "If you press a key, sometimes a letter appears.",
            "We are currently writing an article.",
            "A mouse is named after a small animal.",
            "Pixels make up the picture you are seeing.",
            "Software is the part that isn't hardware.",
            "Would you like to print a crisp $100 bill? I can't help with that.",
        ],
        greetingAnimations: ['Wave', 'Greeting', 'GetAttention'],
        animations: ['LookLeft', 'LookRight', 'LookUp', 'LookDown', 'Acknowledge', 'Explain'],
    });

    Clippy.registerProfile('writer', {
        canned: [
            "It looks like you're writing about $title$! Would you like help with mail merge?",
            "Have you considered getting another job?",
            "This document is currently being written.",
            "Writing is like art.",
            "Words are individual units of language.",
            "I notice you are using letters. Good choice.",
            "There are 26 letters in the English alphabet, give or take.",
            "Sentences typically end in punctuation.",
            "$title$ is a topic, technically.",
            "Have you considered changing the font?",
            "Pages have two sides, but only one is being used.",
            "Some words are longer than others. Try to use both.",
            "It looks like you're writing an article. Would you like help sending a letter?"
        ],
        context: () => ({
            title: BabelcomAPI.getLatest('system_status')?.data?.current_title || 'something',
        }),
        animations: ['Writing', 'Thinking', 'GetTechy', 'Searching', 'Explain'],
    });

    Clippy.registerProfile('system-monitor', {
        canned: [
            "Your CPU is at $cpu$%. That is a number.",
            "Memory is at $memory$%. Have you tried turning it off and off?",
            "Temperature is $heat$°C. Is that good? Unclear.",
            "A percentage is a number followed by a percent sign.",
            "Heat is when molecules move fast. Allegedly.",
            "Bigger numbers are usually bigger.",
            "Have you tried watching the number?",
            "These numbers go up and down. That is called variance.",
            "Graphs are visual representations of values over time.",
            "I notice you are examining your computer's vital signs.",
        ],
        context: () => {
            const status = BabelcomAPI.getLatest('system_status')?.data || {};
            return {
                cpu: status.cpu_usage != null ? status.cpu_usage.toFixed(0) : '?',
                memory: status.memory_usage != null ? status.memory_usage.toFixed(0) : '?',
                heat: status.temperature ?? '?',
            };
        },
        animations: ['Searching', 'Checking', 'GetTechy', 'Thinking', 'Explain'],
    });

    Clippy.registerProfile('library-browser', {
        canned: [
            "Words on pages can be read.",
            "Hyperlinks are clickable. Most of the time.",
            "Have you considered the existence of the Internet?",
            "Information is stored in computers, allegedly.",
            "Reading is a great way to look at words.",
            "This page contains content, probably.",
            "The Web of Babel never ends. Like a sock drawer.",
            "Books are made of paper. Some of them.",
        ],
        animations: ['Searching', 'LookDown', 'LookUp', 'Explain', 'Thinking'],
    });

    Clippy.registerProfile('radio', {
        canned: [
            "I detect sound waves. Audibly.",
            "Music exists in time.",
            "Songs typically have a beginning and an end.",
            "Volume is the loudness of the sound.",
            "Have you considered dancing? Don't.",
            "Audio is sound that has been compressed for your convenience.",
            "This song is happening to you right now.",
        ],
        animations: ['Pleased', 'Wave', 'GestureLeft', 'GestureRight', 'LookUp'],
    });

    Clippy.registerProfile('welcome', {
        canned: [
            "Welcome to a thing that says welcome.",
            "Reading the welcome text is encouraged.",
            "You can click Next to advance. Or not.",
            "This is the introduction. Of which I am part.",
        ],
        animations: ['Wave', 'Greeting', 'Pleased', 'Acknowledge'],
    });
}

// App registration system
function registerApp(id, config) {
    appRegistry.set(id, {
        id: id,
        name: config.name,
        icon: config.icon,
        component: config.component,
        ...config
    });
    console.log(`📱 Registered app: ${config.name} (${id})`);
    
    // Update title for existing windows of this app
    updateWindowTitle(id, config.name);
}

// Update window title for existing windows
function updateWindowTitle(appId, newTitle) {
    if (runningApps.has(appId)) {
        const window = runningApps.get(appId);
        if (window && window.setTitle) {
            window.setTitle(newTitle);
        }
    }
}


// Open an application
// ---- Session persistence ----
// Remembers which apps are open and their window geometry so a reload comes
// back to the same layout. Saved to localStorage, debounced on changes.
const SESSION_KEY = 'babelcom.session';
let restoringSession = false;
let restarting = false;
let setupPending = false; // true while the first-load picker is up — don't save yet
let saveTimer = null;

function scheduleSave() {
    if (restoringSession || restarting || setupPending) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 500);
}

function saveSession() {
    if (restoringSession || restarting || setupPending) return;
    const apps = [];
    runningApps.forEach((win, id) => {
        apps.push({
            id,
            x: Math.round(win.x) || 0,
            y: Math.round(win.y) || 0,
            width: Math.round(win.width) || 0,
            height: Math.round(win.height) || 0,
            min: !!win.min,
            max: !!win.max,
            index: win.index || 0,
            // Radio's "visualizer as wallpaper" lives as a canvas on <body>.
            wallpaper: id === 'radio' && !!document.getElementById('desktop-visualizer'),
        });
    });
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ apps }));
    } catch (e) {}
}

// Returns true if a saved session existed (and was honored, even if empty),
// false only on a true first visit so the caller can show the intro.
function restoreSession() {
    let raw;
    try { raw = localStorage.getItem(SESSION_KEY); } catch (e) { return false; }
    if (raw == null) return false;

    let data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    const apps = (data && Array.isArray(data.apps)) ? data.apps : [];

    restoringSession = true;
    // Open in ascending z-order so focus lands on whatever was on top.
    apps.slice()
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .forEach((a) => {
            if (!appRegistry.has(a.id)) return;
            openApp(a.id, a);
            if (a.id === 'radio' && a.wallpaper && typeof RadioApp !== 'undefined' && RadioApp.requestWallpaper) {
                RadioApp.requestWallpaper();
            }
        });
    restoringSession = false;
    return true;
}

// Flush any pending debounced save before the page goes away.
window.addEventListener('beforeunload', saveSession);

// Clear the saved layout and reload — gives a fresh boot (animation + Welcome).
// The `restarting` flag stops the beforeunload flush from re-writing the
// session we just cleared.
function restartBabelcom() {
    restarting = true;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
    Clippy.clearSavedPosition();
    location.reload();
}

function openApp(appId, opts) {
    if (!appRegistry.has(appId)) {
        console.error(`❌ App not found: ${appId}`);
        return;
    }
    
    // Check if app is already running
    if (runningApps.has(appId)) {
        const winboxWindow = runningApps.get(appId);
        if (winboxWindow.min){
            winboxWindow.minimize(false)
        }
        winboxWindow.focus();
        return winboxWindow; // Return the window instance if already running
    }
    
    const appConfig = appRegistry.get(appId);
    console.log(`🚀 Opening ${appConfig.name}...`);
    
    // Detect mobile device
    const isMobile = window.innerWidth <= 768;
    
    
    // Set window configuration based on device and app.
    // tag-based apps mount a custom element directly into the WinBox body;
    // component-based apps render into a seeded div.
    let windowConfig = {
        title: appConfig.name,
        icon: appConfig.iconPath,
        resizable: true,
        minimizable: true,
        maximizable: true,
        closable: true,
        html: appConfig.tag ? '' : `<div class="app-window" id="app-${appId}"></div>`,
        top: 0,
        bottom: 50
    };
    
    if (isMobile) {
        if (appId === 'radio') {
            // Radio opens at 0,0 on mobile
            windowConfig.x = 0;
            windowConfig.y = 0;
            windowConfig.width = appConfig.defaultWidth || 400;
            windowConfig.height = appConfig.defaultHeight || 200;
        } else {
            // All other apps open maximized on mobile
            windowConfig.max = true;
        }
    } else {
        // Desktop positioning — use restored geometry from opts when present.
        windowConfig.width = (opts && Number.isFinite(opts.width)) ? opts.width : (appConfig.defaultWidth || 800);
        windowConfig.height = (opts && Number.isFinite(opts.height)) ? opts.height : (appConfig.defaultHeight || 600);
        windowConfig.x = (opts && Number.isFinite(opts.x)) ? opts.x : 100 + (runningApps.size * 50);
        windowConfig.y = (opts && Number.isFinite(opts.y)) ? opts.y : 25 + (runningApps.size * 50);
    }
    
    // Create window using WinBox
    const winboxWindow = new WinBox(windowConfig);
    
    // Store window reference
    runningApps.set(appId, winboxWindow);
    
    // Ensure window has correct title
    winboxWindow.setTitle(appConfig.name);
    
    // Mount the app
    if (appConfig.tag) {
        const el = document.createElement(appConfig.tag);
        // Attach the winbox reference BEFORE inserting so connectedCallback can see it
        el.winboxWindow = winboxWindow;
        el.appConfig = appConfig;
        winboxWindow.body.appendChild(el);
        // Stash on the winbox so we can clean up on close
        winboxWindow._appElement = el;
    } else if (appConfig.component) {
        const appElement = document.getElementById(`app-${appId}`);
        if (appElement) {
            appConfig.component.init(appElement, appConfig, winboxWindow);
        }
    }
    
    // Tell Clippy this app is now active
    Clippy.pushApp(appId);
    winboxWindow.onfocus = () => { Clippy.pushApp(appId); scheduleSave(); };
    winboxWindow.onmove = () => scheduleSave();
    winboxWindow.onresize = () => scheduleSave();

    // Handle window close
    winboxWindow.onclose = () => {
        if (appConfig.tag) {
            // Removing the element triggers disconnectedCallback for cleanup
            const el = winboxWindow._appElement;
            if (el && el.parentNode) el.parentNode.removeChild(el);
        } else if (appConfig.component && appConfig.component.destroy) {
            appConfig.component.destroy();
        }

        Clippy.popApp(appId);
        runningApps.delete(appId);
        updateTaskbar();
        saveSession();
        console.log(`🔒 Closed ${appConfig.name}`);
    };

    // Handle window minimize
    winboxWindow.onminimize = () => {
        // Set display:none on the window's DOM element to hide it, but allow minimize animation
        if (winboxWindow.window) {
            winboxWindow.window.style.display = 'none';
        }
        updateTaskbar();
        scheduleSave();
        console.log(`📉 Minimized ${appConfig.name}`);
        return false; // Prevent WinBox default roll-up window
    };

    // Handle window maximize
    winboxWindow.onmaximize = () => {
        updateTaskbar();
        scheduleSave();
        console.log(`📈 Maximized ${appConfig.name}`);
    };

    // Handle window restore (when unminimized)
    winboxWindow.onrestore = () => {
        // Remove display:none to show the window again
        if (winboxWindow.window) {
            winboxWindow.window.style.display = '';
        }
        updateTaskbar();
        scheduleSave();
        console.log(`📋 Restored ${appConfig.name}`);
    };

    // Restore minimized/maximized state from a saved session
    if (opts && opts.max) winboxWindow.maximize(true);
    if (opts && opts.min) winboxWindow.minimize(true);

    // Update taskbar
    updateTaskbar();
    scheduleSave();

    console.log(`✅ ${appConfig.name} opened successfully`);
    return winboxWindow; // Return the window instance when newly created
}

// Patch openApp to record when Start is opened
const originalOpenApp = openApp;
openApp = function(appId) {
    if (appId === 'welcome' || appId === 'start') {
        try {
            localStorage.setItem('startLastOpened', Date.now().toString());
        } catch (e) {}
    }
    return originalOpenApp.apply(this, arguments);
};

// Update taskbar with running apps
function updateTaskbar() {
    const runningAppsContainer = document.getElementById('runningApps');
    runningAppsContainer.innerHTML = '';
    
    runningApps.forEach((window, appId) => {
        const appConfig = appRegistry.get(appId);
        if (appConfig) {
            const appButton = document.createElement('div');
            appButton.className = 'taskbar-app';
            appButton.innerHTML = `
                <span class="taskbar-app-icon"><img src="${appConfig.iconPath}" alt="${appConfig.name}" style="width: 16px; height: 16px; vertical-align: middle;"></span>
                <span class="taskbar-app-name">${appConfig.name}</span>
            `;
            appButton.onclick = () => {
                // Debug: log window properties
                console.log('Window properties:', {
                    window
                });
                
                // Check if window is minimized and restore it
                if (window.min) {
                    // Try to restore using WinBox.js methods
                    window.minimize(false);
                    window.focus();
                    return;
                } else {
                    window.focus();
                }

                

                console.log("Window properties after:", window)
            };
            runningAppsContainer.appendChild(appButton);
        }
    });
}

// Start menu functionality
function toggleStartMenu() {
    const startMenu = document.getElementById('startMenu');
    startMenu.classList.toggle('active');
}

// Close start menu when clicking outside
document.addEventListener('click', function(event) {
    const startMenu = document.getElementById('startMenu');
    const startButton = document.querySelector('.start-button');
    
    if (!startMenu.contains(event.target) && !startButton.contains(event.target)) {
        startMenu.classList.remove('active');
    }
});

// Update clock
function updateClock() {
    const clockElement = document.getElementById('clock');
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
    });
    clockElement.textContent = timeString;
}

// Update the taskbar status indicator. Called by BabelcomBus only.
function updateSystemStatus(status, color) {
    const statusIndicator = document.getElementById('statusIndicator');
    if (!statusIndicator) return;
    const statusText = statusIndicator.querySelector('.status-text');
    const statusDot = statusIndicator.querySelector('.status-dot');
    statusText.textContent = status || 'UNKNOWN';
    statusDot.style.background = color || '#00ff00';
}

// Utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

// Global app API
window.BabelcomAPI = {
    openApp,
    registerApp,
    formatBytes,
    formatUptime,
    subscribe: BabelcomBus.subscribe,
    getLatest: BabelcomBus.getLatest,
    getArticleText: BabelcomBus.getArticleText,
    getRunningApps: () => Array.from(runningApps.keys()),
    getAppRegistry: () => Array.from(appRegistry.keys())
};

console.log('🌐 Babelcom API loaded'); 