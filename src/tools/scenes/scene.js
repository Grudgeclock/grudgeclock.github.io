// Shared scene behaviour.
//
// Receipts are captured from the app with their navy frame (14 px) and torn edges (17 teeth, 8 px
// deep) on a 340 px wide card. tornClip() cuts along the paper's outline so the receipt floats with
// real transparent torn edges. Mark an element with class "receipt" and data-h="<card height in px>".
function tornClip(cardHeight) {
  const W = 340, F = 14, T = 8, TEETH = 17, w = (W - 2 * F) / TEETH;
  const px = (x, y) => `${((x / W) * 100).toFixed(3)}% ${((y / cardHeight) * 100).toFixed(3)}%`;
  const top = [], bottom = [];
  for (let i = 0; i <= TEETH; i++) {
    top.push(px(F + i * w, F));
    if (i < TEETH) top.push(px(F + (i + 0.5) * w, F + T));
  }
  for (let i = TEETH; i >= 0; i--) {
    bottom.push(px(F + i * w, cardHeight - F));
    if (i > 0) bottom.push(px(F + (i - 0.5) * w, cardHeight - F - T));
  }
  return `polygon(${[...top, ...bottom].join(', ')})`;
}

for (const el of document.querySelectorAll('.receipt[data-h]')) {
  el.querySelector('img').style.clipPath = tornClip(Number(el.dataset.h));
}

const params = new URLSearchParams(location.search);
