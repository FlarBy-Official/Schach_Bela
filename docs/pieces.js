// Selbst gezeichnete Figuren (SVG). Weiß = hell, Schwarz = dunkel.
(function (root) {
  const body = {
    P: `<path d="M22.5 9a5.5 5.5 0 0 0-3.3 9.9C16.2 20.600 14 24 14 28.500c0 1.500.4 2.600 1 3.500h-1.500a2 2 0 0 0-2 2v2.500h22V34a2 2 0 0 0-2-2H30c.6-.9 1-2 1-3.500 0-4.500-2.200-7.900-5.200-9.600A5.500 5.500 0 0 0 22.500 9z"/>`,
    R: `<path d="M10 36h25v-3.500H10zM12.500 32.500h20V29l-2-2V17.500h-16V27l-2 2zM11 17.500V10h4v3h4v-3h7v3h4v-3h4v7.500z"/>`,
    N: `<path d="M12 36h24v-3.500c0-5-1.500-9-1.500-12.500C34.500 12 28 8 20 8l-1.500-2.500-2 2.500c-1.500 1-2.500 3-2.500 5.500l-6 7.500 3 2.500 4-3.500 2.500 1c-2.500 3-6 4.500-6 11.500z"/><circle cx="18" cy="14" r="1.300" class="eye"/>`,
    B: `<path d="M12 36h21v-2.500c0-1.500-1-2.500-2.500-2.500h-16c-1.500 0-2.500 1-2.500 2.500zM15 31c0-5 2-6.500 3-9.500-3-2-4.500-5-4.500-8.500 0-5 4-8.500 9-8.500s9 3.500 9 8.500c0 3.500-1.500 6.500-4.500 8.500 1 3 3 4.500 3 9.500z"/><path d="M22.500 7v8M19 11h7" class="line"/>`,
    Q: `<path d="M10 36h25v-3c0-1.500-1-2.500-2.500-2.500h-20C11 30.500 10 31.500 10 33zM12 30.500 8.500 14l7 8 3-11 4 10.500 4-10.500 3 11 7-8-3.500 16.500z"/><circle cx="8.500" cy="12.500" r="2.200"/><circle cx="16" cy="9" r="2.200"/><circle cx="22.500" cy="8" r="2.200"/><circle cx="29" cy="9" r="2.200"/><circle cx="36.500" cy="12.500" r="2.200"/>`,
    K: `<path d="M10 36h25v-3c0-1.500-1-2.500-2.500-2.500h-20C11 30.500 10 31.500 10 33zM12.500 30.500c-3-3-5-6-5-9.500 0-4 3-6.500 7-6.500 3 0 5.500 1.500 7.500 4.500 2-3 4.500-4.500 7.500-4.500 4 0 7 2.500 7 6.500 0 3.500-2 6.500-5 9.500z"/><path d="M22.500 14.500V5M18.500 8.500h8" class="line"/>`,
  };

  function svg(piece) {
    const c = piece[0], t = piece[1];
    const fill = c === 'w' ? '#f7f2e6' : '#2b2622';
    const stroke = c === 'w' ? '#3a342c' : '#0b0908';
    const detail = c === 'w' ? '#3a342c' : '#e8dfcc';
    return `<svg viewBox="0 0 45 45" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g fill="${fill}" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${body[t]}</g>
      <style>.line{fill:none;stroke:${t === 'K' ? stroke : detail};stroke-width:2.200}.eye{fill:${detail};stroke:none}</style>
    </svg>`;
  }

  // Anfangsbuchstabe auf Deutsch: Bauer, Turm, Springer, Läufer, Dame, König
  const LETTER = { P: 'B', R: 'T', N: 'S', B: 'L', Q: 'D', K: 'K' };
  const NAMES = { P: 'Bauer', R: 'Turm', N: 'Springer', B: 'Läufer', Q: 'Dame', K: 'König' };

  root.Pieces = { svg, LETTER, NAMES };
})(window);
