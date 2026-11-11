/**
 * Download page: puts the visitor's computer first. The page already lists the three verified
 * installers as plain links (written at build time by scripts/site/build-site.mjs); this script
 * only chooses which of those links becomes the big button, marks it, and opens the right install
 * steps after a download starts. It never builds a download link of its own: the big button reuses
 * the href of one of the three listed installers, and only if it is a release file of this repository.
 */
(function () {
  'use strict';
  var REPO = 'https://github.com/SuperGithubDuo/inkling-notebook/releases/download/';
  var P = window.InklingPlatform;
  function readJson(id, fallback) { try { return JSON.parse(document.getElementById(id).textContent); } catch (e) { return fallback; } }
  var release = readJson('inkling-release', { status: 'none' });
  var $ = function (id) { return document.getElementById(id); };
  var NAMES = { windows: 'Windows', macArm: 'Mac with Apple silicon', macIntel: 'Mac with Intel' };
  var EXT = { windows: '.exe', macArm: '.dmg', macIntel: '.dmg' };

  function listed(key) {
    var a = document.querySelector('.choice-link[data-platform="' + key + '"]');
    var href = a && a.getAttribute('href');
    return href && href.indexOf(REPO + release.tag + '/') === 0 && href.indexOf('..') < 0 ? href : null;
  }
  function mb(n) { return n > 0 ? Math.round(n / 1e6) + ' MB' : ''; }

  async function detect() {
    var os = P.classifyOs(navigator.userAgent, navigator.maxTouchPoints);
    var arch = 'unknown';
    if (os === 'mac') {
      var uaArch = '', renderer = '';
      try {
        var uad = navigator.userAgentData;
        if (uad && uad.getHighEntropyValues) uaArch = String((await uad.getHighEntropyValues(['architecture'])).architecture || '');
      } catch (e) {}
      try {
        var gl = document.createElement('canvas').getContext('webgl');
        var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      } catch (e) {}
      arch = P.macArch({ uaArch: uaArch, renderer: renderer });
    }
    return { os: os, arch: arch };
  }

  function openSteps(key) {
    var mac = key !== 'windows';
    var steps = $(mac ? 'install-mac' : 'install-windows');
    if (!steps) return;
    steps.open = true;
    var next = $('next');
    if (next) {
      next.textContent = 'Your download has started. When it finishes, follow the steps ' + (mac ? 'for a Mac' : 'for Windows') + ' below.';
      next.hidden = false;
    }
  }

  function render(env) {
    var available = release && release.status === 'available' && release.downloads;
    var rec = P.recommend(env.os, env.arch);

    if (env.os === 'mobile') {
      var phone = $('phone-note');
      if (phone) phone.hidden = false;
    }
    if (!available) return;

    // The Mac install step names the file this visitor needs, or both when unsure.
    var macFile = document.querySelector('[data-file="mac"]');
    var guide = P.macGuideFile(rec, release.downloads);
    if (macFile && guide) macFile.textContent = guide;

    // Mark the visitor's computer in the list. An unsure Mac gets both Macs and the "which Mac" help.
    var marked = rec === 'mac' ? ['macArm', 'macIntel'] : rec ? [rec] : [];
    marked.forEach(function (k, i) {
      var li = document.querySelector('.choice[data-platform="' + k + '"]');
      if (!li) return;
      li.classList.add('is-yours');
      if (i > 0) return;
      var tag = document.createElement('span');
      tag.className = 'yours';
      tag.textContent = marked.length > 1 ? 'your Mac is one of these two' : 'this computer';
      li.querySelector('.choice-name').appendChild(tag);
    });
    if (rec === 'mac') $('which-mac').open = true;

    // One big button, only when we know exactly which file this computer needs.
    if (rec === 'windows' || rec === 'macArm' || rec === 'macIntel') {
      var href = listed(rec);
      var d = release.downloads[rec];
      if (href && d) {
        var btn = $('primary-btn');
        btn.setAttribute('href', href);
        btn.setAttribute('data-platform', rec);
        $('primary-label').textContent = 'Download for ' + NAMES[rec];
        $('primary-size').textContent = EXT[rec] + ', ' + mb(d.size);
        $('primary').hidden = false;
        $('choose').textContent = 'Or choose another computer';
        document.body.classList.add('has-primary');
      }
    }
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-platform]');
    if (a && a.getAttribute('href')) openSteps(a.getAttribute('data-platform'));
  });

  var copy = $('copy-link');
  if (copy) copy.addEventListener('click', function () {
    var url = location.href.split('?')[0].split('#')[0];
    function done(t) { copy.textContent = t; }
    try { navigator.clipboard.writeText(url).then(function () { done('Link copied'); }, function () { done(url); }); } catch (e) { done(url); }
  });

  // A link to a folded section (#needs, #install-mac…) opens it.
  function openTarget() {
    var t = location.hash && document.getElementById(location.hash.slice(1));
    if (t && t.tagName === 'DETAILS') t.open = true;
  }
  window.addEventListener('hashchange', openTarget);
  openTarget();

  function ready() { document.documentElement.dataset.ready = '1'; }
  detect().then(render, function () { render({ os: 'other', arch: 'unknown' }); }).then(ready, ready);
})();
