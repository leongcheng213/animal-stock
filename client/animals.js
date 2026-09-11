/* Animal Stock — original flat-geometric animal art.
   Style: bauhaus-like construction from half-discs, discs and rounded bars —
   two or three flat colours per animal, no outlines, no gradients. These are
   ORIGINAL constructions drawn for this game (not copies of any reference
   set), with one dominant colour per species so counting works by colour,
   plus distinct silhouettes for colour-blind players. Hippo magenta is
   reserved for manager UI.

   Every icon also renders at 26px on the order board, so each species is
   built to survive being tiny: one strong colour, one unmistakable
   silhouette (long/low, tall-necked, maned disc, big beak). */
(function () {
  const C = {
    toucan: "#F2A81D", toucanTip: "#E2621B", toucanInk: "#26241E",
    toucanCream: "#F4EFE2", toucanTail: "#4A5058",

    // zebra's pale coat is deliberately a shade darker than the card it sits
    // on (--card #FFFDF6) — a true white body would have no visible edge
    zebra: "#33322E", zebraCream: "#E7E0D1", zebraInk: "#26241E",

    croc: "#62A83C", crocDark: "#2F6B2A", crocLight: "#8CC85A",
    crocCream: "#F4EFE2",

    lion: "#F2B01D", lionMane: "#E2621B", lionLight: "#FBC33A",
    lionCream: "#FBE7B0",

    monkey: "#A9773F", monkeyDark: "#96683A", monkeyEar: "#E4C49C",
    monkeyInner: "#D3A188", monkeyFace: "#F2E2C2", monkeyHand: "#F7E7C8",
    monkeyHandDark: "#EEDCBB", monkeyLine: "#D9BE95", monkeyMouth: "#8E1B3A",

    bell: "#F9C51A", bellOrange: "#EE7A22", bellShade: "#D2601A",
    bellClap: "#A5713C", bellClapDark: "#7C5227",

    hippo: "#FF3B5C", hippoDark: "#B3123F", hippoCream: "#FFF1F3",
    back: "#3E4A5A", backCream: "#F1E4C8", ink: "#22303C", paper: "#FFFDF6",
  };
  // each Hippo sibling gets its own colour so its function reads at a glance:
  // Bo = crimson (cancels), Pip = violet (zebra-foe), Dozy = sleepy grey (harmless)
  const HIPPO_C = {
    bo:   { main: "#E63A6B", dark: "#A91E47", cream: "#FFF1F3" },
    pip:  { main: "#8E44CC", dark: "#5E2E99", cream: "#FFF1F3" },
    dozy: { main: "#9AA7B5", dark: "#6B7885", cream: "#F4F7F9" },
  };
  window.ANIMAL_COLORS = C;
  window.HIPPO_COLORS = HIPPO_C;

  function svgOpen(s) { return `<svg viewBox="0 0 100 100" width="${s}" height="${s}" aria-hidden="true">`; }

  // black body, cream face, big two-tone beak — the beak is the whole read.
  // The beak starts clear of the cream half-disc so the face stays visible.
  function toucan() {
    return `<path d="M26,74 L8,90 L30,84 Z" fill="${C.toucanTail}"/>` +
      `<circle cx="40" cy="60" r="25" fill="${C.toucanInk}"/>` +
      `<circle cx="54" cy="40" r="20" fill="${C.toucanInk}"/>` +
      `<path d="M54,22 A18,18 0 0 1 54,58 Z" fill="${C.toucanCream}"/>` +
      `<path d="M69,30 L96,33 L78,48 L69,45 Z" fill="${C.toucan}"/>` +
      `<path d="M88,32 L96,33 L81,45 Z" fill="${C.toucanTip}"/>` +
      `<circle cx="58" cy="34" r="2.8" fill="${C.toucanInk}"/>` +
      `<rect x="36" y="82" width="14" height="5" rx="2.5" fill="${C.toucanInk}"/>`;
  }

  // striped barrel on an angled neck: the only tall silhouette among the four.
  // Skull + muzzle are one continuous run of shapes so the head never reads as
  // a detached blob at icon size.
  function zebra() {
    const stripe = (x, w) =>
      `<rect x="${x}" y="48" width="${w}" height="22" rx="2" fill="${C.zebra}"/>`;
    return `<path d="M16,52 L5,45 L7,65 Z" fill="${C.zebra}"/>` +
      `<rect x="26" y="66" width="9" height="19" rx="3" fill="${C.zebraCream}"/>` +
      `<rect x="50" y="66" width="9" height="19" rx="3" fill="${C.zebraCream}"/>` +
      `<rect x="26" y="79" width="9" height="6" rx="2" fill="${C.zebraInk}"/>` +
      `<rect x="50" y="79" width="9" height="6" rx="2" fill="${C.zebraInk}"/>` +
      `<rect x="16" y="48" width="50" height="22" rx="11" fill="${C.zebraCream}"/>` +
      stripe(27, 6) + stripe(39, 6) + stripe(51, 5) +
      `<path d="M52,58 L62,26 L74,30 L64,62 Z" fill="${C.zebraCream}"/>` +
      `<path d="M58,24 L70,28 L66,40 L54,36 Z" fill="${C.zebra}"/>` +
      `<circle cx="72" cy="31" r="11" fill="${C.zebraCream}"/>` +
      `<path d="M66,20 L70,9 L76,21 Z" fill="${C.zebra}"/>` +
      `<rect x="72" y="26" width="24" height="13" rx="6.5" fill="${C.zebraCream}"/>` +
      `<rect x="88" y="28" width="8" height="9" rx="4" fill="${C.zebra}"/>` +
      `<circle cx="76" cy="29" r="2.4" fill="${C.zebraInk}"/>`;
  }

  // long and low with a ridged back — nothing else in the set is this shape
  function crocodile() {
    const teeth = `<rect x="70" y="53" width="26" height="2.6" rx="1.3" fill="${C.crocCream}"/>`;
    return `<path d="M8,56 L24,46 L24,64 Z" fill="${C.crocDark}"/>` +
      `<path d="M20,46 l5,-6 l5,6 l5,-6 l5,6 l5,-6 l5,6 l5,-6 l5,6 Z" fill="${C.crocDark}"/>` +
      `<rect x="24" y="60" width="10" height="12" rx="4" fill="${C.crocLight}"/>` +
      `<rect x="48" y="60" width="10" height="12" rx="4" fill="${C.crocLight}"/>` +
      `<rect x="18" y="46" width="48" height="17" rx="8" fill="${C.croc}"/>` +
      `<rect x="56" y="45" width="20" height="15" rx="7" fill="${C.croc}"/>` +
      `<rect x="66" y="48" width="30" height="10" rx="5" fill="${C.croc}"/>` +
      teeth +
      `<circle cx="62" cy="43" r="4" fill="${C.croc}"/>` +
      `<circle cx="62" cy="42" r="2" fill="${C.crocDark}"/>`;
  }

  // gold body behind a big orange mane disc — the only radial silhouette
  function lion() {
    return `<path d="M26,54 C12,50 12,32 24,28 L26,34 C18,37 18,47 28,49 Z" fill="${C.lion}"/>` +
      `<circle cx="24" cy="27" r="5" fill="${C.lionMane}"/>` +
      `<rect x="30" y="64" width="10" height="18" rx="5" fill="${C.lion}"/>` +
      `<rect x="54" y="64" width="10" height="18" rx="5" fill="${C.lion}"/>` +
      `<rect x="24" y="44" width="46" height="22" rx="11" fill="${C.lion}"/>` +
      `<circle cx="70" cy="44" r="21" fill="${C.lionMane}"/>` +
      `<circle cx="64" cy="30" r="5" fill="${C.lionLight}"/>` +
      `<circle cx="76" cy="42" r="14" fill="${C.lionLight}"/>` +
      `<ellipse cx="84" cy="48" rx="8" ry="6" fill="${C.lionCream}"/>` +
      `<circle cx="80" cy="38" r="2.6" fill="${C.ink}"/>`;
  }

  // see-no-evil monkey: what your own stock card looks like to you. Hands sit
  // above the eyes rather than over them, so the face still reads at 46px.
  function monkey() {
    return `<circle cx="18" cy="48" r="13" fill="${C.monkeyEar}"/>` +
      `<circle cx="18" cy="48" r="6" fill="${C.monkeyInner}"/>` +
      `<circle cx="82" cy="48" r="13" fill="${C.monkeyEar}"/>` +
      `<circle cx="82" cy="48" r="6" fill="${C.monkeyInner}"/>` +
      `<path d="M34,50 L48,58 L34,94 L20,88 Z" fill="${C.monkeyDark}"/>` +
      `<path d="M66,50 L52,58 L66,94 L80,88 Z" fill="${C.monkeyDark}"/>` +
      `<circle cx="50" cy="50" r="30" fill="${C.monkey}"/>` +
      `<path d="M50,20 A30,30 0 0 1 50,80 Z" fill="${C.monkeyDark}"/>` +
      `<ellipse cx="50" cy="64" rx="20" ry="16" fill="${C.monkeyFace}"/>` +
      `<circle cx="42" cy="62" r="3.2" fill="${C.ink}"/>` +
      `<circle cx="58" cy="62" r="3.2" fill="${C.ink}"/>` +
      `<path d="M40,70 A10,10 0 0 0 60,70 Z" fill="${C.monkeyMouth}"/>` +
      `<rect x="22" y="36" width="28" height="22" rx="9" fill="${C.monkeyHand}"/>` +
      `<rect x="50" y="36" width="28" height="22" rx="9" fill="${C.monkeyHandDark}"/>` +
      `<rect x="30" y="42" width="14" height="2.4" rx="1.2" fill="${C.monkeyLine}"/>` +
      `<rect x="30" y="47.5" width="14" height="2.4" rx="1.2" fill="${C.monkeyLine}"/>` +
      `<rect x="56" y="42" width="14" height="2.4" rx="1.2" fill="${C.monkeyLine}"/>` +
      `<rect x="56" y="47.5" width="14" height="2.4" rx="1.2" fill="${C.monkeyLine}"/>`;
  }

  // the manager's bell: one flat shape split down the middle, lit side yellow
  // and shadow side orange — the same two-tone trick as the reference art
  function bell() {
    // the loop sits high enough that its hole clears the dome (which starts at
    // y=28) — tucked any lower and it reads as a nub rather than a handle
    return `<path d="M43,32 v-9 a7,7 0 0 1 7,-7 v4 a3,3 0 0 0 -3,3 v9 z" fill="${C.bell}"/>` +
      `<path d="M57,32 v-9 a7,7 0 0 0 -7,-7 v4 a3,3 0 0 1 3,3 v9 z" fill="${C.bellOrange}"/>` +
      `<path d="M26,68 C26,42 34,28 50,28 C66,28 74,42 74,68 Z" fill="${C.bell}"/>` +
      `<rect x="20" y="66" width="60" height="12" rx="6" fill="${C.bell}"/>` +
      `<path d="M50,28 C66,28 74,42 74,68 L50,68 Z" fill="${C.bellOrange}"/>` +
      `<path d="M50,66 H74 a6,6 0 0 1 0,12 H50 Z" fill="${C.bellOrange}"/>` +
      `<path d="M50,42 C62,42 66,54 66,68 L50,68 Z" fill="${C.bellShade}"/>` +
      `<path d="M50,77 A8,8 0 0 0 50,93 Z" fill="${C.bellClap}"/>` +
      `<path d="M50,77 A8,8 0 0 1 50,93 Z" fill="${C.bellClapDark}"/>`;
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
    else if (animal === "zebra") inner = zebra();
    else if (animal === "crocodile") inner = crocodile();
    else if (animal === "lion") inner = lion();
    else if (animal === "bell") inner = bell();
    else if (animal === "monkey") inner = monkey();
    else if (animal === "hippo") inner = hippo(variant);
    else inner = back();
    return svgOpen(s) + inner + `</svg>`;
  }

  function icon(animal, count, size) {
    // dominant colour per species for at-a-glance counting
    const dom = {
      toucan: C.toucan, zebra: C.zebra, crocodile: C.croc,
      lion: C.lion, hippo: C.hippo,
    }[animal] || "#888";
    let out = `<span class="anicons" style="--c:${dom}">`;
    for (let i = 0; i < count; i++) out += shape(animal, size || 26);
    return out + `</span>`;
  }

  window.AnimalArt = { shape, icon, C };
})();
