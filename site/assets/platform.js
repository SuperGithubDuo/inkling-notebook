/**
 * Which installer to recommend, decided from what the browser reports. Pure functions, so
 * tests/unit/site-platform.test.ts can cover every case; the page (site/index.html) loads
 * this file as a plain script and reads window.InklingPlatform.
 *
 * Nothing here can pick a file that isn't one of the three verified installers: it only
 * chooses which of them to put first. When it isn't sure, it shows every option.
 */
(function (root) {
  'use strict';

  /** 'windows' | 'mac' | 'mobile' | 'other' from the user agent (iPads report a Mac UA but have touch). */
  function classifyOs(ua, maxTouchPoints) {
    ua = String(ua || '');
    var os = /Windows NT/.test(ua) ? 'windows' : /Macintosh|Mac OS X/.test(ua) ? 'mac' : 'other';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (os === 'mac' && Number(maxTouchPoints) > 1)) os = 'mobile';
    return os;
  }

  /**
   * 'arm' | 'intel' | 'unknown' for a Mac.
   * - renderer: WebGL's unmasked renderer string ('' when unavailable). It names the Apple chip
   *   ("Apple M1", or "ANGLE (Apple, ANGLE Metal Renderer: Apple M2 …)") even when the browser
   *   itself is an Intel build running under Rosetta, so it decides first.
   * - uaArch: User-Agent Client Hints architecture ('arm', 'x86' or '' when unavailable).
   *   An Intel (x86) browser on an Apple-silicon Mac reports 'x86', which is why it comes second.
   * Safari masks the renderer as "Apple GPU" and has no client hints: unknown, so both Macs are offered.
   */
  function macArch(opts) {
    opts = opts || {};
    var renderer = String(opts.renderer || '');
    var uaArch = String(opts.uaArch || '');
    if (/\bApple M\d/i.test(renderer)) return 'arm';
    if (uaArch === 'arm') return 'arm';
    if (uaArch === 'x86' && /Intel|AMD|Radeon/i.test(renderer)) return 'intel';
    if (uaArch === 'x86' && !renderer) return 'intel';
    return 'unknown';
  }

  /** The platform card to put first: 'windows' | 'macArm' | 'macIntel' | 'mac' (either Mac) | null (show all). */
  function recommend(os, arch) {
    if (os === 'windows') return 'windows';
    if (os === 'mac') return arch === 'arm' ? 'macArm' : arch === 'intel' ? 'macIntel' : 'mac';
    return null;
  }

  /** The file name to show in the Mac install steps: the recommended one, or both when it's unclear. */
  function macGuideFile(rec, downloads) {
    var arm = downloads && downloads.macArm && downloads.macArm.file;
    var intel = downloads && downloads.macIntel && downloads.macIntel.file;
    if (!arm || !intel) return null;
    if (rec === 'macArm') return arm;
    if (rec === 'macIntel') return intel;
    return arm + ' or ' + intel;
  }

  var api = { classifyOs: classifyOs, macArch: macArch, recommend: recommend, macGuideFile: macGuideFile };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InklingPlatform = api;
})(typeof window !== 'undefined' ? window : this);
