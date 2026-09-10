/* Animal Stock — original flat-geometric animal art.
   Style: bauhaus-like construction from half-discs, discs and rounded bars —
   two or three flat colours per animal, no outlines, no gradients. These are
   ORIGINAL constructions drawn for this game (not copies of any reference
   set), with one dominant colour per species so counting works by colour,
   plus distinct silhouettes for colour-blind players. Hippo magenta is
   reserved for manager UI. */
(function () {
  const C = {
    toucan: "#E86A1C", toucanInk: "#26241E", toucanCream: "#F1E4C8",
    fox: "#DE5F1E", foxDark: "#B23A12", foxCream: "#F6E7C6", foxLegs: "#4A2E18",
    leopard: "#EFB92A", leopardSpot: "#4A3418", leopardCream: "#F8ECD2",
    elephant: "#5C6675", elephantDark: "#333945", elephantCream: "#F1E4C8",
    hippo: "#FF3B5C", hippoDark: "#B3123F", hippoCream: "#FFF1F3",
    back: "#3E4A5A", backCream: "#F1E4C8", ink: "#22303C", paper: "#FFFDF6",
  };
  // each Hippo sibling gets its own colour so its function reads at a glance:
  // Bo = crimson (cancels), Pip = violet (fox-foe), Dozy = sleepy grey (harmless)
  const HIPPO_C = {
    bo:   { main: "#E63A6B", dark: "#A91E47", cream: "#FFF1F3" },
    pip:  { main: "#8E44CC", dark: "#5E2E99", cream: "#FFF1F3" },
    dozy: { main: "#9AA7B5", dark: "#6B7885", cream: "#F4F7F9" },
  };
  window.ANIMAL_COLORS = C;
  window.HIPPO_COLORS = HIPPO_C;

  function svgOpen(s) { return `<svg viewBox="0 0 100 100" width="${s}" height="${s}" aria-hidden="true">`; }

  function toucan() {
    return `<path d="M22,74 L8,90 L28,86 Z" fill="${C.toucanInk}"/>` +
      `<path d="M46,12 A38,38 0 0 0 46,88 Z" fill="${C.toucanInk}"/>` +
      `<path d="M46,28 A21,21 0 0 1 46,70 Z" fill="${C.toucan}"/>` +
      `<path d="M46,44 A11,11 0 0 0 46,66 Z" fill="${C.toucanCream}"/>` +
      `<circle cx="31" cy="42" r="3.6" fill="${C.toucanCream}"/>` +
      `<rect x="30" y="88" width="16" height="5" rx="2.5" fill="${C.toucan}"/>`;
  }

  function fox() {
    return `<path d="M30,68 L8,42 L36,54 Z" fill="${C.fox}"/>` +
      `<path d="M8,42 L18,36 L26,48 Z" fill="${C.foxCream}"/>` +
      `<rect x="34" y="70" width="8" height="15" rx="4" fill="${C.foxLegs}"/>` +
      `<rect x="56" y="70" width="8" height="15" rx="4" fill="${C.foxLegs}"/>` +
      `<rect x="28" y="52" width="42" height="20" rx="10" fill="${C.fox}"/>` +
      `<path d="M61,36 L63,24 L71,33 Z" fill="${C.foxDark}"/>` +
      `<path d="M71,33 L79,23 L79,37 Z" fill="${C.foxDark}"/>` +
      `<circle cx="70" cy="45" r="13" fill="${C.fox}"/>` +
      `<circle cx="76" cy="50" r="5" fill="${C.foxCream}"/>` +
      `<circle cx="70" cy="43" r="2.2" fill="${C.ink}"/>`;
  }

  function leopard() {
    const spots = [[34, 56], [44, 61], [54, 56], [62, 61], [38, 52], [50, 52]]
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6" fill="${C.leopardSpot}"/>`).join("");
    return `<path d="M26,58 C14,56 12,42 19,34 C21,46 25,50 32,52 Z" fill="${C.leopard}"/>` +
      `<rect x="30" y="68" width="8" height="15" rx="4" fill="${C.leopard}"/>` +
      `<rect x="54" y="68" width="8" height="15" rx="4" fill="${C.leopard}"/>` +
      `<rect x="24" y="50" width="44" height="20" rx="10" fill="${C.leopard}"/>` +
      `<circle cx="62" cy="33" r="4" fill="${C.leopard}"/>` +
      `<circle cx="74" cy="32" r="4" fill="${C.leopard}"/>` +
      `<circle cx="70" cy="43" r="12" fill="${C.leopard}"/>` +
      spots +
      `<circle cx="77" cy="47" r="4.5" fill="${C.leopardCream}"/>` +
      `<circle cx="70" cy="41" r="2.2" fill="${C.ink}"/>`;
  }

  function elephant() {
    return `<path d="M20,50 L12,58 L18,62 Z" fill="${C.elephantDark}"/>` +
      `<rect x="28" y="68" width="10" height="17" rx="5" fill="${C.elephantDark}"/>` +
      `<rect x="50" y="68" width="10" height="17" rx="5" fill="${C.elephantDark}"/>` +
      `<rect x="20" y="42" width="48" height="30" rx="15" fill="${C.elephant}"/>` +
      `<circle cx="66" cy="50" r="16" fill="${C.elephant}"/>` +
      `<path d="M60,36 A14,14 0 0 0 60,64 Z" fill="${C.elephantDark}"/>` +
      `<path d="M74,56 C74,70 69,77 61,78 L61,70 C66,69 66,64 66,56 Z" fill="${C.elephantDark}"/>` +
      `<path d="M78,58 L86,62 L78,66 Z" fill="${C.elephantCream}"/>` +
      `<circle cx="66" cy="45" r="2.6" fill="${C.elephantCream}"/>`;
  }

  function hippo(which) {
    const P = HIPPO_C[which] || { main: C.hippo, dark: C.hippoDark, cream: C.hippoCream };
    return `<rect x="24" y="70" width="9" height="14" rx="4.5" fill="${P.dark}"/>` +
      `<rect x="50" y="70" width="9" height="14" rx="4.5" fill="${P.dark}"/>` +
      `<rect x="14" y="48" width="56" height="24" rx="12" fill="${P.main}"/>` +
      `<circle cx="58" cy="39" r="4.5" fill="${P.dark}"/>` +
      `<circle cx="70" cy="37" r="4.5" fill="${P.dark}"/>` +
      `<circle cx="68" cy="52" r="15" fill="${P.main}"/>` +
      `<ellipse cx="72" cy="58" rx="10" ry="7" fill="${P.cream}"/>` +
      `<circle cx="69" cy="58" r="1.8" fill="${C.ink}"/>` +
      `<circle cx="75" cy="58" r="1.8" fill="${C.ink}"/>` +
      `<circle cx="63" cy="47" r="2.6" fill="${P.dark}"/>`;
  }

  function back() {
    return `<rect x="8" y="8" width="84" height="84" rx="16" fill="${C.back}"/>` +
      `<path d="M50,30 A20,20 0 0 1 50,70 Z" fill="${C.backCream}"/>` +
      `<circle cx="50" cy="50" r="7" fill="${C.hippo}"/>`;
  }

  function shape(animal, s, variant) {
    s = s || 48;
    let inner = "";
    if (animal === "toucan") inner = toucan();
    else if (animal === "fox") inner = fox();
    else if (animal === "leopard") inner = leopard();
    else if (animal === "elephant") inner = elephant();
    else if (animal === "hippo") inner = hippo(variant);
    else inner = back();
    return svgOpen(s) + inner + `</svg>`;
  }

  function icon(animal, count, size) {
    // dominant colour per species for at-a-glance counting
    const dom = { toucan: C.toucan, fox: C.fox, leopard: C.leopard, elephant: C.elephant, hippo: C.hippo }[animal] || "#888";
    let out = `<span class="anicons" style="--c:${dom}">`;
    for (let i = 0; i < count; i++) out += shape(animal, size || 26);
    return out + `</span>`;
  }

  window.AnimalArt = { shape, icon, C };
})();
