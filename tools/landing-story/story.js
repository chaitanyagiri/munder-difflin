<script>
/* ---- 0.5.3 story layer. Plain script, no library. Every effect is also fine without it: the text is all in the markup. ---- */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* the Stapler face, reused from the live disc for the video loader and the Pro drawing */
  var disc = $('#puckDisc');
  function copyFace(el, px) { if (el && disc && disc.firstChild) { el.innerHTML = disc.innerHTML; var d = el.firstChild; if (d && d.style) { d.style.width = px + 'px'; d.style.height = px + 'px'; } var s = el.querySelector('svg'); if (s) { s.setAttribute('width', px); s.setAttribute('height', px); } } }
  copyFace($('#vlFace'), 54); $$('.blobf').forEach(function (b) { copyFace(b, 46); });

  /* ---- the launch video: poster and a loader until it plays, muted preview, one press for sound from the top ---- */
  var v = $('#launchVideo'), load = $('#vload'), bar = $('#vlBar'), btn = $('#soundBtn'), screen = $('#screen'), withSound = false;
  if (v) {
    /* Phones load only the metadata until play() is called, so canplay never comes on its own: play is asked for
       straight away, and the loader gives way to the poster and the button whenever playback is refused or slow. */
    var ready = function () { load.classList.add('done'); btn.hidden = false; };
    var tryPlay = function () { if (withSound || reduce) return; var p; try { v.muted = true; p = v.play(); } catch (e) { ready(); return; } if (p && p.catch) p.catch(ready); };
    v.addEventListener('progress', function () { try { if (v.duration && v.buffered.length) bar.style.width = Math.max(8, Math.min(100, v.buffered.end(v.buffered.length - 1) / v.duration * 100)) + '%'; } catch (e) {} });
    v.addEventListener('playing', ready);
    v.addEventListener('canplay', function () { if (reduce) ready(); else if (v.paused) tryPlay(); });
    v.addEventListener('suspend', function () { if (v.paused && v.readyState < 3) ready(); });
    v.addEventListener('error', ready, true);
    if (reduce) ready(); else tryPlay();
    setTimeout(function () { if (v.paused || v.readyState < 3) ready(); }, 5000);
    btn.addEventListener('click', function () {
      withSound = true; v.muted = false; v.loop = false; v.controls = true;
      try { v.currentTime = 0; } catch (e) {}
      var p = v.play(); if (p && p.catch) p.catch(function () {}); screen.classList.add('playing-sound'); btn.hidden = true; load.classList.add('done');
    });
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (withSound) return; if (e.isIntersecting) tryPlay(); else v.pause(); });
    }, { threshold: 0.2 }).observe(v);
  }

  /* ---- reveal once, on entry ---- */
  function once(el, fn, opts) {
    if (!el) return;
    if (!('IntersectionObserver' in window) || reduce) { fn(el); return; }
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); fn(el); } }); }, opts || { threshold: 0.25 });
    io.observe(el);
  }
  $$('[data-rv]').forEach(function (el) { once(el, function (x) { x.classList.add('in'); }, { threshold: 0.15 }); });
  ['#pile', '#desks', '#roster', '#machine', '#tower'].forEach(function (s) { once($(s), function (x) { x.classList.add('in'); }); });

  /* counters */
  $$('[data-count]').forEach(function (el) {
    once(el, function () {
      var n = +el.getAttribute('data-count'), suf = el.getAttribute('data-suffix') || '', t0 = null;
      if (reduce) return;
      function step(t) { if (!t0) t0 = t; var k = Math.min(1, (t - t0) / 1100); el.textContent = Math.round(n * (1 - Math.pow(1 - k, 3))) + suf; if (k < 1) requestAnimationFrame(step); }
      requestAnimationFrame(step);
    });
  });

  /* the roster: rows light up in turn while it is on screen */
  var rows = $$('#roster .row'), ri = 0, rt = null;
  once($('#roster'), function () { if (reduce) { rows.forEach(function (r, i) { if (i % 2 === 0) r.classList.add('on'); }); return; } rt = setInterval(function () { rows.forEach(function (r) { r.classList.remove('on'); }); rows[ri % rows.length].classList.add('on'); rows[(ri + 2) % rows.length].classList.add('on'); ri++; }, 1300); });

  /* memory: the query types itself, then the cards land */
  var ms = $('#memsearch'), msq = $('#msq');
  once(ms, function () {
    var q = 'why did signup break?', i = 0;
    if (reduce) { msq.textContent = q; ms.classList.add('found'); return; }
    (function tick() { msq.textContent = q.slice(0, ++i); if (i < q.length) setTimeout(tick, 55 + Math.random() * 60); else setTimeout(function () { ms.classList.add('found'); }, 250); })();
  }, { threshold: 0.4 });

  /* the sealed log: the plain words unscramble when it scrolls in */
  once($('#wire'), function () {
    if (reduce) return;
    var glyphs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789+/=';
    $$('#wire .p').forEach(function (p, n) {
      var plain = p.getAttribute('data-plain'), f = 0, total = 26;
      p.classList.add('scr');
      setTimeout(function run() {
        f++;
        var out = ''; for (var i = 0; i < plain.length; i++) out += (plain[i] === ' ' || i < plain.length * f / total) ? plain[i] : glyphs[(Math.random() * glyphs.length) | 0];
        p.textContent = out;
        if (f < total) setTimeout(run, 40); else { p.textContent = plain; p.classList.remove('scr'); }
      }, n * 500);
    });
  }, { threshold: 0.35 });

  /* ---- the Stapler: the ring opens, and each action lights its button as its line crosses the middle of the screen ---- */
  var ring = $('#ring');
  function light(action) {
    if (!ring) return;
    if (!ring.classList.contains('in') && disc) disc.click();
    $$('.puck-btn', ring).forEach(function (b) { b.classList.toggle('hl', b.getAttribute('data-action') === action); });
  }
  if ('IntersectionObserver' in window) {
    var acts = $$('.act');
    var aio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { acts.forEach(function (a) { a.classList.toggle('on', a === e.target); }); setTimeout(function () { light(e.target.getAttribute('data-act')); }, ring && ring.classList.contains('in') ? 0 : 220); } });
    }, { rootMargin: '-45% 0px -45% 0px' });
    acts.forEach(function (a) { aio.observe(a); });
  }

  /* ---- the day clock and the hero screen tilt, one scroll handler ---- */
  var clock = $('#dayclock'), dcT = $('#dcTime'), dcL = $('#dcLabel'), dcB = $('#dcBar');
  var chaps = $$('[data-chapter]'), night = $('.afterhours'), ticking = false;
  var START = 8 * 60 + 59, END = 18 * 60;
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function frame() {
    ticking = false;
    var vh = window.innerHeight, y = window.scrollY, max = Math.max(1, document.documentElement.scrollHeight - vh);
    var ci = 0, mid = vh * 0.5, tops = chaps.map(function (c) { return c.getBoundingClientRect().top; });
    for (var i = 0; i < chaps.length; i++) if (tops[i] < mid) ci = i;
    var cur = chaps[ci], parts = (cur.getAttribute('data-chapter') || '').split('|');
    var tm = function (el) { var s = (el.getAttribute('data-chapter') || '08:59').split('|')[0].split(':'); return (+s[0]) * 60 + (+s[1]); };
    var t0 = tm(cur), t1 = ci + 1 < chaps.length ? tm(chaps[ci + 1]) : t0;
    var span = ci + 1 < chaps.length ? tops[ci + 1] - tops[ci] : 1, f = Math.max(0, Math.min(1, (mid - tops[ci]) / span));
    var k = y / max, mins = Math.round(t0 + (t1 - t0) * f);
    var hh = Math.floor(mins / 60), h12 = hh % 12 || 12;
    dcT.textContent = h12 + ':' + pad(mins % 60) + (hh < 12 ? ' AM' : ' PM');
    dcL.textContent = parts[1] || '';
    dcB.style.width = (k * 100).toFixed(1) + '%';
    clock.classList.toggle('on', y > vh * 0.35);
    clock.classList.toggle('dark', night && night.getBoundingClientRect().top < vh * 0.6);
    if (screen && !reduce && window.innerWidth > 640) {
      var r = screen.getBoundingClientRect(), p = Math.max(0, Math.min(1, (vh - r.top) / (vh * 0.9)));
      screen.style.transform = 'rotateX(' + (14 * (1 - p)).toFixed(2) + 'deg) scale(' + (0.94 + 0.06 * p).toFixed(3) + ')';
    }
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }, { passive: true });
  window.addEventListener('resize', frame);
  frame();
})();
</script>
