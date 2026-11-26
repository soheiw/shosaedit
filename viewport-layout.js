// Pinch zoom changes the visible viewport without changing CSS media queries.
// Keep the controls inside that visible area instead of the layout viewport.
const viewport = window.visualViewport;
function updateVisibleLayout() {
  const width = Math.min(window.innerWidth, viewport?.width ?? window.innerWidth);
  document.documentElement.style.setProperty('--visible-width', `${width}px`);
}
updateVisibleLayout();
window.addEventListener('resize', updateVisibleLayout);
viewport?.addEventListener('resize', updateVisibleLayout);
