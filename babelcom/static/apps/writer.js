// Writer — shadow DOM custom element. Word 97 chrome (via 98.css), modern markdown body.

// Strip links from rendered markdown — render just the link text, no <a>.
// Handles both marked v9+ (token object) and older (positional args) signatures.
if (window.marked && !window.marked._babelcomLinksDisabled) {
    window.marked.use({
        renderer: {
            link(hrefOrToken, title, text) {
                if (hrefOrToken && typeof hrefOrToken === 'object') return hrefOrToken.text || '';
                return text || '';
            },
        },
    });
    window.marked._babelcomLinksDisabled = true;
}

const WRITER_FONTS = [
    { value: "'Times New Roman', serif", label: 'Times New Roman' },
    { value: 'Calibri, sans-serif', label: 'Calibri' },
    { value: 'Arial, sans-serif', label: 'Arial' },
    { value: "'Comic Sans MS', cursive", label: 'Comic Sans MS' },
    { value: "'Courier New', monospace", label: 'Courier New' },
    { value: 'Wingdings', label: 'Wingdings' },
];
const WRITER_SIZES = ['10pt', '12pt', '14pt', '18pt', '24pt'];

class BabelWriter extends HTMLElement {
    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
        this.unsubs = [];
        this.articleText = '';
        this.fontFamily = "'Times New Roman', serif";
        this.fontSize = '12pt';
        this.zoom = 1;
        this.docTitle = 'Untitled';
        this.bold = false;
        this.italic = false;
        this.underline = false;
        this.alignment = 'left';
        this.activeHighlight = null; // quote string while a Clippy highlight is live
        this.autoFollow = true;      // follow writing to the bottom until the user scrolls up
        this._ignoreScrollUntil = 0;
    }

    connectedCallback() {
        this.render();
        this.bindControls();
        this.applyTypography();

        // Hydrate from the bus's rolling buffer (server snapshot + any tokens
        // received while Writer was closed).
        this.articleText = BabelcomAPI.getArticleText() || '';
        this.renderArticle();
        // Show the most recent writing when opening mid-article.
        if (this.articleText) this.scrollTo('bottom');

        this.unsubs.push(BabelcomAPI.subscribe('token', (msg) => this.appendToken(msg.token)));
        this.unsubs.push(BabelcomAPI.subscribe('reset', () => this.reset()));
        this.unsubs.push(BabelcomAPI.subscribe('article_snapshot', (msg) => {
            this.articleText = typeof msg.text === 'string' ? msg.text : '';
            this.activeHighlight = null;
            this.autoFollow = true;
            this.renderArticle();
            this.scrollTo(this.articleText ? 'bottom' : 'top');
        }));
        this.unsubs.push(BabelcomAPI.subscribe('system_status', (msg) => this.updateTitle(msg.data)));

        const latest = BabelcomAPI.getLatest('system_status');
        if (latest && latest.data) this.updateTitle(latest.data);

        // Make Clippy live inside the Writer window. He'll be reparented under
        // this WinBox's body, so other apps stacked above Writer occlude him
        // and his pointing math is bounded by the window's rect.
        const wb = this.winboxWindow;
        if (wb?.body && window.BabelcomClippy?.setHost) {
            window.BabelcomClippy.setHost(wb.body);
        }
    }

    disconnectedCallback() {
        for (const u of this.unsubs) u();
        this.unsubs = [];
        if (this._renderFrame) {
            cancelAnimationFrame(this._renderFrame);
            this._renderFrame = null;
        }
        const wb = this.winboxWindow;
        if (wb?.body && window.BabelcomClippy?.clearHost) {
            window.BabelcomClippy.clearHost(wb.body);
        }
    }

    $(id) { return this.root.getElementById(id); }

    // Find `quote` in the rendered article and wrap it in <mark.clippy-target>.
    // Returns { mark, rect, clear } on success, or null. Tries exact match
    // first, then a case-insensitive whitespace-normalized fallback.
    findAndHighlight(quote) {
        if (!quote) return null;
        this.activeHighlight = quote;
        const mark = this._applyActiveHighlight();
        if (!mark) {
            // No match — clear it again so we don't re-scan the whole document
            // on every future renderArticle() looking for a quote that isn't here.
            this.activeHighlight = null;
            return null;
        }
        // Remember where the user was so we can return after the comment.
        // Guard against overwriting if a second comment lands before the first
        // clears — keep the earliest position.
        const scroll = this.$('page-scroll');
        if (!this._preHighlight) {
            this._preHighlight = { top: scroll ? scroll.scrollTop : 0, autoFollow: this.autoFollow };
        }
        // Pause following so incoming tokens don't scroll the highlight out of
        // view while Clippy is pointing at it.
        this.autoFollow = false;

        // Bring the highlight into view inside the page scroller so Clippy
        // ends up pointing at something the user can actually see. Instant
        // scroll so the rect we return reflects the final position, and flagged
        // (by time window) so the async scroll event doesn't trip the
        // user-scroll detector and wipe _preHighlight.
        this._ignoreScrollUntil = performance.now() + 200;
        try {
            mark.scrollIntoView({ block: 'center', behavior: 'instant' });
        } catch (e) {
            mark.scrollIntoView();
        }

        return {
            mark,
            rect: mark.getBoundingClientRect(),
            clear: () => this.clearHighlight(),
        };
    }

    clearHighlight() {
        this.activeHighlight = null;
        const existing = this.root.querySelector('mark.clippy-target');
        if (existing) {
            const parent = existing.parentNode;
            while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
            parent.removeChild(existing);
        }

        // Return to where the user was before Clippy scrolled to the highlight.
        if (this._preHighlight) {
            const pre = this._preHighlight;
            this._preHighlight = null;
            this.autoFollow = pre.autoFollow;
            // If they'd been following, resume at the (now further) bottom;
            // otherwise restore the exact reading position.
            if (pre.autoFollow) this.scrollToEnd();
            else this._setScrollTop(pre.top);
        }
    }

    // Wrap the active-highlight quote in the rendered DOM. Returns the
    // <mark> element on success, null otherwise. Called both directly when a
    // new comment arrives and after every renderArticle() so the highlight
    // survives the full-rerender churn.
    _applyActiveHighlight() {
        const quote = this.activeHighlight;
        if (!quote) return null;
        const content = this.$('page-content');
        if (!content) return null;

        // Cheap existence pre-check before any per-node DOM work. Read the
        // rendered text once and test for the quote with a single indexOf.
        // The common failure case — the LLM quoted something that isn't
        // verbatim in the article — bails here, instead of walking every
        // text node twice and allocating a normalized string per node.
        const fullText = content.textContent;
        const needle = quote.toLowerCase().replace(/\s+/g, ' ').trim();
        const hasExact = fullText.indexOf(quote) >= 0;
        const hasFuzzy = hasExact || fullText.toLowerCase().replace(/\s+/g, ' ').indexOf(needle) >= 0;
        if (!hasFuzzy) return null;

        const tryWrap = (matcher) => {
            const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const hit = matcher(node.textContent);
                if (hit) {
                    const range = document.createRange();
                    range.setStart(node, hit.start);
                    range.setEnd(node, hit.end);
                    const mark = document.createElement('mark');
                    mark.className = 'clippy-target';
                    try {
                        range.surroundContents(mark);
                        return mark;
                    } catch (e) { /* range crosses element boundaries — try next node */ }
                }
            }
            return null;
        };

        // Exact substring (only walk if the exact form is actually present)
        let mark = null;
        if (hasExact) {
            mark = tryWrap((text) => {
                const i = text.indexOf(quote);
                return i >= 0 ? { start: i, end: i + quote.length } : null;
            });
        }

        // Case-insensitive whitespace-collapsed fallback
        if (!mark) {
            mark = tryWrap((text) => {
                const hay = text.toLowerCase().replace(/\s+/g, ' ');
                const i = hay.indexOf(needle);
                return i >= 0 ? { start: i, end: i + needle.length } : null;
            });
        }

        return mark;
    }

    render() {
        const fontOptions = WRITER_FONTS
            .map((f) => `<option value="${f.value}"${f.value === this.fontFamily ? ' selected' : ''}>${f.label}</option>`)
            .join('');
        const sizeOptions = WRITER_SIZES
            .map((s) => `<option${s === this.fontSize ? ' selected' : ''}>${s}</option>`)
            .join('');

        this.root.innerHTML = `
            <link rel="stylesheet" href="https://unpkg.com/98.css">
            <style>
                :host {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    background: #c0c0c0;
                    color: #000;
                    font-family: 'Pixelated MS Sans Serif', 'MS Sans Serif', Tahoma, sans-serif;
                    font-size: 11px;
                }
                .doc-title-bar {
                    background: linear-gradient(90deg, #000080, #1084d0);
                    color: white;
                    font-weight: bold;
                    padding: 4px 8px;
                    font-size: 11px;
                    border-bottom: 1px solid #404040;
                }
                .toolbar {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 6px 8px;
                    background: #c0c0c0;
                    border-bottom: 1px solid #808080;
                    flex-wrap: wrap;
                }
                .toolbar button {
                    min-width: 38px;
                    min-height: 32px;
                    padding: 4px 10px;
                    font-size: 13px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    gap: 4px;
                }
                .toolbar button img {
                    width: 22px;
                    height: 22px;
                    display: block;
                    image-rendering: pixelated;
                }
                .toolbar button.active {
                    box-shadow:
                        inset -1px -1px 0 #fff,
                        inset 1px 1px 0 #0a0a0a,
                        inset -2px -2px 0 #dfdfdf,
                        inset 2px 2px 0 #808080;
                }
                .fmt-glyph {
                    display: inline-block;
                    width: 18px;
                    text-align: center;
                    font-family: 'Times New Roman', serif;
                    font-size: 18px;
                    line-height: 1;
                }
                .fmt-bold { font-weight: bold; }
                .fmt-italic { font-style: italic; font-family: 'Times New Roman', serif; }
                .fmt-underline { text-decoration: underline; }
                .align-svg {
                    display: block;
                    width: 18px;
                    height: 14px;
                    fill: currentColor;
                }
                .toolbar select { font-size: 12px; min-width: 140px; padding: 3px 4px; }
                .toolbar select[data-size] { min-width: 70px; }
                .toolbar .sep {
                    width: 1px;
                    height: 24px;
                    background: #808080;
                    box-shadow: 1px 0 0 #ffffff;
                    margin: 0 6px;
                }
                .toolbar .spacer { flex: 1; min-width: 8px; }
                .status-bar { flex-shrink: 0; }
                .status-bar p { margin: 0; }
                .status-bar .status-bar-field { padding: 2px 4px; }
                .status-bar .status-toggle {
                    color: #808080;
                    cursor: pointer;
                    user-select: none;
                    min-width: 26px;
                    text-align: center;
                    padding: 2px 3px;
                }
                .status-bar .status-toggle.active {
                    color: #000;
                    font-weight: bold;
                }
                .status-bar .status-fill { flex: 1; padding: 0; }

                .page-scroll {
                    flex: 1;
                    overflow: auto;
                    background: #808080;
                    padding: 24px 20px;
                    display: flex;
                    justify-content: center;
                    align-items: flex-start;
                }
                .page {
                    background: white;
                    color: black;
                    width: 8.5in;
                    min-height: 11in;
                    padding: 1in;
                    box-shadow: 2px 2px 8px rgba(0, 0, 0, 0.5);
                    box-sizing: border-box;
                    transform-origin: top center;
                    transition: transform 0.15s ease;
                }
                .page-content {
                    line-height: 1.5;
                    color: black;
                }
                .page-content h1, .page-content h2, .page-content h3, .page-content h4 {
                    font-family: inherit;
                    color: black;
                    border: none;
                    padding: 0;
                    text-shadow: none;
                    margin: 0.8em 0 0.4em;
                    font-weight: bold;
                }
                .page-content h1 { font-size: 1.8em; }
                .page-content h2 { font-size: 1.4em; }
                .page-content h3 { font-size: 1.15em; }
                .page-content p { margin: 0 0 0.8em; }
                .page-content ul, .page-content ol { padding-left: 2em; margin: 0 0 0.8em; }
                .page-content li { margin: 0.2em 0; }
                .page-content em { font-style: italic; }
                .page-content strong { font-weight: bold; }
                .page-content a { color: #0000ee; text-decoration: underline; }
                .page-content code {
                    background: #f0f0f0;
                    padding: 0 4px;
                    font-family: 'Courier New', monospace;
                }
                .page-content pre {
                    background: #f0f0f0;
                    padding: 8px;
                    overflow: auto;
                    font-family: 'Courier New', monospace;
                }
                .page-content blockquote {
                    margin: 0 0 0.8em;
                    padding-left: 1em;
                    border-left: 3px solid #c0c0c0;
                    color: #444;
                }
                .empty-doc {
                    color: #888;
                    font-style: italic;
                }
                mark.clippy-target {
                    background-color: #d8ff3d;
                    color: inherit;
                    padding: 0 1px;
                    border-radius: 1px;
                    text-decoration: none;
                    box-shadow: 0 0 0 1px rgba(168, 196, 0, 0.4);
                }
            </style>

            <div class="doc-title-bar" id="doc-title-bar">Document — Babelcorp Writer</div>

            <div class="toolbar">
                <button id="btn-save" title="Save"><img src="/static/icons/save.png" alt="Save"></button>
                <button id="btn-print" title="Print"><img src="/static/icons/print.png" alt="Print"></button>
                <div class="sep"></div>
                <select id="sel-font" title="Font">${fontOptions}</select>
                <select id="sel-size" data-size title="Size">${sizeOptions}</select>
                <div class="sep"></div>
                <button id="btn-bold" title="Bold"><span class="fmt-glyph fmt-bold">B</span></button>
                <button id="btn-italic" title="Italic"><span class="fmt-glyph fmt-italic">I</span></button>
                <button id="btn-underline" title="Underline"><span class="fmt-glyph fmt-underline">U</span></button>
                <div class="sep"></div>
                <button id="btn-align-left" title="Align Left"><svg class="align-svg" width="18" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="0" y="0" width="16" height="2" fill="#1a1a1a"/><rect x="0" y="4" width="10" height="2" fill="#1a1a1a"/><rect x="0" y="8" width="16" height="2" fill="#1a1a1a"/><rect x="0" y="12" width="10" height="2" fill="#1a1a1a"/></svg></button>
                <button id="btn-align-center" title="Center"><svg class="align-svg" width="18" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="0" y="0" width="16" height="2" fill="#1a1a1a"/><rect x="3" y="4" width="10" height="2" fill="#1a1a1a"/><rect x="0" y="8" width="16" height="2" fill="#1a1a1a"/><rect x="3" y="12" width="10" height="2" fill="#1a1a1a"/></svg></button>
                <button id="btn-align-right" title="Align Right"><svg class="align-svg" width="18" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="0" y="0" width="16" height="2" fill="#1a1a1a"/><rect x="6" y="4" width="10" height="2" fill="#1a1a1a"/><rect x="0" y="8" width="16" height="2" fill="#1a1a1a"/><rect x="6" y="12" width="10" height="2" fill="#1a1a1a"/></svg></button>
                <button id="btn-align-justify" title="Justify"><svg class="align-svg" width="18" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="0" y="0" width="16" height="2" fill="#1a1a1a"/><rect x="0" y="4" width="16" height="2" fill="#1a1a1a"/><rect x="0" y="8" width="16" height="2" fill="#1a1a1a"/><rect x="0" y="12" width="16" height="2" fill="#1a1a1a"/></svg></button>
                <div class="sep"></div>
                <button id="btn-zoom-out" title="Zoom Out"><img src="/static/icons/zoom.png" alt="Zoom"><span>−</span></button>
                <button id="btn-zoom-in" title="Zoom In"><img src="/static/icons/zoom.png" alt="Zoom"><span>+</span></button>
                <div class="spacer"></div>
            </div>

            <div class="page-scroll" id="page-scroll">
                <div class="page" id="page">
                    <div class="page-content" id="page-content">
                        <p class="empty-doc">Waiting for Babelcom to start writing&hellip;</p>
                    </div>
                </div>
            </div>

            <div class="status-bar">
                <p class="status-bar-field" id="status-page">Page 1 of 1</p>
                <p class="status-bar-field" id="status-words">Words: 0</p>
                <p class="status-bar-field" id="status-chars">Characters: 0</p>
                <p class="status-bar-field status-fill">&nbsp;</p>
                <p class="status-bar-field status-toggle" data-toggle="rec" title="Macro Recording">REC</p>
                <p class="status-bar-field status-toggle" data-toggle="trk" title="Track Changes">TRK</p>
                <p class="status-bar-field status-toggle" data-toggle="ext" title="Extend Selection">EXT</p>
                <p class="status-bar-field status-toggle" data-toggle="ovr" title="Overtype">OVR</p>
                <p class="status-bar-field status-toggle" data-toggle="wph" title="WordPerfect Help">WPH</p>
                <p class="status-bar-field">English (US)</p>
            </div>
        `;
    }

    bindControls() {
        this.$('page-scroll').addEventListener('scroll', () => this.onUserScroll());
        this.$('btn-save').addEventListener('click', () => this.save());
        this.$('btn-print').addEventListener('click', () => this.print());
        this.$('btn-zoom-in').addEventListener('click', () => this.setZoom(this.zoom + 0.1));
        this.$('btn-zoom-out').addEventListener('click', () => this.setZoom(this.zoom - 0.1));
        this.$('sel-font').addEventListener('change', (e) => {
            this.fontFamily = e.target.value;
            this.applyTypography();
        });
        this.$('sel-size').addEventListener('change', (e) => {
            this.fontSize = e.target.value;
            this.applyTypography();
        });

        // Doc-wide formatting toggles (apply to .page-content as a block)
        this.$('btn-bold').addEventListener('click', () => {
            this.bold = !this.bold;
            this.applyTypography();
        });
        this.$('btn-italic').addEventListener('click', () => {
            this.italic = !this.italic;
            this.applyTypography();
        });
        this.$('btn-underline').addEventListener('click', () => {
            this.underline = !this.underline;
            this.applyTypography();
        });
        for (const a of ['left', 'center', 'right', 'justify']) {
            this.$(`btn-align-${a}`).addEventListener('click', () => {
                this.alignment = a;
                this.applyTypography();
            });
        }

        // Status bar toggles look responsive but do nothing else — like Word.
        this.root.querySelectorAll('.status-toggle').forEach((el) => {
            el.addEventListener('click', () => el.classList.toggle('active'));
        });
    }

    applyTypography() {
        const content = this.$('page-content');
        if (!content) return;
        content.style.fontFamily = this.fontFamily;
        content.style.fontSize = this.fontSize;
        content.style.fontWeight = this.bold ? 'bold' : '';
        content.style.fontStyle = this.italic ? 'italic' : '';
        content.style.textDecoration = this.underline ? 'underline' : '';
        content.style.textAlign = this.alignment;

        this.$('btn-bold').classList.toggle('active', this.bold);
        this.$('btn-italic').classList.toggle('active', this.italic);
        this.$('btn-underline').classList.toggle('active', this.underline);
        for (const a of ['left', 'center', 'right', 'justify']) {
            this.$(`btn-align-${a}`).classList.toggle('active', this.alignment === a);
        }
    }

    setZoom(z) {
        this.zoom = Math.max(0.5, Math.min(2, Math.round(z * 10) / 10));
        this.$('page').style.transform = `scale(${this.zoom})`;
    }

    appendToken(token) {
        if (!token) return;
        this.articleText += token;
        // Tokens can arrive faster than we can re-parse + rebuild the DOM.
        // Coalesce into at most one render per animation frame so a burst of
        // tokens costs one render, not one render each (was O(n²) per article).
        this._scheduleRender();
    }

    _scheduleRender() {
        if (this._renderFrame) return;
        this._renderFrame = requestAnimationFrame(() => {
            this._renderFrame = null;
            this.renderArticle();
            this.scrollToEnd();
        });
    }

    reset() {
        this.articleText = '';
        this.activeHighlight = null;
        this.autoFollow = true;
        this.renderArticle();
        this.scrollTo('top');
    }

    renderArticle() {
        // Any pending coalesced render is now subsumed by this one.
        if (this._renderFrame) {
            cancelAnimationFrame(this._renderFrame);
            this._renderFrame = null;
        }
        const content = this.$('page-content');
        if (!content) return;

        if (!this.articleText) {
            content.innerHTML = '<p class="empty-doc">Waiting for Babelcom to start writing&hellip;</p>';
        } else {
            const html = window.marked
                ? window.marked.parse(this.articleText)
                : this.articleText.replace(/&/g, '&amp;').replace(/</g, '&lt;');
            content.innerHTML = html;
        }

        // Re-wrap the active highlight (if any) — innerHTML wipes it on every
        // token, so it has to be re-applied or it lives <1s.
        if (this.activeHighlight) this._applyActiveHighlight();

        this.updateStatusBar();
    }

    updateStatusBar() {
        const pageEl = this.$('page');
        if (!pageEl) return;

        // 11in × 96dpi = one "page" worth of vertical space. .page grows past
        // 11in as content stacks, so divide and ceil for the page count.
        const pages = Math.max(1, Math.ceil(pageEl.offsetHeight / (11 * 96)));
        const words = this.articleText.trim() ? this.articleText.trim().split(/\s+/).length : 0;
        const chars = this.articleText.length;

        this.$('status-page').textContent = `Page ${pages} of ${pages}`;
        this.$('status-words').textContent = `Words: ${words.toLocaleString()}`;
        this.$('status-chars').textContent = `Characters: ${chars.toLocaleString()}`;
    }

    // Programmatic scroll that the scroll listener ignores, so it doesn't get
    // mistaken for the user scrolling and flip autoFollow. Uses a short time
    // window rather than a flag-per-frame, because scroll events fire async
    // and can land a frame or two after the scroll is set.
    _setScrollTop(top) {
        const scroll = this.$('page-scroll');
        if (!scroll) return;
        this._ignoreScrollUntil = performance.now() + 200;
        scroll.scrollTop = top;
    }

    // scrollTop that keeps the bottom of the TEXT just inside the viewport.
    // The page is a fixed 11in sheet, so scrolling to scrollHeight would dive
    // into blank paper; we follow page-content's bottom instead. Returns 0
    // (top) when the article is shorter than the viewport.
    _followTarget() {
        const scroll = this.$('page-scroll');
        const content = this.$('page-content');
        if (!scroll || !content) return 0;
        const contentBottom =
            (content.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top) + scroll.scrollTop;
        return Math.max(0, contentBottom - scroll.clientHeight + 80); // 80px of paper below the last line
    }

    // Called on the page-scroll's scroll event. Only user scrolls reach here
    // (programmatic ones open a brief ignore window). Following resumes when
    // the user returns to (near) the text bottom, pauses when they scroll up.
    onUserScroll() {
        if (performance.now() < (this._ignoreScrollUntil || 0)) return;
        const scroll = this.$('page-scroll');
        if (!scroll) return;
        this.autoFollow = scroll.scrollTop >= this._followTarget() - 40;
        // User took manual control — don't yank them back after a Clippy comment.
        this._preHighlight = null;
    }

    scrollToEnd() {
        if (!this.autoFollow) return;
        this._setScrollTop(this._followTarget());
    }

    scrollTo(where) {
        this._setScrollTop(where === 'top' ? 0 : this._followTarget());
    }

    updateTitle(status) {
        if (!status) return;
        this.docTitle = status.current_title || 'Untitled';
        this.$('doc-title-bar').textContent = `${this.docTitle} — Babelcorp Writer`;
    }

    save() {
        const safe = (this.docTitle || 'document').replace(/[^\w\-_. ]/g, '_') || 'document';
        const blob = new Blob([this.articleText || ''], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safe}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    print() {
        const html = this.$('page-content').innerHTML;
        const title = this.docTitle || 'Document';
        const w = window.open('', '_blank', 'width=800,height=1000');
        if (!w) return;
        w.document.write(`
            <!doctype html>
            <html><head><meta charset="utf-8"><title>${title}</title>
            <style>
                @page { margin: 1in; }
                body {
                    font-family: ${this.fontFamily};
                    font-size: ${this.fontSize};
                    line-height: 1.5;
                    color: black;
                }
                h1, h2, h3, h4 { font-family: inherit; }
                code, pre { font-family: 'Courier New', monospace; background: #f0f0f0; padding: 0 4px; }
                pre { padding: 8px; }
                .empty-doc { display: none; }
            </style>
            </head><body>${html}</body></html>
        `);
        w.document.close();
        w.focus();
        setTimeout(() => { w.print(); }, 100);
    }
}

customElements.define('babel-writer', BabelWriter);
