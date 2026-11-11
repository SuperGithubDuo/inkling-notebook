/**
 * Homepage: the tutor's three-step switcher and the ink you can write on the hero with.
 * Without this script every step is shown in turn and the hero is simply a page.
 */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ------------------------------------------------------------ tutor steps (tabs)
  var tabs = Array.prototype.slice.call(document.querySelectorAll('#steps [role="tab"]'));
  function select(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }
  if (tabs.length) {
    document.getElementById('steps').classList.add('is-tabs');
    select(tabs[0], false);
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t, false); });
      t.addEventListener('keydown', function (e) {
        var to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        select(tabs[(to + tabs.length) % tabs.length], true);
      });
    });
  }

  // ------------------------------------------------------------ ink on the hero
  // Mouse and pen only: a finger on a phone scrolls the page as usual.
  var canvas = document.getElementById('ink');
  var hero = canvas && canvas.parentElement;
  if (!canvas || !hero || !canvas.getContext) return;
  var fine = window.matchMedia('(any-pointer: fine)');
  var hint = document.getElementById('ink-hint');
  if (hint && fine.matches) hint.hidden = false;

  var ctx = canvas.getContext('2d');
  var strokes = [];
  var current = null;
  var frame = 0;
  var HOLD = 1600;
  var FADE = 900;
  var color = getComputedStyle(document.documentElement).getPropertyValue('--color-display').trim();
  var dpr = 1;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var r = hero.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    strokes = [];
    current = null;
  }
  function point(e) {
    var r = canvas.getBoundingClientRect();
    var p = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    return [e.clientX - r.left, e.clientY - r.top, p];
  }
  function drawStroke(s, alpha) {
    var pts = s.points;
    if (!pts.length) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0] * dpr, pts[0][1] * dpr, 1.6 * dpr, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var m = i < pts.length - 1 ? [(b[0] + pts[i + 1][0]) / 2, (b[1] + pts[i + 1][1]) / 2] : b;
      ctx.lineWidth = (1.6 + b[2] * 2.4) * dpr;
      ctx.beginPath();
      ctx.moveTo(i === 1 ? a[0] * dpr : ((a[0] + b[0]) / 2) * dpr, i === 1 ? a[1] * dpr : ((a[1] + b[1]) / 2) * dpr);
      ctx.quadraticCurveTo(b[0] * dpr, b[1] * dpr, m[0] * dpr, m[1] * dpr);
      ctx.stroke();
    }
  }
  function paint(now) {
    frame = 0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes = strokes.filter(function (s) {
      if (s === current) { drawStroke(s, 1); return true; }
      var age = now - s.done;
      if (reduce.matches) {
        if (age > HOLD + FADE) return false;
        drawStroke(s, 1);
        return true;
      }
      var alpha = age < HOLD ? 1 : 1 - (age - HOLD) / FADE;
      if (alpha <= 0) return false;
      drawStroke(s, alpha);
      return true;
    });
    ctx.globalAlpha = 1;
    if (strokes.length) frame = requestAnimationFrame(paint);
  }
  function kick() { if (!frame) frame = requestAnimationFrame(paint); }

  hero.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    if (e.target.closest('a, button, input, label, figure')) return;
    e.preventDefault();
    current = { points: [point(e)], done: 0 };
    strokes.push(current);
    try { hero.setPointerCapture(e.pointerId); } catch (err) {}
    kick();
  });
  hero.addEventListener('pointermove', function (e) {
    if (!current) return;
    var events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (var i = 0; i < events.length; i++) current.points.push(point(events[i]));
    kick();
  });
  function end() {
    if (!current) return;
    current.done = performance.now();
    current = null;
    kick();
  }
  hero.addEventListener('pointerup', end);
  hero.addEventListener('pointercancel', end);
  hero.addEventListener('lostpointercapture', end);

  size();
  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(size, 150);
  });
})();
